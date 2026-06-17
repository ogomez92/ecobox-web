/**
 * Server-side TTS dispatcher. Synthesizes audio and lists voices for the
 * audio-based services (ElevenLabs, Azure key/edge, Google), keeping API keys
 * server-side. Web Speech is handled entirely in the browser and never reaches here.
 */
import type { TtsAudioService, TtsVoice, ElevenVoiceSettings } from '$lib/types';
import { resolveCredential } from './credentials';
import { TtsError } from './errors';
import { elevenSynthesize, elevenVoices } from './elevenlabs';
import { azureSynthesize, azureVoices, edgeSynthesize, edgeVoices } from './azure';
import { googleSynthesize, googleVoices } from './google';

export { TtsError } from './errors';

export interface SynthesizeInput {
	service: TtsAudioService;
	voiceId: string;
	text: string;
	lang: string;
	model?: string;
	voiceSettings?: ElevenVoiceSettings;
	previousText?: string;
	nextText?: string;
}

/** Normalize provider output to a standalone ArrayBuffer (a valid Response body). */
function toArrayBuffer(buf: ArrayBuffer | Buffer): ArrayBuffer {
	if (buf instanceof ArrayBuffer) return buf;
	return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** Synthesize MP3 audio for the given text. Throws TtsError on failure. */
export async function synthesize(input: SynthesizeInput): Promise<ArrayBuffer> {
	const text = (input.text || '').trim();
	if (!text) throw new TtsError(400, 'No text to synthesize');
	const cred = await resolveCredential(input.service);
	const voiceId = input.voiceId || cred.voiceId;

	switch (input.service) {
		case 'elevenlabs':
			return toArrayBuffer(
				await elevenSynthesize({
					apiKey: cred.apiKey,
					voiceId,
					text,
					lang: input.lang,
					model: input.model || cred.model,
					voiceSettings: input.voiceSettings ?? cred.voiceSettings,
					previousText: input.previousText,
					nextText: input.nextText
				})
			);
		case 'azure':
			return toArrayBuffer(
				await azureSynthesize({ apiKey: cred.apiKey, region: cred.region, voiceId, text, lang: input.lang })
			);
		case 'azure-edge':
			return toArrayBuffer(await edgeSynthesize({ voiceId, text }));
		case 'google':
			return toArrayBuffer(await googleSynthesize({ apiKey: cred.apiKey, voiceId, text, lang: input.lang }));
		default:
			throw new TtsError(400, 'Unknown TTS service');
	}
}

export async function listVoices(service: TtsAudioService, lang: string): Promise<TtsVoice[]> {
	const cred = await resolveCredential(service);
	switch (service) {
		case 'elevenlabs':
			return elevenVoices(cred.apiKey);
		case 'azure':
			return azureVoices({ apiKey: cred.apiKey, region: cred.region });
		case 'azure-edge':
			return edgeVoices();
		case 'google':
			return googleVoices({ apiKey: cred.apiKey, lang });
		default:
			throw new TtsError(400, 'Unknown TTS service');
	}
}

/** Lightweight connectivity/credential check used by the settings "Test" button. */
export async function validateService(
	service: TtsAudioService
): Promise<{ ok: boolean; message: string; voiceCount?: number }> {
	try {
		const voices = await listVoices(service, '');
		return { ok: true, message: 'ok', voiceCount: voices.length };
	} catch (e) {
		if (e instanceof TtsError) return { ok: false, message: e.message };
		return { ok: false, message: 'Unexpected error' };
	}
}
