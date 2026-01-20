import type { Handle } from '@sveltejs/kit';
import { env } from '$env/dynamic/private';

export const handle: Handle = async ({ event, resolve }) => {
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
	const path = event.url.pathname;

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
