/**
 * Book reader store — the TTS counterpart to playerStore.
 *
 * Engine is the browser's Web Speech API (window.speechSynthesis), not an <audio>
 * element. Position is a chunk (sentence) index, not seconds; "seek" means speak a
 * different sentence. The whole chunk list is loaded once and everything (play,
 * find, seek, position) is an in-memory operation.
 *
 * Web Speech quirks handled here:
 *  - voices load asynchronously (voiceschanged)
 *  - rate/voice cannot be changed on a live utterance -> cancel + re-speak current
 *  - pause() is unreliable on some engines -> pause = cancel() + remembered index
 *  - Chrome cuts long utterances (~15s) -> mitigated by sentence-sized chunks
 *    (a pause/resume keepalive pump was removed; see memory if the cutoff appears)
 *  - stale utterance callbacks are ignored via a monotonic speak token
 */
import type { Chunk, BookContent } from '$lib/types';
import { settingsStore } from './settings.svelte';
import { t } from '$lib/i18n/index.svelte';

const VOICE_KEY = 'ecobox-tts-voice';

/**
 * Case- and accent-insensitive folding for find/highlight, so "policia" matches
 * "policía" and "EL" matches "el". Lowercase first, then strip combining marks.
 */
export function foldForSearch(s: string): string {
	return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}

class ReaderStore {
	bookFolderPath = $state<string | null>(null);
	title = $state('');
	locale = $state('en');
	chunks = $state<Chunk[]>([]);
	currentChunkIndex = $state(0);

	isPlaying = $state(false);
	isLoading = $state(false);
	error = $state<string | null>(null);

	rate = $state(1);
	voiceURI = $state<string | null>(null);
	voices = $state<SpeechSynthesisVoice[]>([]);

	private speakToken = 0;
	private positionSavedForNavigation = false;
	private lastPositionSaveTime = 0;
	private rateRestartTimer: ReturnType<typeof setTimeout> | null = null;
	private mediaSessionSetup = false;

	private get synth(): SpeechSynthesis | null {
		return typeof window !== 'undefined' && 'speechSynthesis' in window ? window.speechSynthesis : null;
	}

	get totalChunks(): number {
		return this.chunks.length;
	}

	get progress(): number {
		if (this.chunks.length === 0) return 0;
		return ((this.currentChunkIndex + 1) / this.chunks.length) * 100;
	}

	get currentChunk(): Chunk | null {
		return this.chunks[this.currentChunkIndex] ?? null;
	}

	/** The nearest preceding heading — used as the "chapter title" readout. */
	get currentHeading(): string {
		for (let i = Math.min(this.currentChunkIndex, this.chunks.length - 1); i >= 0; i--) {
			if (this.chunks[i]?.type === 'heading') return this.chunks[i].text;
		}
		return '';
	}

	// -------------------------------------------------------------------------
	// Loading
	// -------------------------------------------------------------------------

	async loadBook(folderPath: string) {
		this.positionSavedForNavigation = false;
		this.bookFolderPath = folderPath;
		this.isLoading = true;
		this.error = null;
		this.currentChunkIndex = 0;
		this.isPlaying = false;
		// Adopt the global default rate (the slider then persists changes back).
		this.rate = settingsStore.ttsRate;

		try {
			const res = await fetch(`/api/books/content?path=${encodeURIComponent(folderPath)}`);
			if (!res.ok) throw new Error('content');
			const data: BookContent = await res.json();
			this.title = data.title;
			this.locale = data.locale || 'en';
			this.chunks = data.chunks || [];
		} catch {
			this.error = t('reader.loadFailed');
			this.isLoading = false;
			return;
		}

		// Restore saved position.
		try {
			const res = await fetch(`/api/books/metadata?path=${encodeURIComponent(folderPath)}`);
			if (res.ok) {
				const meta = await res.json();
				if (typeof meta.currentChunkIndex === 'number' && meta.currentChunkIndex < this.chunks.length) {
					this.currentChunkIndex = Math.max(0, meta.currentChunkIndex);
				}
			}
		} catch {
			// Ignore — start from the beginning.
		}

		this.isLoading = false;
		this.setupMediaSession();
		this.updateMediaSessionMetadata();
	}

