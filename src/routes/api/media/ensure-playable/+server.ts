import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { ensureVideoPlayable } from '$server/services/videoConvert';
import { isPathHidden } from '$server/services/protection';

/**
 * v1 repairs synchronously, exactly like book conversion and audio extraction.
 * This indirection is the seam where a long transcode can later be handed to a
 * background job and answered with `{ action: 'queued' }`.
 */
async function dispatchEnsure(relPath: string) {
	return ensureVideoPlayable(relPath);
}

/**
 * POST /api/media/ensure-playable — make an uploaded video actually play.
 * Body: `{ path }` → `EnsurePlayableResult`.
 *
 * Distinct from `/api/media/extract-audio`, which is the user asking for an audio
 * file and accepting that the video goes. This one is the automatic post-upload
 * check, and it does the least it can get away with: usually nothing, sometimes an
 * in-place audio rewrite, and only for containers no browser opens does it fall
 * back to extraction. Answering `{ action: 'skipped' }` is the common case and is
 * a success, not a no-op to be retried.
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
		return json(await dispatchEnsure(rawPath));
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Conversion error';
		if (msg.includes('traversal')) {
			throw error(403, 'Forbidden');
		}
		console.error('Video playability repair error:', err);
		throw error(500, 'Failed to convert video');
	}
};
