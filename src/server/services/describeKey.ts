/**
 * The Gemini API key used by the video description feature.
 *
 * Two sources, in this order:
 *  1. the `ai_credentials` row the user saved through the key dialog,
 *  2. `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) from the environment — `.env` here,
 *     systemd's `EnvironmentFile=` — so a deploy can ship a working key with no
 *     UI step.
 *
 * The key is read *only* on the server. `/api/describe/key` returns whether one
 * exists and where it came from — never the key itself — the same contract the
 * TTS credentials follow.
 */
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { DescribeKeyStatus } from '$lib/types';

const PROVIDER = 'google';

/** Google API keys are `AIza` + 35 URL-safe characters; anything else is a paste error. */
export function looksLikeGeminiKey(key: string): boolean {
	return /^AIza[A-Za-z0-9_-]{30,}$/.test(key.trim());
}

function storedKey(): string {
	try {
		const rows = db
			.select()
			.from(schema.aiCredentials)
			.where(eq(schema.aiCredentials.provider, PROVIDER))
			.all();
		return (rows[0]?.apiKey ?? '').trim();
	} catch (err) {
		console.error('Gemini key read failed:', err);
		return '';
	}
}

function environmentKey(): string {
	return (env.GEMINI_API_KEY ?? env.GOOGLE_API_KEY ?? '').trim();
}

/** The key to authenticate with, or '' when none is configured. */
export function resolveDescribeKey(): string {
	return storedKey() || environmentKey();
}

/** Whether a key exists and which source won — safe to send to the client. */
export function describeKeyStatus(): DescribeKeyStatus {
	if (storedKey()) return { configured: true, source: 'stored' };
	if (environmentKey()) return { configured: true, source: 'env' };
	return { configured: false, source: null };
}

/** Save (or replace) the stored key. It takes precedence over the environment. */
export function saveDescribeKey(key: string): void {
	db.insert(schema.aiCredentials)
		.values({ provider: PROVIDER, apiKey: key.trim(), updatedAt: new Date() })
		.onConflictDoUpdate({
			target: schema.aiCredentials.provider,
			set: { apiKey: key.trim(), updatedAt: new Date() }
		})
		.run();
}

/** Drop the stored key. An environment key, if any, becomes active again. */
export function clearDescribeKey(): void {
	db.delete(schema.aiCredentials).where(eq(schema.aiCredentials.provider, PROVIDER)).run();
}
