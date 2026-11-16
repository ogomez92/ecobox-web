import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	startAudiobook,
	cancelAudiobook,
	getAudiobookStatus
} from '$server/services/audiobookExport';
import { isPathHidden } from '$server/services/protection';
import { audiobookErrorResponse } from './errors';

/**
 * "Convert to audio" for a converted book (see audiobookExport.ts).
 *
 * GET ?path=            → `{status: AudiobookJobStatus | null}` (null = no export known)
 * POST {path, service, rate?, fromPosition?, action?: 'start' | 'cancel'}
 *                       → `{status}`; errors are `{error: AudiobookErrorCode, detail}`.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const path = url.searchParams.get('path') ?? '';
	if (!path || (await isPathHidden(path, cookies))) return json({ status: null });
	return json({ status: getAudiobookStatus(path) });
};

export const POST: RequestHandler = async ({ request, cookies }) => {
	let body: { path?: unknown; service?: unknown; fromPosition?: unknown; rate?: unknown; action?: unknown };
	try {
		body = await request.json();
	} catch {
		return json({ error: 'unknown', detail: 'Invalid JSON body' }, { status: 400 });
	}
	const path = typeof body.path === 'string' ? body.path : '';
	if (!path || (await isPathHidden(path, cookies))) {
		return json({ error: 'notBook', detail: null }, { status: 404 });
	}

	if (body.action === 'cancel') {
		return json({ status: cancelAudiobook(path) });
	}
	try {
		const status = await startAudiobook(path, body.service, body.fromPosition === true, body.rate);
		return json({ status });
	} catch (err) {
		return audiobookErrorResponse(err, 'Audiobook export start error');
	}
};
