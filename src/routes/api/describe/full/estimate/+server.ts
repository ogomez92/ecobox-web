import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { estimateFullDescription } from '$server/services/videoDescribeFull';
import { isPathHidden } from '$server/services/protection';
import type { DescribeFailure } from '$lib/types';

/**
 * GET /api/describe/full/estimate?path=…&language=… — chunks, frames, tokens and
 * an approximate price for describing the whole video, for the confirmation
 * dialog. Never starts anything; the one paid-for-looking step, token counting,
 * is free.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const relPath = url.searchParams.get('path');
	if (!relPath) throw error(400, 'Path is required');
	if (await isPathHidden(relPath, cookies)) throw error(404, 'File not found');
	try {
		const result = await estimateFullDescription({
			path: relPath,
			language: url.searchParams.get('language') ?? 'en'
		});
		if (result.ok) return json(result.estimate);
		const failure: DescribeFailure = { ok: false, code: result.code, detail: result.detail };
		return json(failure, { status: result.code === 'notFound' ? 404 : 400 });
	} catch (err) {
		const msg = err instanceof Error ? err.message : '';
		if (msg.includes('traversal')) throw error(403, 'Forbidden');
		console.error('Description estimate error:', err);
		throw error(500, 'Estimate error');
	}
};
