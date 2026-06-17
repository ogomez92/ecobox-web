import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { cleanupOrphanedRecords } from '$server/services/dbCleanup';

/**
 * POST → prune DB rows (playback positions, bookmarks, favorites) whose media path
 * no longer exists on disk. Returns a {@link CleanupSummary} with per-table counts.
 */
export const POST: RequestHandler = async () => {
	try {
		const summary = await cleanupOrphanedRecords();
		return json(summary);
	} catch (err) {
		console.error('DB cleanup error:', err);
		throw error(500, 'Failed to clean up database');
	}
};
