import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cacheSizeBytes, clearCache } from '$server/services/tts/cache';

/** GET → { bytes } total size of the on-disk TTS audio cache. */
export const GET: RequestHandler = async () => {
	const bytes = await cacheSizeBytes();
	return json({ bytes });
};

/** DELETE → wipe the entire TTS audio cache. */
export const DELETE: RequestHandler = async () => {
	await clearCache();
	return json({ bytes: 0 });
};
