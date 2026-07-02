import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	AUTH_COOKIE,
	authCookieOptions,
	authEnabled,
	expectedToken,
	passwordMatches
} from '$server/auth';
import { clientKey, recordFailure, recordSuccess, retryAfter } from '$server/rateLimit';

/**
 * POST /api/auth
 * Body: { password: string }
 *
 * Browser login. On a correct password, sets the persistent `ecobox_auth`
 * cookie so the browser is not asked again. The iOS app does NOT use this
 * endpoint — it sends the password via Basic auth on every request instead.
 */
export const POST: RequestHandler = async ({ request, cookies, url, getClientAddress }) => {
	// No password configured → nothing to log into.
	if (!authEnabled()) return json({ ok: true });

	// Brute-force throttle: reject while locked out, before evaluating the guess.
	const key = clientKey(request, getClientAddress);
	const wait = retryAfter(key);
	if (wait > 0) {
		return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), {
			status: 429,
			headers: { 'content-type': 'application/json', 'retry-after': String(wait) }
		});
	}

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const password = (body as { password?: unknown })?.password;
	if (typeof password !== 'string' || password.length === 0) {
		throw error(400, 'Password is required');
	}

	if (!passwordMatches(password)) {
		recordFailure(key);
		throw error(401, 'Invalid password');
	}

	recordSuccess(key);
	cookies.set(AUTH_COOKIE, expectedToken(), authCookieOptions(url.protocol === 'https:'));
	return json({ ok: true });
};

/**
 * DELETE /api/auth
 * Logs out by clearing the persistent cookie.
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	cookies.delete(AUTH_COOKIE, { path: '/' });
	return json({ ok: true });
};
