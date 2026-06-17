import type { TtsVoice, ElevenVoiceSettings } from '$lib/types';
export type { TtsVoice };

/** One synthesis request: the text of a unit plus the voice/rate/context to render it. */
export interface SynthRequest {
	text: string;
	lang: string;
	voiceId: string;
	rate: number;
	/** ElevenLabs model id (ignored by other engines). */
	model?: string;
	/** ElevenLabs voice_settings (ignored by other engines). */
	voiceSettings?: ElevenVoiceSettings;
	/** ElevenLabs context — surrounding units' text (ignored by other engines). */
	previousText?: string;
	nextText?: string;
	/** Book folder path — lets the server cache synthesized audio per book. */
	bookPath?: string;
}

/**
 * A pluggable speech backend. `readerStore` owns position/navigation/persistence
 * and calls into one engine to actually produce sound for a unit of text.
 *
 * `webspeech` = the browser's local engine (units are single sentences).
 * `audio` = a server-synthesized provider played through a shared <audio> element
 * (units may batch several sentences; supports prefetch).
 */
export interface TtsEngine {
	readonly kind: 'webspeech' | 'audio';
	/** Audio engines batch sentences up to this many characters; webspeech ignores it. */
	readonly unitMaxChars: number;

	/** Voices available for this engine (optionally filtered by language). */
	listVoices(lang: string): Promise<TtsVoice[]>;

	/**
	 * Speak one unit. Resolves when the unit finishes (or fails). `isCurrent`
	 * reports whether this call is still the active one (the reader's speakToken);
	 * the engine must consult it before firing onEnded/onError so stale callbacks
	 * (after a seek/pause/voice change) are ignored.
	 */
	speak(
		req: SynthRequest,
		isCurrent: () => boolean,
		onEnded: () => void,
		onError: (e: unknown) => void
	): Promise<void>;

	/** Pre-synthesize an upcoming unit (audio engines only; webspeech is a no-op). */
	prefetch?(req: SynthRequest): void;

	/** Stop current output without discarding cached audio. */
	stop(): void;

	/** Apply a new rate live where possible (audio: playbackRate; webspeech: no-op). */
	setRate(rate: number): void;

	/** Release all resources (revoke cached object URLs, drop the audio element ref). */
	destroy?(): void;
}
