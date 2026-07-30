import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { searchDirectory } from '$server/services/files';

const MAX_RESULTS = 200;

/**
 * GET /api/search?path=<folder>&q=<name>[&limit=<n>]
 *
 * Name search scoped to `path` and everything below it — never upward. Returns
 * `{ results, total }`; `results` is capped (default 200) so a broad query on a
 * large library stays a small response, while `total` still reports the real
 * count so the UI can say "showing the first N of M".
 */
export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path') || '';
	const q = url.searchParams.get('q') || '';
	const limitParam = parseInt(url.searchParams.get('limit') || '', 10);
	const limit = Number.isFinite(limitParam)
		? Math.min(Math.max(limitParam, 1), MAX_RESULTS)
		: MAX_RESULTS;

	if (!q.trim()) {
		return json({ results: [], total: 0 });
	}

	try {
		return json(await searchDirectory(path, q, limit));
	} catch (err) {
		const message = (err as Error).message;
		if (message === 'Directory not found') {
			throw error(404, 'Directory not found');
		}
		if (message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Search failed');
	}
};
