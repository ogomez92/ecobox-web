import { json } from '@sveltejs/kit';
import { AudiobookError } from '$server/services/audiobookExport';
import type { AudiobookErrorCode } from '$lib/types';

const STATUS: Record<AudiobookErrorCode, number> = {
	clientOnly: 400,
	notBook: 404,
	empty: 422,
	noVoice: 422,
	quotaExceeded: 402,
	badKey: 401,
	misconfigured: 400,
	unreachable: 503,
	upstream: 502,
	ffmpeg: 500,
	write: 500,
	busy: 409,
	unknown: 500
};

/**
 * Every failure answers `{error: code, detail}` — a code the client localizes,
 * never a sentence — with a matching HTTP status.
 */
export function audiobookErrorResponse(err: unknown, context: string): Response {
	if (err instanceof AudiobookError) {
		return json({ error: err.code, detail: err.detail }, { status: STATUS[err.code] });
	}
	if (err instanceof Error && err.message.includes('traversal')) {
		return json({ error: 'notBook', detail: null }, { status: 403 });
	}
	console.error(`${context}:`, err);
	return json({ error: 'unknown', detail: err instanceof Error ? err.message : null }, { status: 500 });
}
