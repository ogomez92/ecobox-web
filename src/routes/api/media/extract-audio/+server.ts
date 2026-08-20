import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { extractVideoAudio } from '$server/services/videoConvert';
import { isPathHidden } from '$server/services/protection';

/**
 * v1: extract synchronously, exactly like book conversion. This indirection is
 * the seam where a long transcode can later be handed to a background job and
 * answered with `{ status: 'queued' }`.
 */
async function dispatchExtract(relPath: string) {
	return extractVideoAudio(relPath);
}

/**
 * POST /api/media/extract-audio — turn a video into a sibling audio file.
 * Body: `{ path }`. On success the video is deleted and any text subtitle tracks
 * it carried are written out as sidecar .srt files.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
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

	// Protected content stays invisible to a locked session — including for writes.
	if (await isPathHidden(rawPath, cookies)) {
		throw error(404, 'File not found');
	}

	try {
		return json(await dispatchExtract(rawPath));
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Extraction error';
		if (msg.includes('traversal')) {
			throw error(403, 'Forbidden');
		}
		console.error('Audio extraction error:', err);
		throw error(500, 'Failed to extract audio');
	}
};
