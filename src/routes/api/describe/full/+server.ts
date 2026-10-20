import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	cancelFullDescription,
	deleteFullDescription,
	getFullDescription,
	startFullDescription
} from '$server/services/videoDescribeFull';
import { isPathHidden } from '$server/services/protection';
import type { DescribeErrorCode, DescribeFailure, FullDescribeStatus } from '$lib/types';

/** Same status mapping as `/api/describe`, so a client can treat the two alike. */
function statusFor(code: DescribeErrorCode): number {
	switch (code) {
		case 'badRange':
		case 'notVideo':
		case 'noVideoStream':
		case 'emptyClip':
			return 400;
		case 'noKey':
		case 'badKey':
			return 401;
		case 'quota':
			return 402;
		case 'notFound':
		case 'badModel':
			return 404;
		case 'rateLimited':
			return 429;
		case 'timeout':
			return 504;
		default:
			return 502;
	}
}

function traversalOr500(err: unknown): never {
	const msg = err instanceof Error ? err.message : '';
	if (msg.includes('traversal')) throw error(403, 'Forbidden');
	console.error('Full video description error:', err);
	throw error(500, 'Description error');
}

/**
 * GET /api/describe/full?path=… — the track so far and where the run stands.
 * Answers `{state:'idle'}` for a video that has never been described; never an
 * error for a missing track, because the player asks for every video it loads.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const relPath = url.searchParams.get('path');
	if (!relPath) throw error(400, 'Path is required');
	if (await isPathHidden(relPath, cookies)) throw error(404, 'File not found');
	try {
		return json((await getFullDescription(relPath)) satisfies FullDescribeStatus);
	} catch (err) {
		traversalOr500(err);
	}
};

/**
 * POST /api/describe/full — `{ path, language?, action?: 'start' | 'restart' | 'cancel' }`.
 * `start` (the default) begins a run, or resumes one that was paused or failed;
 * `restart` discards the stored track first; `cancel` stops a live run and keeps
 * what it has. Always answers with the resulting `FullDescribeStatus`, or a
 * `DescribeFailure` when a run could not begin.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	let body: { path?: unknown; language?: unknown; action?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}
	const relPath = body.path;
	if (!relPath || typeof relPath !== 'string') throw error(400, 'Path is required');
	if (await isPathHidden(relPath, cookies)) throw error(404, 'File not found');

	const action = body.action === 'cancel' || body.action === 'restart' ? body.action : 'start';
	try {
		if (action === 'cancel') return json(cancelFullDescription(relPath));
		const result = await startFullDescription({
			path: relPath,
			language: typeof body.language === 'string' ? body.language : 'en',
			restart: action === 'restart'
		});
		if (result.ok) return json(result.status);
		const failure: DescribeFailure = { ok: false, code: result.code, detail: result.detail };
		return json(failure, { status: statusFor(result.code) });
	} catch (err) {
		traversalOr500(err);
	}
};

/** DELETE /api/describe/full?path=… — forget the track (stopping a run first). */
export const DELETE: RequestHandler = async ({ url, cookies }) => {
	const relPath = url.searchParams.get('path');
	if (!relPath) throw error(400, 'Path is required');
	if (await isPathHidden(relPath, cookies)) throw error(404, 'File not found');
	try {
		await deleteFullDescription(relPath);
		return json({ ok: true });
	} catch (err) {
		traversalOr500(err);
	}
};
