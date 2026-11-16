import type { RequestHandler } from './$types';
import { TtsError } from '$server/services/tts';
import { synthesizeCached } from '$server/services/tts/synthesizeCached';
import {
	TTS_AUDIO_SERVICES,
	type TtsAudioService,
	type ElevenVoiceSettings,
	type ElfVoiceParams
} from '$lib/types';

function isAudioService(s: unknown): s is TtsAudioService {
	return typeof s === 'string' && (TTS_AUDIO_SERVICES as string[]).includes(s);
}

const AUDIO_HEADERS = { 'Content-Type': 'audio/mpeg', 'Cache-Control': 'no-store' };

/**
 * POST { service, voiceId, text, lang, model?, previousText?, nextText?, bookPath? }
 * → audio/mpeg. Served from the on-disk cache when available; otherwise synthesized
 * and written to the cache (keyed by book + voice/model/text/context). The key
 * folding (ELF dictionary, per-service knobs, baked rate) lives in
 * synthesizeCached.ts, shared with the audiobook export.
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = (await request.json()) as {
		service?: string;
		voiceId?: string;
		text?: string;
		lang?: string;
		model?: string;
		voiceSettings?: ElevenVoiceSettings;
		elfParams?: ElfVoiceParams;
		rate?: number;
		previousText?: string;
		nextText?: string;
		bookPath?: string;
	};

	if (!isAudioService(body.service)) {
		return new Response('Invalid service', { status: 400 });
	}

	try {
		const { audio } = await synthesizeCached({
			service: body.service,
			voiceId: body.voiceId ?? '',
			text: body.text ?? '',
			lang: body.lang ?? 'en',
			model: body.model,
			voiceSettings: body.voiceSettings,
			elfParams: body.elfParams,
			rate: body.rate,
			previousText: body.previousText,
			nextText: body.nextText,
			bookPath: body.bookPath
		});
		return new Response(audio, { headers: AUDIO_HEADERS });
	} catch (err) {
		const status = err instanceof TtsError ? err.status : 502;
		const message = err instanceof Error ? err.message : 'Synthesis failed';
		return new Response(message, { status });
	}
};
