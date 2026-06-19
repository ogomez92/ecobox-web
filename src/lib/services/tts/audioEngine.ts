/**
 * Audio engine — shared by ElevenLabs / Azure / Google. Synthesis happens on the
 * server (keys stay server-side); this plays the returned MP3 through a single
 * reusable <audio> element, which is also what enables MediaSession / lock-screen
 * playback. Upcoming units are prefetched into a small bounded, content-keyed cache.
 */
import type { TtsEngine, SynthRequest, TtsVoice } from './types';
import { bakesRate, type TtsAudioService } from '$lib/types';

interface CacheEntry {
	url?: string;
	promise?: Promise<string>;
}

const MAX_CACHE = 8;

export class AudioEngine implements TtsEngine {
	readonly kind = 'audio' as const;
	// Local engines (ELF via eciSpeed, Piper via --length_scale) bake the reading rate
	// into synthesis, so they can't be retuned live and play at playbackRate=1; the
	// remote audio services time-stretch the finished MP3 via playbackRate, retuning
	// instantly. See TTS_BAKED_RATE_SERVICES / bakesRate().
	readonly liveRate: boolean;
	// Batch sentences into synthesis units up to this many chars. Units still
	// flush at every paragraph boundary, so this only merges *within* long
	// paragraphs. Kept well under ElevenLabs' multilingual_v2 limit (10k chars);
	// note Google Cloud TTS caps at 5000 *bytes*, so CJK content can approach it.
	readonly unitMaxChars = 5000;

	private service: TtsAudioService;
	private audio: HTMLAudioElement | null;
	private cache = new Map<string, CacheEntry>();

	constructor(service: TtsAudioService, audio: HTMLAudioElement | null) {
		this.service = service;
		this.audio = audio;
		this.liveRate = !bakesRate(service);
	}

	setAudio(audio: HTMLAudioElement | null) {
		this.audio = audio;
	}

	async listVoices(lang: string): Promise<TtsVoice[]> {
		const res = await fetch(
			`/api/tts/voices?service=${encodeURIComponent(this.service)}&lang=${encodeURIComponent(lang || '')}`
		);
		if (!res.ok) {
			const err = new Error(`voices ${res.status}`) as Error & { status?: number };
			err.status = res.status;
			throw err;
		}
		return (await res.json()) as TtsVoice[];
	}

	async speak(
		req: SynthRequest,
		isCurrent: () => boolean,
		onEnded: () => void,
		onError: (e: unknown) => void
	): Promise<void> {
		try {
			const url = await this.ensure(req);
			if (!isCurrent()) return; // a seek/stop happened while synthesizing
			const audio = this.audio;
			if (!audio) {
				onError(new Error('no audio element'));
				return;
			}
			audio.onended = () => {
				if (isCurrent()) onEnded();
			};
			audio.onerror = () => {
				if (isCurrent()) onError(new Error('audio playback error'));
			};
			audio.src = url;
			// Baked-rate engines (ELF, Piper) already synthesized at the target rate, so
			// play untouched; the remote services stretch the finished MP3 here.
			audio.playbackRate = bakesRate(this.service) ? 1 : req.rate;
			await audio.play();
		} catch (e) {
			if (isCurrent()) onError(e);
		}
	}

	prefetch(req: SynthRequest): void {
		this.ensure(req).catch(() => {
			// Prefetch failures are non-fatal; speak() will retry/surface them.
		});
	}

	stop(): void {
		const audio = this.audio;
		if (!audio) return;
		audio.onended = null;
		audio.onerror = null;
		try {
			audio.pause();
		} catch {
			// ignore
		}
	}

	setRate(rate: number): void {
		// Baked-rate engines (ELF, Piper) have rate baked into synthesis (liveRate=false)
		// — the reader re-speaks to apply a new rate, so don't touch playbackRate here.
		if (!bakesRate(this.service) && this.audio) this.audio.playbackRate = rate;
	}

	destroy(): void {
		this.stop();
		for (const entry of this.cache.values()) {
			if (entry.url) URL.revokeObjectURL(entry.url);
		}
		this.cache.clear();
	}

	// --- internal: content-keyed synthesis cache ---

	private key(req: SynthRequest): string {
		// Fold in the tuning knobs that change the audio so re-tuning doesn't hit a
		// stale in-memory entry (voiceSettings = ElevenLabs, elfParams = ELF).
		const vs = req.voiceSettings
			? `${req.voiceSettings.stability},${req.voiceSettings.similarityBoost},${req.voiceSettings.style},${req.voiceSettings.useSpeakerBoost ? 1 : 0}`
			: '';
		const ep = req.elfParams
			? `${req.elfParams.headSize},${req.elfParams.pitch},${req.elfParams.inflection},${req.elfParams.roughness},${req.elfParams.breathiness},${req.elfParams.volume}`
			: '';
		// Baked-rate engines (ELF, Piper) bake rate into the audio, so a rate change must
		// miss the cache and re-synthesize; stretch services reuse one MP3 across speeds.
		const rt = bakesRate(this.service) ? `${req.rate}` : '';
		return `${this.service}|${req.voiceId}|${req.model ?? ''}|${vs}|${ep}|${rt}|${hash(req.text)}`;
	}

	private ensure(req: SynthRequest): Promise<string> {
		const key = this.key(req);
		const hit = this.cache.get(key);
		if (hit?.url) return Promise.resolve(hit.url);
		if (hit?.promise) return hit.promise;
		const promise = this.fetchAudio(req).then((url) => {
			this.cache.set(key, { url });
			this.evict();
			return url;
		});
		this.cache.set(key, { promise });
		return promise;
	}

	private async fetchAudio(req: SynthRequest): Promise<string> {
		const res = await fetch('/api/tts/synthesize', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				service: this.service,
				voiceId: req.voiceId,
				text: req.text,
				lang: req.lang,
				model: req.model,
				voiceSettings: req.voiceSettings,
				elfParams: req.elfParams,
				rate: req.rate,
				previousText: req.previousText,
				nextText: req.nextText,
				bookPath: req.bookPath
			})
		});
		if (!res.ok) {
			const msg = await res.text().catch(() => '');
			const err = new Error(msg || `synthesize ${res.status}`) as Error & { status?: number };
			err.status = res.status;
			// Drop the failed placeholder so a later attempt can retry.
			this.cache.delete(this.key(req));
			throw err;
		}
		const blob = await res.blob();
		return URL.createObjectURL(blob);
	}

	/** Bound memory: revoke the oldest object URLs beyond MAX_CACHE (insertion order). */
	private evict(): void {
		while (this.cache.size > MAX_CACHE) {
			const oldest = this.cache.keys().next().value as string | undefined;
			if (oldest === undefined) break;
			const entry = this.cache.get(oldest);
			if (entry?.url) URL.revokeObjectURL(entry.url);
			this.cache.delete(oldest);
		}
	}
}

/** Small, fast string hash (djb2) for cache keys — collisions are harmless here. */
function hash(s: string): string {
	let h = 5381;
	for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
	return (h >>> 0).toString(36);
}
