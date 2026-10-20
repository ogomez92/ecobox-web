import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDirectory } from '$server/services/files';
import { getDurations } from '$server/services/audioDuration';
import { getProtectedSet, isPathProtected, isUnlocked } from '$server/services/protection';
import { isPlayableMedia } from '$lib/utils/mediaTypes';

/**
 * GET /api/files/durations?path=<folder>
 *
 * Durations (seconds) of the playable files *directly* in one folder — never its
 * subfolders — computed where the cache is cold and cached for next time. This is
 * the on-demand half of the "sort by duration" feature: the listing itself only
 * carries durations already cached, and the client calls this when it needs the
 * rest. A file that can't be parsed answers 0, so a bad file never fails the sort.
 *
 * Cost is per uncached file: a header parse (a few positional reads) for MP3s with
 * a Xing header and MP4s, a full scan for VBR MP3s without one. Six in parallel.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const path = url.searchParams.get('path') || '';

	const unlocked = isUnlocked(cookies);
	const protectedSet = await getProtectedSet();
	if (!unlocked && path && isPathProtected(path, protectedSet)) {
		throw error(404, 'Directory not found');
	}

	try {
		let files = await listDirectory(path);
		files = files.filter((f) => !f.isDirectory && isPlayableMedia(f.name));
		if (!unlocked) {
			files = files.filter((f) => !isPathProtected(f.path, protectedSet));
		}

		const durations = await getDurations(files.map((f) => f.path));
		return json({ durations: Object.fromEntries(durations) });
	} catch (err) {
		if ((err as Error).message === 'Directory not found') {
			throw error(404, 'Directory not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		console.error('Failed to read durations:', err);
		throw error(500, 'Failed to read durations');
	}
};
