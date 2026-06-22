import { env } from '$env/dynamic/private';
import { createHash, timingSafeEqual } from 'node:crypto';

/**
 * App-wide password gate.
 *
 * When `APP_PASSWORD` is set in the environment the whole server requires that
 * password. Two client shapes are supported:
 *
 *  - **Browser**: logs in once at `/login`, which sets a long-lived, httpOnly
 *    `ecobox_auth` cookie holding a hash of the password (never the password
 *    itself). The cookie is persistent (1 year) so the browser is not prompted
 *    every session.
 *  - **iOS app**: sends the password on every request inside the existing HTTP
 *    Basic `Authorization` header (the username component is ignored). The
 *    password lives in the iOS Keychain, so the user is never re-prompted.
 *
 * If `APP_PASSWORD` is empty/unset, auth is disabled (backwards compatible with
 * deployments that gate access some other way, e.g. a reverse proxy).
 */

export const AUTH_COOKIE = 'ecobox_auth';

/** True when an `APP_PASSWORD` is configured and the gate should be enforced. */
export function authEnabled(): boolean {
	return typeof env.APP_PASSWORD === 'string' && env.APP_PASSWORD.length > 0;
}

function tokenFor(password: string): string {
	// Versioned, salted hash so the cookie never carries the raw password and we
	// can rotate the scheme later without colliding with old cookies.
	return createHash('sha256').update(`ecobox-auth-v1:${password}`).digest('hex');
}

/** The cookie value a correctly-authenticated browser should be carrying. */
export function expectedToken(): string {
	return tokenFor(env.APP_PASSWORD ?? '');
}

function safeEqual(a: string, b: string): boolean {
	const ab = Buffer.from(a, 'utf8');
	const bb = Buffer.from(b, 'utf8');
	if (ab.length !== bb.length) return false;
	return timingSafeEqual(ab, bb);
}

/** Constant-time check of a candidate password against `APP_PASSWORD`. */
export function passwordMatches(candidate: string): boolean {
	if (!authEnabled()) return true;
	return safeEqual(candidate, env.APP_PASSWORD ?? '');
}

/** Pulls the password out of a `Basic` auth header, ignoring the username. */
export function passwordFromBasicAuth(header: string | null): string | null {
	if (!header || !header.startsWith('Basic ')) return null;
	try {
		const decoded = Buffer.from(header.slice('Basic '.length), 'base64').toString('utf8');
		const idx = decoded.indexOf(':');
		// Username is everything before the first colon; password is the rest.
		// A Basic-auth password may itself contain colons, so slice, don't split.
		return idx >= 0 ? decoded.slice(idx + 1) : decoded;
	} catch {
		return null;
	}
}

/**
 * Is this request allowed through the gate? Satisfied by either a valid cookie
 * (browser) or a matching Basic-auth password (iOS). Always true when the gate
 * is disabled.
 */
export function isAuthenticated(request: Request, cookieToken: string | undefined): boolean {
	if (!authEnabled()) return true;

	// 1. Persistent browser cookie.
	if (cookieToken && safeEqual(cookieToken, expectedToken())) return true;

	// 2. Per-request Basic auth (iOS app / curl).
	const pw = passwordFromBasicAuth(request.headers.get('authorization'));
	if (pw != null && passwordMatches(pw)) return true;

	return false;
}

/** Cookie options for the persistent browser session. */
export function authCookieOptions(secure: boolean) {
	return {
		path: '/',
		httpOnly: true,
		secure,
		sameSite: 'lax' as const,
		maxAge: 60 * 60 * 24 * 365 // 1 year — deliberately persistent.
	};
}
