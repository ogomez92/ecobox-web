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

	return resolve(event);
};
