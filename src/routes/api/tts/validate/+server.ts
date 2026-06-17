import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { validateService } from '$server/services/tts';
import { TTS_AUDIO_SERVICES, type TtsAudioService } from '$lib/types';

function isAudioService(s: unknown): s is TtsAudioService {
	return typeof s === 'string' && (TTS_AUDIO_SERVICES as string[]).includes(s);
}

/** POST { service } → { ok, message, voiceCount? }. Confirms a key without exposing it. */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as { service?: string };
	if (!isAudioService(body.service)) {
		return json({ ok: false, message: 'Invalid service' }, { status: 400 });
	}
	const result = await validateService(body.service);
	return json(result);
};
