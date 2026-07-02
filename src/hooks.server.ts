import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';
import {
	AUTH_COOKIE,
	authEnabled,
	isAuthenticated,
	passwordFromBasicAuth
} from '$server/auth';
import { clientKey, recordFailure, recordSuccess, retryAfter } from '$server/rateLimit';

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

/** 429 for a locked-out password guesser, with a standard `Retry-After`. */
function tooManyAttempts(retryAfterSec: number): Response {
	return new Response(JSON.stringify({ error: 'Too many attempts. Try again later.' }), {
		status: 429,
		headers: {
			'content-type': 'application/json',
			'cache-control': 'no-store',
			'retry-after': String(retryAfterSec)
		}
	});
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
			// Brute-force throttle. Only a *presented password* counts as a guess —
			// a Basic-auth password that turned out wrong. A missing header or a
			// stale/invalid cookie is not a guess (cookie tokens aren't guessable),
			// so logged-out browsers and post-rotation stale cookies are unaffected.
			const guess = passwordFromBasicAuth(event.request.headers.get('authorization'));
			if (guess != null) {
				const key = clientKey(event.request, event.getClientAddress);
				const wait = retryAfter(key);
				if (wait > 0) return tooManyAttempts(wait);
				recordFailure(key);
			}
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
		} else if (event.request.headers.get('authorization')) {
			// A correct Basic-auth password clears any prior failures for this IP
			// (e.g. the iOS app after the user fixes a mistyped password).
			recordSuccess(clientKey(event.request, event.getClientAddress));
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
