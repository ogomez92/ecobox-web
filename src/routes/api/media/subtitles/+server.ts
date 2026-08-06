import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getSubtitles } from '$server/services/subtitles';

/**
 * Sidecar subtitles for a media file: `GET /api/media/subtitles?path=…`.
 *
 * Answers `{ available: false, cues: [] }` — never an error — when the file has
 * no sibling .srt, which is the common case: the player asks for every file it
 * loads and simply shows nothing when there's no track.
 */
export const GET: RequestHandler = async ({ url }) => {
	const filePath = url.searchParams.get('path');

	if (!filePath) {
		throw error(400, 'Path is required');
	}

	try {
		const track = await getSubtitles(filePath);
		if (!track) {
			return json({ available: false, cues: [] });
		}

		return json({ available: true, path: track.path, cues: track.cues });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			// The .srt vanished between listing and reading — treat as "no subtitles".
			return json({ available: false, cues: [] });
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		console.error('Subtitle read error:', err);
		throw error(500, 'Failed to read subtitles');
	}
};
