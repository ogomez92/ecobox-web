import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	AUTH_COOKIE,
	authCookieOptions,
	authEnabled,
	expectedToken,
	passwordMatches
} from '$server/auth';

/**
 * POST /api/auth
 * Body: { password: string }
 *
 * Browser login. On a correct password, sets the persistent `ecobox_auth`
 * cookie so the browser is not asked again. The iOS app does NOT use this
 * endpoint — it sends the password via Basic auth on every request instead.
 */
export const POST: RequestHandler = async ({ request, cookies, url }) => {
	// No password configured → nothing to log into.
	if (!authEnabled()) return json({ ok: true });

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
		throw error(401, 'Invalid password');
	}

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
