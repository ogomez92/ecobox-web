import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { env } from '$env/dynamic/private';

/**
 * POST /api/unlock
 * Body: { key: string }
 *
 * Mirrors the existing `?key=` query-param hook (src/hooks.server.ts) but as a
 * proper JSON endpoint for non-browser clients (e.g. the iOS app) that don't
 * want to follow the 302 redirect dance.
 *
 * Sets the same `unlocked` session cookie on success; returns 401 on a wrong key.
 */
export const POST: RequestHandler = async ({ request, cookies, url }) => {
	let body: unknown;
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const key = (body as { key?: unknown })?.key;
	if (typeof key !== 'string' || key.length === 0) {
		throw error(400, 'Key is required');
	}

	if (key !== env.PROTECT_KEYWORD) {
		throw error(401, 'Invalid key');
	}

	cookies.set('unlocked', key, {
		path: '/',
		httpOnly: true,
		secure: url.protocol === 'https:',
		sameSite: 'strict'
		// No maxAge → session cookie, discarded when client process ends.
	});

	return json({ unlocked: true });
};

/**
 * DELETE /api/unlock
 * Clears the `unlocked` cookie. Useful for explicit "Bloquear" actions in clients.
 */
export const DELETE: RequestHandler = async ({ cookies }) => {
	cookies.delete('unlocked', { path: '/' });
	return json({ unlocked: false });
};
