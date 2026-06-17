/**
 * One-off voice preview for the Settings page.
 *
 * Builds a throwaway TtsEngine, speaks a fixed sample sentence once at the chosen
 * voice + rate, and leaves it playing. A second call (or stopPreview) cancels the
 * previous one. This mirrors readerStore.previewVoice() but is standalone — the
 * Settings page has no loaded book, position, or persistence to involve.
 */
import type { TtsService, TtsAudioService } from '$lib/types';
import type { TtsEngine, SynthRequest } from './types';
import { WebSpeechEngine } from './webspeech';
import { AudioEngine } from './audioEngine';
import { ttsConfigStore } from '$lib/stores/ttsConfig.svelte';

// Monotonic token so a stale engine's callbacks/playback are ignored once a newer
// preview (or a stop) supersedes it — same pattern as the reader's speakToken.
let token = 0;
let active: TtsEngine | null = null;

export interface PreviewOptions {
	service: TtsService;
	voiceId: string;
	rate: number;
	/** Language for the sample (the voice's own lang wins for Web Speech). */
	lang: string;
	/** The sentence to speak (already localized by the caller). */
	sampleText: string;
	/** Shared <audio> sink — required for the server-synthesized services. */
	audioEl?: HTMLAudioElement | null;
}

/** Stop any in-flight preview and release its engine. */
export function stopPreview(): void {
	token++;
	active?.stop();
	active?.destroy?.();
	active = null;
}

/** Speak the sample once in the chosen voice + rate. Errors are swallowed. */
export async function speakPreview(opts: PreviewOptions): Promise<void> {
	stopPreview();
	const my = ++token;
	const engine: TtsEngine =
		opts.service === 'webspeech'
			? new WebSpeechEngine()
			: new AudioEngine(opts.service as TtsAudioService, opts.audioEl ?? null);
	active = engine;

	// Web Speech needs its native voice list resolved before it can match voiceId.
	if (engine.kind === 'webspeech') {
		await engine.listVoices(opts.lang);
		if (my !== token) return;
	}

	const cfg = engine.kind === 'audio' ? ttsConfigStore.get(opts.service as TtsAudioService) : null;
	const req: SynthRequest = {
		text: opts.sampleText,
		lang: opts.lang,
		voiceId: opts.voiceId,
		rate: opts.rate,
		model: cfg?.model || undefined,
		voiceSettings: opts.service === 'elevenlabs' ? cfg?.voiceSettings : undefined
	};

	try {
		await engine.speak(
			req,
			() => my === token,
			() => {},
			() => {}
		);
	} catch {
		// Preview errors are non-fatal — the connection test surfaces real problems.
	}
}
