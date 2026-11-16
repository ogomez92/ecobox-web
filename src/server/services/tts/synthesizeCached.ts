/**
 * Synthesis with the on-disk audio cache in front of it — the one path both the
 * reader (`/api/tts/synthesize`) and the audiobook export take, so the two can
 * never disagree on a cache key: audio already heard is free to export, and an
 * export that stopped half-way resumes without paying for the half it did.
 */
import { synthesize } from './index';
import { readCache, writeCache, unitHash } from './cache';
import { applyElfDictionary } from './elfDict';
import { bakesRate, type TtsAudioService, type ElevenVoiceSettings, type ElfVoiceParams } from '$lib/types';

export interface CachedSynthInput {
	service: TtsAudioService;
	voiceId: string;
	text: string;
	lang: string;
	model?: string;
	voiceSettings?: ElevenVoiceSettings;
	elfParams?: ElfVoiceParams;
	rate?: number;
	previousText?: string;
	nextText?: string;
	/** Book folder the cache entry belongs to; no caching without it. */
	bookPath?: string;
	/** Write a fresh result to the cache (reads always use it). Default true. */
	store?: boolean;
}

/** The exact key/parameters a request synthesizes with, after per-service folding. */
export async function prepareSynth(input: CachedSynthInput) {
	// ELF: the voice-language pronunciation dictionary is applied before hashing,
	// so editing a .dic changes the key and re-synthesizes (see elfDict.ts).
	const text = input.service === 'elf' ? await applyElfDictionary(input.voiceId, input.text) : input.text;
	// Per-service knobs only fold into their own service's key, keeping every other
	// service's keys stable.
	const voiceSettings = input.service === 'elevenlabs' ? input.voiceSettings : undefined;
	const elfParams = input.service === 'elf' ? input.elfParams : undefined;
	const rate = bakesRate(input.service) ? input.rate : undefined;
	const hash = unitHash({
		service: input.service,
		voiceId: input.voiceId,
		model: input.model,
		text,
		previousText: input.previousText,
		nextText: input.nextText,
		voiceSettings,
		elfParams,
		rate
	});
	return { text, voiceSettings, elfParams, rate, hash };
}

/** True when this unit is already in the cache (i.e. costs nothing to produce). */
export async function isCached(input: CachedSynthInput): Promise<boolean> {
	if (!input.bookPath) return false;
	const { hash } = await prepareSynth(input);
	return (await readCache(input.bookPath, hash)) !== null;
}

/** Synthesize (or read from cache) one unit as MP3. Throws TtsError on failure. */
export async function synthesizeCached(
	input: CachedSynthInput
): Promise<{ audio: ArrayBuffer; cached: boolean }> {
	const prep = await prepareSynth(input);
	const bookPath = input.bookPath?.trim();
	if (bookPath) {
		const hit = await readCache(bookPath, prep.hash);
		if (hit) return { audio: hit, cached: true };
	}
	const audio = await synthesize({
		service: input.service,
		voiceId: input.voiceId,
		text: prep.text,
		lang: input.lang || 'en',
		model: input.model,
		voiceSettings: prep.voiceSettings,
		elfParams: prep.elfParams,
		rate: prep.rate,
		previousText: input.previousText,
		nextText: input.nextText
	});
	if (bookPath && input.store !== false) await writeCache(bookPath, prep.hash, new Uint8Array(audio));
	return { audio, cached: false };
}
