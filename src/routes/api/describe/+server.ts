import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { describeVideoSegment } from '$server/services/videoDescribe';
import { isPathHidden } from '$server/services/protection';
import type { DescribeErrorCode, DescribeResult } from '$lib/types';

/**
 * v1 describes synchronously — the client is a user waiting for a sentence, not a
 * batch job. This indirection is the seam where a long segment could later be
 * handed to a queue and answered with a job id.
 */
async function dispatchDescribe(...args: Parameters<typeof describeVideoSegment>) {
	return describeVideoSegment(...args);
}

/**
 * An honest HTTP status for each failure, while the body always carries the code.
 * Clients must read the body either way: a 402 and a 429 are both "no description
 * this time", and only the code says what the user should do about it.
 */
function statusFor(code: DescribeErrorCode): number {
	switch (code) {
		case 'badRange':
		case 'tooLong':
		case 'notVideo':
		case 'noVideoStream':
			return 400;
		case 'badModel':
			return 404;
		case 'noKey':
		case 'badKey':
			return 401;
		case 'quota':
			return 402;
		case 'notFound':
			return 404;
		case 'rateLimited':
			return 429;
		case 'timeout':
			return 504;
		default:
			return 502;
	}
}

/**
 * POST /api/describe — describe what happens on screen between two marks.
 * Body: `{ path, start, end, language? }` → `DescribeResult`.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	let body: { path?: unknown; start?: unknown; end?: unknown; language?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const relPath = body.path;
	if (!relPath || typeof relPath !== 'string') {
		throw error(400, 'Path is required');
	}
	if (typeof body.start !== 'number' || typeof body.end !== 'number') {
		return json({ ok: false, code: 'badRange' } satisfies DescribeResult, { status: 400 });
	}

	// Protected content stays invisible to a locked session, reads included.
	if (await isPathHidden(relPath, cookies)) {
		throw error(404, 'File not found');
	}

	try {
		const result = await dispatchDescribe({
			path: relPath,
			start: body.start,
			end: body.end,
			language: typeof body.language === 'string' ? body.language : undefined
		});
		return json(result, { status: result.ok ? 200 : statusFor(result.code) });
	} catch (err) {
		const msg = err instanceof Error ? err.message : 'Description error';
		if (msg.includes('traversal')) {
			throw error(403, 'Forbidden');
		}
		console.error('Video description error:', err);
		return json({ ok: false, code: 'server' } satisfies DescribeResult, { status: 500 });
	}
};
