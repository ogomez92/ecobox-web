import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getQuota, TtsError } from '$server/services/tts';
import { TTS_AUDIO_SERVICES, type TtsAudioService } from '$lib/types';

function isAudioService(s: unknown): s is TtsAudioService {
	return typeof s === 'string' && (TTS_AUDIO_SERVICES as string[]).includes(s);
}

// Short-lived cache: the subscription endpoint rate-limits and the count only
// moves as the user reads, so a few seconds of staleness is fine — and it lets
// the reader spam `t` without hammering the provider.
const cache = new Map<string, { at: number; payload: unknown }>();
const TTL = 15 * 1000;

/**
 * GET ?service= → TtsQuota for services with a usable usage endpoint (ElevenLabs),
 * or { supported: false } for services that don't expose one. The reader uses this
 * to announce "characters remaining" when `t` is pressed.
 */
export const GET: RequestHandler = async ({ url }) => {
	const service = url.searchParams.get('service');
	if (!isAudioService(service)) {
		return json({ error: 'Invalid service' }, { status: 400 });
	}

	const hit = cache.get(service);
	if (hit && Date.now() - hit.at < TTL) {
		return json(hit.payload);
	}

	try {
		const quota = await getQuota(service);
		const payload = quota ?? { supported: false };
		cache.set(service, { at: Date.now(), payload });
		return json(payload);
	} catch (err) {
		const status = err instanceof TtsError ? err.status : 502;
		const message = err instanceof Error ? err.message : 'Failed to fetch quota';
		return json({ error: message }, { status });
	}
};
