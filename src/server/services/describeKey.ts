/**
 * The Anthropic credentials used by the video description features.
 *
 * Two kinds, tried in this order:
 *  1. an **auth token** (`sk-ant-oat…`, sent as a bearer token) — from the
 *     `ai_credentials` row saved under `anthropic-token`, else `ANTHROPIC_AUTH_TOKEN`
 *     in the environment;
 *  2. an **API key** — the `anthropic` row the user saved through the key dialog,
 *     else `ANTHROPIC_API_KEY` from the environment (`.env` here, systemd's
 *     `EnvironmentFile=`), so a deploy can ship a working key with no UI step.
 *
 * `withDescribeClient()` is the one place a client is built: it runs the request
 * with the token first and, only if the API rejects that token (expired, revoked),
 * runs the same request again with the key. The dialog therefore asks for an API
 * key only when there is no token at all, or the token stopped working and there
 * is no key to fall back on.
 *
 * Credentials are read *only* on the server. `/api/describe/key` returns whether
 * one exists and where it came from — never the secret — the same contract the
 * TTS credentials follow.
 */
import Anthropic from '@anthropic-ai/sdk';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { DescribeKeyStatus } from '$lib/types';

const PROVIDER = 'anthropic';
const TOKEN_PROVIDER = 'anthropic-token';

/** OAuth access tokens are `sk-ant-oat…`; an API key is anything else that looks Anthropic. */
export function looksLikeAnthropicToken(value: string): boolean {
	return /^sk-ant-oat[A-Za-z0-9_-]{20,}$/.test(value.trim());
}

/** Anthropic keys are `sk-ant-` followed by a long URL-safe tail; anything else is a paste error. */
export function looksLikeAnthropicKey(key: string): boolean {
	return /^sk-ant-[A-Za-z0-9_-]{20,}$/.test(key.trim());
}

function storedSecret(provider: string): string {
	try {
		const rows = db
			.select()
			.from(schema.aiCredentials)
			.where(eq(schema.aiCredentials.provider, provider))
			.all();
		return (rows[0]?.apiKey ?? '').trim();
	} catch (err) {
		console.error('Anthropic credential read failed:', err);
		return '';
	}
}

function storedKey(): string {
	return storedSecret(PROVIDER);
}

function environmentKey(): string {
	return (env.ANTHROPIC_API_KEY ?? '').trim();
}

function storedToken(): string {
	return storedSecret(TOKEN_PROVIDER);
}

function environmentToken(): string {
	return (env.ANTHROPIC_AUTH_TOKEN ?? '').trim();
}

/** The API key to authenticate with, or '' when none is configured. */
export function resolveDescribeKey(): string {
	return storedKey() || environmentKey();
}

/** The auth token to authenticate with, or '' when none is configured. */
export function resolveDescribeToken(): string {
	return storedToken() || environmentToken();
}

/** Whether anything at all can authenticate a request. */
export function hasDescribeCredentials(): boolean {
	return Boolean(resolveDescribeToken() || resolveDescribeKey());
}

/** Whether a credential exists and which source won — safe to send to the client. */
export function describeKeyStatus(): DescribeKeyStatus {
	if (resolveDescribeToken()) return { configured: true, source: 'token' };
	if (storedKey()) return { configured: true, source: 'stored' };
	if (environmentKey()) return { configured: true, source: 'env' };
	return { configured: false, source: null };
}

/**
 * Save (or replace) a stored credential. A pasted `sk-ant-oat…` value is stored as
 * the token (tried first); anything else as the API key. Stored values take
 * precedence over the environment.
 */
export function saveDescribeKey(secret: string): void {
	const value = secret.trim();
	const provider = looksLikeAnthropicToken(value) ? TOKEN_PROVIDER : PROVIDER;
	db.insert(schema.aiCredentials)
		.values({ provider, apiKey: value, updatedAt: new Date() })
		.onConflictDoUpdate({
			target: schema.aiCredentials.provider,
			set: { apiKey: value, updatedAt: new Date() }
		})
		.run();
}

/** A failure that says "not with this credential" rather than "not this request". */
function credentialFailed(err: unknown): boolean {
	if (err instanceof Anthropic.AuthenticationError) return true;
	if (err instanceof Anthropic.PermissionDeniedError) return true;
	if (err instanceof Anthropic.RateLimitError) return true;
	if (err instanceof Anthropic.BadRequestError) return /credit|billing|balance/i.test(err.message);
	return false;
}

/** Which credential a request is being made with. */
export type DescribeAuthKind = 'token' | 'key';

/**
 * A token the API just called unusable is skipped for this long before being
 * tried again. Without it every chunk of a whole-video run would pay a round
 * trip to a dead token before reaching the key; with it, a token that comes back
 * (a new one saved, a quota window rolling over) is picked up within minutes.
 */
const TOKEN_COOLDOWN_MS = 10 * 60 * 1000;
let tokenCooldown: { token: string; until: number } | null = null;

function tokenOnCooldown(token: string): boolean {
	return tokenCooldown !== null && tokenCooldown.token === token && Date.now() < tokenCooldown.until;
}

/**
 * Run `fn` against an Anthropic client, token first, API key on a rejected token.
 *
 * What moves on to the next credential is a failure that belongs to the
 * credential, not to the request: rejected outright (401/403), rate-limited or
 * exhausted (429 — an OAuth token has its own quota, which the API reports as a
 * bare `rate_limit_error`), or out of credit (the 400 "credit balance" body). A
 * bad model, a malformed request or a refusal is the same whatever we sign
 * with, and retrying it would only double the wait. `fn` is told which
 * credential it has so it can add the `oauth-2025-04-20` beta a bearer token
 * needs. Each attempt gets a fresh client, since both secrets are chosen at call
 * time and a saved key must take effect without a restart.
 */
export async function withDescribeClient<T>(
	fn: (client: Anthropic, auth: DescribeAuthKind) => Promise<T>,
	clientOptions: { timeout?: number; maxRetries?: number } = {}
): Promise<T> {
	const attempts: { auth: DescribeAuthKind; options: { apiKey: string | null; authToken: string | null } }[] = [];
	const token = resolveDescribeToken();
	const key = resolveDescribeKey();
	// Both explicit, so a token or key in the process environment can never sneak
	// in beside the one being tried.
	if (token && (!key || !tokenOnCooldown(token))) {
		attempts.push({ auth: 'token', options: { apiKey: null, authToken: token } });
	}
	if (key) attempts.push({ auth: 'key', options: { apiKey: key, authToken: null } });
	if (attempts.length === 0) {
		throw new Anthropic.AuthenticationError(401, undefined, 'No Anthropic credentials configured', new Headers());
	}

	for (let i = 0; i < attempts.length; i++) {
		const { auth, options } = attempts[i];
		const client = new Anthropic({ ...options, ...clientOptions });
		try {
			return await fn(client, auth);
		} catch (err) {
			if (credentialFailed(err) && i < attempts.length - 1) {
				const status = err instanceof Anthropic.APIError ? err.status : '?';
				console.warn(`Anthropic ${auth} unusable (${status}); trying the next credential`);
				if (auth === 'token') tokenCooldown = { token: token, until: Date.now() + TOKEN_COOLDOWN_MS };
				continue;
			}
			throw err;
		}
	}
	throw new Error('unreachable');
}

/** Drop the stored key and token. Environment credentials, if any, become active again. */
export function clearDescribeKey(): void {
	db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.provider, PROVIDER)).run();
	db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.provider, TOKEN_PROVIDER)).run();
}