	/**
	 * Populate the device's voice list and resolve the saved/default voice.
	 * Resolves once voices are available (getVoices() is often empty until the
	 * engine fires voiceschanged) so callers can wait before auto-starting —
	 * otherwise the first utterance speaks in the default voice, not the saved one.
	 * A short timeout backs out so autoplay is never blocked forever.
	 */
	loadVoices(): Promise<void> {
		const synth = this.synth;
		if (!synth) return Promise.resolve();

		return new Promise((resolve) => {
			let done = false;
			const finish = () => {
				if (done) return;
				done = true;
				resolve();
			};

			const apply = () => {
				this.voices = synth.getVoices();
				if (this.voices.length === 0) return;

				let saved: string | null = null;
				try {
					saved = localStorage.getItem(VOICE_KEY);
				} catch {
					// ignore
				}

				if (saved && this.voices.some((v) => v.voiceURI === saved)) {
					this.voiceURI = saved;
				} else if (!this.voiceURI || !this.voices.some((v) => v.voiceURI === this.voiceURI)) {
					const fallback =
						this.voices.find((v) => v.lang?.toLowerCase().startsWith(this.locale.toLowerCase())) ||
						this.voices.find((v) => v.default) ||
						this.voices[0];
					this.voiceURI = fallback?.voiceURI ?? null;
				}
				finish();
			};

			apply();
			if (this.voices.length === 0) {
				synth.addEventListener('voiceschanged', apply);
				setTimeout(finish, 2000); // safety net if no voices ever arrive
			}
		});
	}

	// -------------------------------------------------------------------------
	// Playback
	// -------------------------------------------------------------------------

	/** Speak the current chunk and chain to the next on completion. Call from a user gesture. */
	private speakCurrent() {
		const synth = this.synth;
		if (!synth) return;
		if (this.currentChunkIndex < 0 || this.currentChunkIndex >= this.chunks.length) {
			this.isPlaying = false;
			return;
		}

		const myToken = ++this.speakToken;
		synth.cancel(); // clear any queued/old utterance

		const chunk = this.chunks[this.currentChunkIndex];
		const utterance = new SpeechSynthesisUtterance(chunk.text);
		const voice = this.voices.find((v) => v.voiceURI === this.voiceURI);
		if (voice) utterance.voice = voice;
		utterance.rate = this.rate;
		utterance.lang = voice?.lang || this.locale;

		utterance.onend = () => {
			if (myToken !== this.speakToken) return; // stale (cancelled/replaced)
			if (this.currentChunkIndex < this.chunks.length - 1) {
				this.currentChunkIndex++;
				this.throttledSavePosition();
				this.speakCurrent();
			} else {
				this.isPlaying = false;
				this.savePosition();
			}
		};

		utterance.onerror = (e) => {
			if (myToken !== this.speakToken) return;
			// 'interrupted'/'canceled' fire on a normal cancel — not real errors.
			if (e.error === 'interrupted' || e.error === 'canceled') return;
			this.error = t('reader.speakFailed');
			this.isPlaying = false;
		};

		this.isPlaying = true;
		synth.speak(utterance);
		this.setMediaSessionState('playing');
		this.updateMediaSessionMetadata();
	}

	play() {
		if (this.chunks.length === 0) return;
		this.error = null;
		this.speakCurrent();
	}

	/** Pause = cancel + keep the index (pause() is unreliable across engines). */
	pause() {
		this.isPlaying = false;
		this.speakToken++; // invalidate the in-flight utterance's callbacks
		this.synth?.cancel();
		this.setMediaSessionState('paused');
		this.savePosition();
	}

