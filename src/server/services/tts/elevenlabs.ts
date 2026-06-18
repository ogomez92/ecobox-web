/** ElevenLabs TTS adapter. https://elevenlabs.io/docs/api-reference */
import type { TtsVoice, ElevenVoiceSettings, TtsQuota } from '$lib/types';
import { DEFAULT_ELEVEN_MODEL, ELEVEN_LANG_CODE_MODELS } from '$lib/types';
import { TtsError } from './errors';

const BASE = 'https://api.elevenlabs.io/v1';
const TIMEOUT = 30000;

/** Map a BCP-47 tag ('en-US', 'zh-Hans-CN') to an ISO 639-1 code ('en', 'zh'). */
function iso6391(lang: string | undefined): string | undefined {
	const primary = (lang || '').trim().split('-')[0].toLowerCase();
	return /^[a-z]{2}$/.test(primary) ? primary : undefined;
}

export async function elevenSynthesize(opts: {
	apiKey: string;
	voiceId: string;
	text: string;
	lang?: string;
	model?: string;
	voiceSettings?: ElevenVoiceSettings;
	previousText?: string;
	nextText?: string;
}): Promise<ArrayBuffer> {
	if (!opts.apiKey) throw new TtsError(400, 'ElevenLabs API key not configured');
	if (!opts.voiceId) throw new TtsError(400, 'No ElevenLabs voice selected');

	const model = opts.model || DEFAULT_ELEVEN_MODEL;
	const vs = opts.voiceSettings;
	// `language_code` is only honored by the v2.5 models — sending it to others
	// can 400, so gate it. (Multilingual v2 auto-detects language instead.)
	const languageCode = ELEVEN_LANG_CODE_MODELS.includes(model) ? iso6391(opts.lang) : undefined;

	let res: Response;
	try {
		res = await fetch(`${BASE}/text-to-speech/${encodeURIComponent(opts.voiceId)}`, {
			method: 'POST',
			headers: {
				'xi-api-key': opts.apiKey,
				'Content-Type': 'application/json',
				Accept: 'audio/mpeg'
			},
			body: JSON.stringify({
				text: opts.text,
				model_id: model,
				language_code: languageCode,
				voice_settings: vs
					? {
							stability: vs.stability,
							similarity_boost: vs.similarityBoost,
							style: vs.style,
							use_speaker_boost: vs.useSpeakerBoost
						}
					: undefined,
				// Context: feeding the surrounding text improves prosody across units.
				previous_text: opts.previousText || undefined,
				next_text: opts.nextText || undefined
			}),
			signal: AbortSignal.timeout(TIMEOUT)
		});
	} catch {
		throw new TtsError(503, 'ElevenLabs unreachable');
	}
	if (!res.ok) {
		throw new TtsError(res.status === 401 ? 401 : 502, `ElevenLabs error ${res.status}`);
	}
	return res.arrayBuffer();
}

/**
 * Current subscription character usage/limit (GET /v1/user/subscription).
 * Used to announce "characters remaining" in the reader. The same xi-api-key
 * that synthesizes can read this — no extra scope needed.
 */
export async function elevenSubscription(apiKey: string): Promise<TtsQuota> {
	if (!apiKey) throw new TtsError(400, 'ElevenLabs API key not configured');
	let res: Response;
	try {
		res = await fetch(`${BASE}/user/subscription`, {
			headers: { 'xi-api-key': apiKey },
			signal: AbortSignal.timeout(TIMEOUT)
		});
	} catch {
		throw new TtsError(503, 'ElevenLabs unreachable');
	}
	if (!res.ok) throw new TtsError(res.status === 401 ? 401 : 502, `ElevenLabs error ${res.status}`);
	const data = (await res.json()) as {
		character_count?: number;
		character_limit?: number;
		next_character_count_reset_unix?: number;
	};
	const used = Math.max(0, Number(data.character_count ?? 0));
	const limit = Math.max(0, Number(data.character_limit ?? 0));
	return {
		used,
		limit,
		remaining: Math.max(0, limit - used),
		resetUnix: data.next_character_count_reset_unix
	};
}

export async function elevenVoices(apiKey: string): Promise<TtsVoice[]> {
	if (!apiKey) throw new TtsError(400, 'ElevenLabs API key not configured');
	let res: Response;
	try {
		res = await fetch(`${BASE}/voices`, {
			headers: { 'xi-api-key': apiKey },
			signal: AbortSignal.timeout(TIMEOUT)
		});
	} catch {
		throw new TtsError(503, 'ElevenLabs unreachable');
	}
	if (!res.ok) throw new TtsError(res.status === 401 ? 401 : 502, `ElevenLabs error ${res.status}`);
	const data = await res.json();
	return ((data.voices ?? []) as Record<string, unknown>[]).map((v) => {
		const labels = (v.labels ?? {}) as Record<string, string>;
		const accent = labels.accent ? ` (${labels.accent})` : '';
		return {
			id: String(v.voice_id),
			name: `${String(v.name)}${accent}`,
			lang: labels.language || ''
		};
	});
}
