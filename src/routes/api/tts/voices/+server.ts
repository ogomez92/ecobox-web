import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listVoices, TtsError } from '$server/services/tts';
import { TTS_AUDIO_SERVICES, type TtsAudioService } from '$lib/types';

function isAudioService(s: unknown): s is TtsAudioService {
	return typeof s === 'string' && (TTS_AUDIO_SERVICES as string[]).includes(s);
}

// Short-lived in-memory cache; voice lists are stable and some providers rate-limit.
const cache = new Map<string, { at: number; voices: unknown[] }>();
const TTL = 5 * 60 * 1000;

/** GET ?service=&lang= → TtsVoice[]. */
export const GET: RequestHandler = async ({ url }) => {
	const service = url.searchParams.get('service');
	const lang = url.searchParams.get('lang') ?? '';
	if (!isAudioService(service)) {
		return json({ error: 'Invalid service' }, { status: 400 });
	}

	const key = `${service}:${lang}`;
	const hit = cache.get(key);
	if (hit && Date.now() - hit.at < TTL) {
		return json(hit.voices);
	}

	try {
		const voices = await listVoices(service, lang);
		cache.set(key, { at: Date.now(), voices });
		return json(voices);
	} catch (err) {
		const status = err instanceof TtsError ? err.status : 502;
		const message = err instanceof Error ? err.message : 'Failed to list voices';
		return json({ error: message }, { status });
	}
};
