import type { RequestHandler } from './$types';
import { synthesize, TtsError } from '$server/services/tts';
import { readCache, writeCache, unitHash } from '$server/services/tts/cache';
import { applyElfDictionary } from '$server/services/tts/elfDict';
import {
	TTS_AUDIO_SERVICES,
	bakesRate,
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
 * and written to the cache (keyed by book + voice/model/text/context).
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

	const voiceId = body.voiceId ?? '';
	// ELF: apply the voice-language pronunciation dictionary (text-level substitution;
	// the engine's own dict loader is non-functional). Keyed off the VOICE's language
	// (from voiceId), not the book's lang. Done here — before the cache hash below — so
	// the substituted text feeds both unitHash and synthesize, which makes the on-disk
	// audio cache key reflect the dictionary automatically (edit a .dic → re-synthesis).
	const rawText = body.text ?? '';
	const text = body.service === 'elf' ? await applyElfDictionary(voiceId, rawText) : rawText;
	const bookPath = body.bookPath?.trim();
	// voice_settings only affect ElevenLabs output — fold them into the cache key
	// there so re-tuning re-synthesizes, while other services' keys stay stable.
	const voiceSettings = body.service === 'elevenlabs' ? body.voiceSettings : undefined;
	// ELF voice params only affect ELF output — fold them into its cache key too.
	const elfParams = body.service === 'elf' ? body.elfParams : undefined;
	// Local engines (ELF, Piper) bake the reading rate into synthesis (others stretch
	// client-side), so rate changes the samples — fold it into their cache key, while
	// leaving the stretch services' keys stable (one MP3 serves every speed).
	const rate = bakesRate(body.service) ? body.rate : undefined;
	const hash = unitHash({
		service: body.service,
		voiceId,
		model: body.model,
		text,
		previousText: body.previousText,
		nextText: body.nextText,
		voiceSettings,
		elfParams,
		rate
	});

	// Cache hit → serve from disk (no provider call, no bill).
	if (bookPath) {
		const cached = await readCache(bookPath, hash);
		if (cached) return new Response(cached, { headers: AUDIO_HEADERS });
	}

	try {
		const audio = await synthesize({
			service: body.service,
			voiceId,
			text,
			lang: body.lang ?? 'en',
			model: body.model,
			voiceSettings,
			elfParams,
			rate,
			previousText: body.previousText,
			nextText: body.nextText
		});
		if (bookPath) await writeCache(bookPath, hash, new Uint8Array(audio));
		return new Response(audio, { headers: AUDIO_HEADERS });
	} catch (err) {
		const status = err instanceof TtsError ? err.status : 502;
		const message = err instanceof Error ? err.message : 'Synthesis failed';
		return new Response(message, { status });
	}
};
