import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import { AUTH_COOKIE, authEnabled, isAuthenticated } from '$server/auth';

/**
 * Paths reachable WITHOUT the app password — the login page itself, the login
 * endpoint, the client bundle that renders the login page, and the favicon.
 * Everything else is gated when `APP_PASSWORD` is set.
 */
function isPublicPath(path: string): boolean {
	return (
		path === '/login' ||
		path === '/api/auth' ||
		path.startsWith('/_app/') ||
		path === '/favicon.png' ||
		path === '/favicon.ico' ||
		path === '/manifest.json'
	);
}

export const handle: Handle = async ({ event, resolve }) => {
	const path = event.url.pathname;

	// --- App password gate -------------------------------------------------
	// Enforced only when APP_PASSWORD is configured. Browsers authenticate with
	// the persistent `ecobox_auth` cookie; the iOS app sends the password via
	// Basic auth on every request.
	if (authEnabled() && !isPublicPath(path)) {
		const token = event.cookies.get(AUTH_COOKIE);
		if (!isAuthenticated(event.request, token)) {
			if (path.startsWith('/api/')) {
				return new Response(JSON.stringify({ error: 'Unauthorized' }), {
					status: 401,
					headers: { 'content-type': 'application/json', 'cache-control': 'no-store' }
				});
			}
			// Browser: bounce to the login page, remembering the intended destination.
			const dest = new URL('/login', event.url);
			if (path !== '/') dest.searchParams.set('redirect', path + event.url.search);
			return new Response(null, {
				status: 302,
				headers: { Location: dest.pathname + dest.search }
			});
		}
	}

	// Check for unlock key in query params
	const key = event.url.searchParams.get('key');

	if (key && key === env.PROTECT_KEYWORD) {
		// Set session cookie (no maxAge = expires when browser closes)
		event.cookies.set('unlocked', key, {
			path: '/',
			httpOnly: true,
			secure: event.url.protocol === 'https:',
			sameSite: 'strict'
			// No maxAge = session cookie
		});

		// Redirect to remove key from URL
		const redirectUrl = new URL(event.url);
		redirectUrl.searchParams.delete('key');
		return new Response(null, {
			status: 302,
			headers: {
				Location: redirectUrl.pathname + redirectUrl.search
			}
		});
	}

	const response = await resolve(event);

	// Immutable assets (hashed filenames) - cache forever
	if (path.startsWith('/_app/immutable/')) {
		response.headers.set('Cache-Control', 'public, max-age=31536000, immutable');
		return response;
	}

	// Media API handles its own caching - don't interfere
	if (path.startsWith('/api/media/')) {
		return response;
	}

	// Other API endpoints - no caching to ensure fresh data
	if (path.startsWith('/api/')) {
		response.headers.set('Cache-Control', 'no-store');
		return response;
	}

	// HTML pages - must revalidate to get fresh JS references
	const contentType = response.headers.get('content-type') || '';
	if (contentType.includes('text/html')) {
		response.headers.set('Cache-Control', 'no-cache');
	}

	return response;
};
