import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDeletions } from '$server/services/deletionHistory';

/**
 * GET /api/deletions
 * Returns the file deletion history, newest first (capped at the most recent 1000).
 */
export const GET: RequestHandler = async () => {
	try {
		const deletions = await listDeletions();
		return json({ deletions });
	} catch (err) {
		console.error('Deletions GET error:', err);
		throw error(500, 'Failed to load deletion history');
	}
};
