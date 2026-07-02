import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { convertBook } from '$server/services/bookConvert';

/**
 * v1: convert synchronously. This indirection is the seam where v2 can branch the
 * '.pdf' (OCR) path to a background job and return `{ status: 'queued' }` instead.
 */
async function dispatchConvert(relPath: string) {
	return convertBook(relPath);
}

export const POST: RequestHandler = async ({ request }) => {
	let body: { path?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const rawPath = body.path;
	if (!rawPath || typeof rawPath !== 'string') {
		throw error(400, 'Path is required');
	}

	// No need to normalize here: convertBook canonicalizes the path against the real
	// on-disk name (handles NFC/NFD accent differences) before touching it.
	try {
		const result = await dispatchConvert(rawPath);
		return json(result);
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Conversion error';
		if (msg.includes('traversal')) {
			throw error(403, 'Forbidden');
		}
		console.error('Book convert error:', err);
		throw error(500, 'Failed to convert book');
	}
};