	togglePlayPause() {
		if (this.isPlaying) this.pause();
		else this.play();
	}

	/** Move to a chunk; resume reading from there if we were playing. */
	seekToChunk(index: number, resume = this.isPlaying) {
		if (this.chunks.length === 0) return;
		this.currentChunkIndex = Math.max(0, Math.min(index, this.chunks.length - 1));
		if (resume) {
			this.speakCurrent();
		} else {
			this.speakToken++;
			this.synth?.cancel();
			this.isPlaying = false;
		}
		this.savePosition();
	}

	next() {
		this.seekToChunk(this.currentChunkIndex + 1);
	}

	prev() {
		this.seekToChunk(this.currentChunkIndex - 1);
	}

	nextParagraph() {
		const cur = this.chunks[this.currentChunkIndex];
		if (!cur) return;
		const target = this.chunks.find((c) => c.para > cur.para);
		if (target) this.seekToChunk(target.i);
	}

	prevParagraph() {
		const cur = this.chunks[this.currentChunkIndex];
		if (!cur) return;
		const firstOfCurrent = this.chunks.find((c) => c.para === cur.para);
		// If we're past the first sentence of this paragraph, jump to its start first.
		if (firstOfCurrent && this.currentChunkIndex > firstOfCurrent.i) {
			this.seekToChunk(firstOfCurrent.i);
			return;
		}
		const prev = [...this.chunks].reverse().find((c) => c.para < cur.para);
		if (prev) {
			const first = this.chunks.find((c) => c.para === prev.para);
			if (first) this.seekToChunk(first.i);
		} else {
			this.seekToChunk(0);
		}
	}

	/** Jump to the next heading chunk (lands on the title itself, not the body). */
	nextHeading() {
		for (let i = this.currentChunkIndex + 1; i < this.chunks.length; i++) {
			if (this.chunks[i].type === 'heading') {
				this.seekToChunk(i);
				return;
			}
		}
	}

	/**
	 * Jump to a heading title. If we're inside a section (past its heading), go to
	 * that heading first; if already on it, go to the previous one (chapter-style).
	 */
	prevHeading() {
		let curHeading = -1;
		for (let i = Math.min(this.currentChunkIndex, this.chunks.length - 1); i >= 0; i--) {
			if (this.chunks[i]?.type === 'heading') {
				curHeading = i;
				break;
			}
		}
		if (curHeading >= 0 && curHeading < this.currentChunkIndex) {
			this.seekToChunk(curHeading);
			return;
		}
		const from = (curHeading >= 0 ? curHeading : this.currentChunkIndex) - 1;
		for (let i = from; i >= 0; i--) {
			if (this.chunks[i]?.type === 'heading') {
				this.seekToChunk(i);
				return;
			}
		}
		this.seekToChunk(0);
	}

	setRate(rate: number) {
		this.rate = Math.min(5, Math.max(0.5, rate));
		settingsStore.setTtsRate(this.rate);
		// Web Speech can't retune a live utterance — debounce (the slider fires
		// rapidly), then re-speak the current sentence (if playing) or a short
		// preview (if paused) so the new rate is always audible immediately.
		if (this.rateRestartTimer) clearTimeout(this.rateRestartTimer);
		this.rateRestartTimer = setTimeout(() => {
			if (this.isPlaying) this.speakCurrent();
			else this.previewVoice();
		}, 250);
	}

	setVoice(voiceURI: string) {
		this.voiceURI = voiceURI;
		try {
			localStorage.setItem(VOICE_KEY, voiceURI);
		} catch {
			// ignore
		}
		// Let the user hear the newly-chosen voice (at the current rate) right away.
		if (this.isPlaying) this.speakCurrent();
		else this.previewVoice();
	}

