/**
 * Web Speech engine — the browser's local speechSynthesis. This is the original
 * reader path, extracted behind the TtsEngine interface; behavior is unchanged.
 * Units are single sentences (no grouping, no prefetch).
 */
import type { TtsEngine, SynthRequest, TtsVoice } from './types';

export class WebSpeechEngine implements TtsEngine {
	readonly kind = 'webspeech' as const;
	readonly unitMaxChars = 1; // sentinel: never group
	readonly liveRate = false; // can't retune a live utterance — reader re-speaks

	private native: SpeechSynthesisVoice[] = [];

	private get synth(): SpeechSynthesis | null {
		return typeof window !== 'undefined' && 'speechSynthesis' in window
			? window.speechSynthesis
			: null;
	}

	async listVoices(): Promise<TtsVoice[]> {
		const synth = this.synth;
		if (!synth) return [];
		this.native = await this.loadNative(synth);
		return this.native.map((v) => ({ id: v.voiceURI, name: `${v.name} (${v.lang})`, lang: v.lang }));
	}

	/** Wait for the async voice list (often empty until `voiceschanged`). */
	private loadNative(synth: SpeechSynthesis): Promise<SpeechSynthesisVoice[]> {
		return new Promise((resolve) => {
			let done = false;
			const finish = (list: SpeechSynthesisVoice[]) => {
				if (done) return;
				done = true;
				resolve(list);
			};
			const apply = () => {
				const list = synth.getVoices();
				if (list.length > 0) finish(list);
			};
			apply();
			if (!done) {
				synth.addEventListener('voiceschanged', apply);
				setTimeout(() => finish(synth.getVoices()), 2000);
			}
		});
	}

	async speak(
		req: SynthRequest,
		isCurrent: () => boolean,
		onEnded: () => void,
		onError: (e: unknown) => void
	): Promise<void> {
		const synth = this.synth;
		if (!synth) {
			onError(new Error('no speechSynthesis'));
			return;
		}
		synth.cancel();
		const u = new SpeechSynthesisUtterance(req.text);
		const voice = this.native.find((v) => v.voiceURI === req.voiceId);
		if (voice) u.voice = voice;
		u.rate = req.rate;
		u.lang = voice?.lang || req.lang;
		u.onend = () => {
			if (isCurrent()) onEnded();
		};
		u.onerror = (e) => {
			if (!isCurrent()) return;
			// 'interrupted'/'canceled' fire on a normal cancel — not real errors.
			if (e.error === 'interrupted' || e.error === 'canceled') return;
			onError(e);
		};
		synth.speak(u);
	}

	stop(): void {
		this.synth?.cancel();
	}

	setRate(): void {
		// Web Speech can't retune a live utterance; the reader re-speaks instead.
	}

	destroy(): void {
		this.synth?.cancel();
	}
}
