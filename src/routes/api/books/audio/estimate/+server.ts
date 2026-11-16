import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { estimateAudiobook } from '$server/services/audiobookExport';
import { isPathHidden } from '$server/services/protection';
import { audiobookErrorResponse } from '../errors';

/**
 * GET ?path=&service=&rate= → AudiobookEstimate: characters for the whole book and from
 * the saved position, how many of them still have to be synthesized (the rest is
 * cached), the voice, and the provider quota when it has one.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const path = url.searchParams.get('path') ?? '';
	if (!path || (await isPathHidden(path, cookies))) {
		return json({ error: 'notBook', detail: null }, { status: 404 });
	}
	try {
		return json(await estimateAudiobook(path, url.searchParams.get('service'), url.searchParams.get('rate')));
	} catch (err) {
		return audiobookErrorResponse(err, 'Audiobook estimate error');
	}
};