	/**
	 * Speak a fixed preview sentence (in Ecobox's current UI language) at the
	 * chosen voice + rate, used to preview voice/speed changes while paused. It
	 * deliberately does NOT read the book, change the play state, or move position.
	 */
	private previewVoice() {
		const synth = this.synth;
		if (!synth) return;
		this.speakToken++; // invalidate any in-flight (book) utterance callbacks
		synth.cancel();
		const utterance = new SpeechSynthesisUtterance(t('reader.voicePreviewSample'));
		const voice = this.voices.find((v) => v.voiceURI === this.voiceURI);
		if (voice) utterance.voice = voice;
		utterance.rate = this.rate;
		if (voice?.lang) utterance.lang = voice.lang;
		synth.speak(utterance);
	}

	// -------------------------------------------------------------------------
	// Find in book
	// -------------------------------------------------------------------------

	find(query: string): { results: Chunk[]; total: number } {
		const q = foldForSearch(query.trim());
		if (!q) return { results: [], total: 0 };
		const matches = this.chunks.filter((c) => foldForSearch(c.text).includes(q));
		return { results: matches.slice(0, 100), total: matches.length };
	}

	// -------------------------------------------------------------------------
	// Media Session (best-effort; foreground only — see plan/CLAUDE.md)
	// -------------------------------------------------------------------------

	private setupMediaSession() {
		if (this.mediaSessionSetup || typeof navigator === 'undefined' || !('mediaSession' in navigator)) {
			return;
		}
		try {
			navigator.mediaSession.setActionHandler('play', () => this.play());
			navigator.mediaSession.setActionHandler('pause', () => this.pause());
			navigator.mediaSession.setActionHandler('previoustrack', () => this.prev());
			navigator.mediaSession.setActionHandler('nexttrack', () => this.next());
		} catch {
			// Some handlers may be unsupported — ignore.
		}
		this.mediaSessionSetup = true;
	}

	private setMediaSessionState(state: 'playing' | 'paused') {
		if (typeof navigator !== 'undefined' && 'mediaSession' in navigator) {
			navigator.mediaSession.playbackState = state;
		}
	}

	private updateMediaSessionMetadata() {
		if (typeof navigator === 'undefined' || !('mediaSession' in navigator)) return;
		try {
			navigator.mediaSession.metadata = new MediaMetadata({
				title: this.currentHeading || this.title,
				artist: 'Ecobox',
				album: this.title
			});
		} catch {
			// ignore
		}
	}

	// -------------------------------------------------------------------------
	// Position persistence (mirrors playerStore's race-safe pattern)
	// -------------------------------------------------------------------------

	private async doSavePosition(capturedIndex?: number) {
		if (!this.bookFolderPath) return;
		const index = capturedIndex ?? this.currentChunkIndex;
		try {
			await fetch('/api/books/metadata', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					bookFolderPath: this.bookFolderPath,
					currentChunkIndex: index,
					totalChunks: this.chunks.length
				})
			});
		} catch {
			// Ignore save errors.
		}
	}

	private throttledSavePosition() {
		if (this.positionSavedForNavigation) return;
		const now = Date.now();
		if (now - this.lastPositionSaveTime >= 5000) {
			this.lastPositionSaveTime = now;
			this.savePosition();
		}
	}

	async savePosition() {
		if (this.positionSavedForNavigation) return;
		await this.doSavePosition();
	}

	async savePositionForNavigation() {
		if (this.positionSavedForNavigation) return;
		const capturedIndex = this.currentChunkIndex;
		this.positionSavedForNavigation = true;
		await this.doSavePosition(capturedIndex);
	}

	destroy() {
		const wasSaved = this.positionSavedForNavigation;
		const capturedIndex = this.currentChunkIndex;
		this.positionSavedForNavigation = true;
		this.speakToken++;
		this.synth?.cancel();
		this.isPlaying = false;
		if (this.rateRestartTimer) clearTimeout(this.rateRestartTimer);
		if (!wasSaved && this.bookFolderPath) {
			this.doSavePosition(capturedIndex);
		}
		this.lastPositionSaveTime = 0;
	}
}

export const readerStore = new ReaderStore();
