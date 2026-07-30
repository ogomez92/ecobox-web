/**
 * Book reader store — the TTS counterpart to playerStore.
 *
 * The reader owns position, navigation, persistence and MediaSession; the actual
 * "make sound" step is delegated to a pluggable TtsEngine:
 *  - WebSpeechEngine: the browser's speechSynthesis (units = single sentences).
 *  - AudioEngine: a server-synthesized provider (ElevenLabs / Azure / Google)
 *    played through a shared <audio> element, with larger grouped units + prefetch.
 *
 * Position is the canonical sentence index (`currentChunkIndex`), saved to
 * book_metadata. Unit grouping is a runtime view (see ttsUnits) and never changes
 * what gets stored, so positions survive switching services.
 *
 * Quirks handled here:
 *  - Web Speech voices load asynchronously; rate/voice can't retune a live
 *    utterance -> cancel + re-speak. Audio retunes live via playbackRate.
 *  - stale callbacks (after seek/pause/voice change) are ignored via a monotonic
 *    speak token threaded into each engine.speak call.
 *  - if an audio provider fails mid-read we fall back to Web Speech for the session.
 */
import type { Chunk, BookContent, TtsService, TtsAudioService, TtsVoice } from '$lib/types';
import { settingsStore } from './settings.svelte';
import { ttsConfigStore } from './ttsConfig.svelte';
import { t } from '$lib/i18n/index.svelte';
import type { TtsEngine, SynthRequest } from '$lib/services/tts/types';
import { WebSpeechEngine } from '$lib/services/tts/webspeech';
import { AudioEngine } from '$lib/services/tts/audioEngine';
import { groupChunks, singletonUnits, unitForChunk, type Unit } from '$lib/utils/ttsUnits';

const VOICE_KEY = 'ecobox-tts-voice';
const PREFETCH_AHEAD = 3;

/**
 * Case- and accent-insensitive folding for find/highlight, so "policia" matches
 * "policía" and "EL" matches "el". Re-exported here because the reader's find
 * and its consumers (FindInBook) have always imported it from this module; the
 * implementation is shared with the file-browser search.
 */
import { foldForSearch } from '$lib/utils/text';
export { foldForSearch };

/**
 * True when playback was blocked by the browser's autoplay policy (no user
 * gesture — e.g. after a page refresh) rather than a real synthesis/engine
 * failure. Web Speech reports it as a 'not-allowed' SpeechSynthesisErrorEvent;
 * the <audio> element rejects play() with a NotAllowedError DOMException. In
 * either case the user just needs to press Play, so we stay paused silently
 * (mirroring the audio player, which ignores NotAllowedError).
 */
function isAutoplayBlocked(e: unknown): boolean {
	if (!e || typeof e !== 'object') return false;
	const err = e as { error?: string; name?: string };
	return err.error === 'not-allowed' || err.name === 'NotAllowedError';
}

class ReaderStore {
	bookFolderPath = $state<string | null>(null);
	title = $state('');
	locale = $state('en');
	chunks = $state<Chunk[]>([]);
	currentChunkIndex = $state(0);

	isPlaying = $state(false);
	isLoading = $state(false);
	/** True while an audio service is synthesizing a not-yet-cached unit. */
	isSynthesizing = $state(false);
	error = $state<string | null>(null);
	/** Non-fatal info (e.g. "fell back to device voice"). */
	notice = $state<string | null>(null);

	rate = $state(1);
	service = $state<TtsService>('webspeech');
	voiceId = $state<string | null>(null);
	voices = $state<TtsVoice[]>([]);

	private engine: TtsEngine | null = null;
	private audioEl: HTMLAudioElement | null = null;
	private units: Unit[] = [];
	private speakToken = 0;
	private resumeInPlace = false;
	private fellBack = false;
	private positionSavedForNavigation = false;
	private lastPositionSaveTime = 0;
	private rateRestartTimer: ReturnType<typeof setTimeout> | null = null;
	private mediaSessionSetup = false;
	private disarmResume: (() => void) | null = null;

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

	/** Total number of headings — the book's chapter count (0 if unstructured). */
	get chapterCount(): number {
		let n = 0;
		for (const c of this.chunks) if (c.type === 'heading') n++;
		return n;
	}

	/**
	 * 1-based index of the chapter the current position falls in (the count of
	 * headings at or before it). 0 when sitting in front matter before the first
	 * heading, or when the book has no headings at all.
	 */
	get currentChapter(): number {
		let n = 0;
		const end = Math.min(this.currentChunkIndex, this.chunks.length - 1);
		for (let i = 0; i <= end; i++) {
			if (this.chunks[i]?.type === 'heading') n++;
		}
		return n;
	}

	// -------------------------------------------------------------------------
	// Engine + audio element wiring
	// -------------------------------------------------------------------------

	/** Give the reader the page's <audio> element (used by audio engines). */
	initializeAudio(el: HTMLAudioElement | null) {
		this.audioEl = el;
		if (this.engine && this.engine.kind === 'audio') {
			(this.engine as AudioEngine).setAudio(el);
		}
	}

	private buildEngine() {
		if (this.engine) this.engine.destroy?.();
		this.engine =
			this.service === 'webspeech'
				? new WebSpeechEngine()
				: new AudioEngine(this.service, this.audioEl);
	}

	private rebuildUnits() {
		if (!this.engine || this.engine.kind === 'webspeech') {
			this.units = singletonUnits(this.chunks);
		} else {
			this.units = groupChunks(this.chunks, this.engine.unitMaxChars);
		}
	}

	/** Switch the active TTS service (called from settings/reader controls). */
	async setService(service: TtsService) {
		if (service === this.service && this.engine) return;
		this.pause();
		this.service = service;
		settingsStore.setTtsService(service);
		this.fellBack = false;
		this.notice = null;
		this.resumeInPlace = false;
		this.buildEngine();
		this.rebuildUnits();
		await this.loadVoices();
	}

	// -------------------------------------------------------------------------
	// Loading
	// -------------------------------------------------------------------------

	async loadBook(folderPath: string) {
		this.positionSavedForNavigation = false;
		this.bookFolderPath = folderPath;
		this.isLoading = true;
		this.error = null;
		this.notice = null;
		this.fellBack = false;
		this.currentChunkIndex = 0;
		this.isPlaying = false;
		// Adopt the global default rate + selected service (sliders persist changes back).
		this.rate = settingsStore.ttsRate;
		this.service = settingsStore.ttsService;
		this.buildEngine();

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

		this.rebuildUnits();

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
	 * Load the active engine's voices and resolve the selected voice. Resolves once
	 * voices are available so callers can wait before auto-starting (otherwise the
	 * first unit speaks in the wrong voice). Never throws (missing key -> empty list).
	 */
	async loadVoices(): Promise<void> {
		if (!this.engine) return;
		try {
			this.voices = await this.engine.listVoices(this.locale);
		} catch {
			this.voices = [];
		}
		this.resolveVoice();
	}

	/** Pick the saved/default voice for the active engine. */
	private resolveVoice() {
		const useLocal = !this.engine || this.engine.kind === 'webspeech';
		let preferred: string | null = null;
		if (useLocal) {
			try {
				preferred = localStorage.getItem(VOICE_KEY);
			} catch {
				// ignore
			}
		} else {
			preferred = ttsConfigStore.get(this.service as TtsAudioService).voiceId || null;
		}

		if (preferred && this.voices.some((v) => v.id === preferred)) {
			this.voiceId = preferred;
			return;
		}
		const fallback =
			this.voices.find((v) => v.lang?.toLowerCase().startsWith(this.locale.toLowerCase())) ||
			this.voices[0];
		this.voiceId = fallback?.id ?? null;
		// Persist a freshly chosen audio voice so the server always has one.
		if (!useLocal && this.voiceId && this.voiceId !== preferred) {
			ttsConfigStore.setVoiceId(this.service as TtsAudioService, this.voiceId);
		}
	}

	// -------------------------------------------------------------------------
	// Playback
	// -------------------------------------------------------------------------

	private buildReq(unit: Unit, uIdx: number): SynthRequest {
		const isEleven = this.service === 'elevenlabs';
		const cfg = this.engine?.kind === 'audio' ? ttsConfigStore.get(this.service as TtsAudioService) : null;
		return {
			text: unit.text,
			lang: this.locale,
			voiceId: this.voiceId ?? '',
			rate: this.rate,
			model: cfg?.model || undefined,
			voiceSettings: isEleven ? cfg?.voiceSettings : undefined,
			elfParams: this.service === 'elf' && cfg?.elfCustomize ? cfg.elfParams : undefined,
			previousText: isEleven ? this.units[uIdx - 1]?.text?.slice(-400) : undefined,
			nextText: isEleven ? this.units[uIdx + 1]?.text?.slice(0, 400) : undefined,
			bookPath: this.bookFolderPath ?? undefined
		};
	}

	private prefetchAhead(uIdx: number) {
		if (!this.engine?.prefetch) return;
		for (let k = 1; k <= PREFETCH_AHEAD; k++) {
			const u = this.units[uIdx + k];
			if (!u) break;
			this.engine.prefetch(this.buildReq(u, uIdx + k));
		}
	}

	/** Speak the unit containing the current position and chain to the next. */
	private async speakCurrent() {
		if (!this.engine) return;
		if (this.currentChunkIndex < 0 || this.currentChunkIndex >= this.chunks.length) {
			this.isPlaying = false;
			return;
		}
		this.resumeInPlace = false;
		const myToken = ++this.speakToken;
		this.engine.stop();

		const uIdx = unitForChunk(this.units, this.currentChunkIndex);
		const unit = this.units[uIdx];
		if (!unit) {
			this.isPlaying = false;
			return;
		}
		// Snap canonical position to the unit start so progress/heading/saves align.
		this.currentChunkIndex = unit.startIndex;

		this.isPlaying = true;
		this.setMediaSessionState('playing');
		this.updateMediaSessionMetadata();
		const isAudio = this.engine.kind === 'audio';
		if (isAudio) this.isSynthesizing = true;

		try {
			await this.engine.speak(
				this.buildReq(unit, uIdx),
				() => myToken === this.speakToken,
				() => this.onUnitEnded(myToken, unit),
				(e) => this.onSpeakError(myToken, e)
			);
		} catch (e) {
			this.onSpeakError(myToken, e);
		} finally {
			if (myToken === this.speakToken) this.isSynthesizing = false;
		}

		if (myToken === this.speakToken) this.prefetchAhead(uIdx);
	}

	private onUnitEnded(token: number, unit: Unit) {
		if (token !== this.speakToken) return;
		const nextStart = unit.endIndex + 1;
		if (nextStart < this.chunks.length) {
			this.currentChunkIndex = nextStart;
			this.throttledSavePosition();
			this.speakCurrent();
		} else {
			this.isPlaying = false;
			this.savePosition();
		}
	}

	private onSpeakError(token: number, e: unknown) {
		if (token !== this.speakToken) return;
		this.isSynthesizing = false;
		// Autoplay blocked (no user gesture, e.g. after a page refresh): don't surface
		// an error or fall back to Web Speech (which can't autoplay either). Stay paused
		// and resume from the saved position on the user's next interaction, mirroring
		// the audio player. (Strongest right after a domain change, which resets the
		// browser's per-origin autoplay grant.)
		if (isAutoplayBlocked(e)) {
			this.isPlaying = false;
			this.setMediaSessionState('paused');
			this.armResumeOnGesture();
			return;
		}
		// An audio provider failed mid-read: fall back to Web Speech for the session.
		if (this.engine?.kind === 'audio' && !this.fellBack) {
			this.fellBack = true;
			this.notice = t('reader.ttsFellBack');
			const wasPlaying = this.isPlaying;
			this.engine.destroy?.();
			this.engine = new WebSpeechEngine();
			this.rebuildUnits();
			this.loadVoices().then(() => {
				if (wasPlaying) this.speakCurrent();
			});
			return;
		}
		this.error = t('reader.speakFailed');
		this.isPlaying = false;
	}

	private canResumeInPlace(): boolean {
		return this.engine?.kind === 'audio' && this.resumeInPlace && !!this.audioEl?.src;
	}

	/**
	 * After a page refresh there's no user gesture, so the browser blocks the
	 * <audio> element / speechSynthesis from starting (autoplay policy — strongest
	 * on a freshly-served origin, e.g. right after a domain change). Resume reading
	 * from the saved position on the user's next interaction instead of staying
	 * silently paused. One-shot; disarmed once playback starts or on destroy.
	 */
	private armResumeOnGesture() {
		if (typeof window === 'undefined') return;
		this.disarmResume?.();
		const resume = () => {
			this.disarmResume?.();
			this.play();
		};
		// pointerdown covers mouse / touch / pen; keyboard users resume via Space.
		window.addEventListener('pointerdown', resume, { once: true });
		this.disarmResume = () => {
			window.removeEventListener('pointerdown', resume);
			this.disarmResume = null;
		};
	}

	play() {
		if (this.chunks.length === 0) return;
		this.disarmResume?.();
		this.error = null;
		if (this.canResumeInPlace()) {
			this.isPlaying = true;
			this.setMediaSessionState('playing');
			this.audioEl?.play().catch(() => {});
			return;
		}
		this.speakCurrent();
	}

	/** Pause. Web Speech cancels (re-speaks on resume); audio pauses in place. */
	pause() {
		this.disarmResume?.();
		this.isPlaying = false;
		if (this.engine?.kind === 'audio') {
			this.resumeInPlace = true;
			this.audioEl?.pause();
		} else {
			this.speakToken++;
			this.engine?.stop();
		}
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
			this.engine?.stop();
			this.resumeInPlace = false;
			this.isPlaying = false;
		}
		this.savePosition();
	}

	/** Next/prev operate by unit (== sentence for Web Speech, == grouped unit for audio). */
	next() {
		const uIdx = unitForChunk(this.units, this.currentChunkIndex);
		const target = this.units[uIdx + 1];
		if (target) this.seekToChunk(target.startIndex);
	}

	prev() {
		const uIdx = unitForChunk(this.units, this.currentChunkIndex);
		const target = this.units[uIdx - 1];
		this.seekToChunk(target ? target.startIndex : 0);
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
		if (this.engine?.liveRate) {
			// Retunes live (remote audio services via playbackRate) — no re-synth, no debounce.
			this.engine.setRate(this.rate);
			return;
		}
		// Engines that bake rate into the unit (Web Speech's utterance.rate, ELF's
		// native eciSpeed synthesis) can't retune a live unit — debounce (the slider
		// fires rapidly), then re-speak the current sentence (if playing) or a short
		// preview (if paused) so the new rate is always audible immediately.
		if (this.rateRestartTimer) clearTimeout(this.rateRestartTimer);
		this.rateRestartTimer = setTimeout(() => {
			if (this.isPlaying) this.speakCurrent();
			else this.previewVoice();
		}, 250);
	}

	setVoice(voiceId: string) {
		this.voiceId = voiceId;
		this.resumeInPlace = false;
		if (!this.engine || this.engine.kind === 'webspeech') {
			try {
				localStorage.setItem(VOICE_KEY, voiceId);
			} catch {
				// ignore
			}
		} else {
			ttsConfigStore.setVoiceId(this.service as TtsAudioService, voiceId);
		}
		// If we're mid-read, re-speak the current sentence so the new voice takes
		// effect immediately. When paused we deliberately stay silent — the user
		// previews on demand via the "Test voice" button (testVoice()).
		if (this.isPlaying) this.speakCurrent();
	}

	/** Speak the preview sample in the current voice + rate — the "Test voice" button. */
	testVoice() {
		this.previewVoice();
	}

	/**
	 * Update the book's language for the current session (e.g. after the user
	 * corrects it in the Book info modal). Affects the ElevenLabs `language_code`
	 * and future voice listings; the chunk positions are untouched. Persistence
	 * is handled by the modal's PUT — this only reflects it live.
	 */
	setLocale(locale: string) {
		this.locale = locale;
	}

	/**
	 * Speak a fixed preview sentence (in Ecobox's current UI language) at the
	 * chosen voice + rate. Used by the rate slider (while paused) and the "Test
	 * voice" button. It deliberately does NOT read the book, change the play
	 * state, or move position.
	 */
	private async previewVoice() {
		if (!this.engine) return;
		const myToken = ++this.speakToken;
		this.engine.stop();
		this.resumeInPlace = false;
		const cfg = this.engine.kind === 'audio' ? ttsConfigStore.get(this.service as TtsAudioService) : null;
		const req: SynthRequest = {
			text: t('reader.voicePreviewSample'),
			lang: this.locale,
			voiceId: this.voiceId ?? '',
			rate: this.rate,
			model: cfg?.model || undefined,
			voiceSettings: this.service === 'elevenlabs' ? cfg?.voiceSettings : undefined,
			elfParams: this.service === 'elf' && cfg?.elfCustomize ? cfg.elfParams : undefined
		};
		try {
			await this.engine.speak(
				req,
				() => myToken === this.speakToken,
				() => {},
				() => {}
			);
		} catch {
			// ignore preview errors
		}
	}

	// -------------------------------------------------------------------------
	// Find in book
	// -------------------------------------------------------------------------

	find(query: string): { results: Chunk[]; total: number } {
		const q = foldForSearch(query.trim());
		if (!q) return { results: [], total: 0 };
		const matches = this.chunks.filter((c) => foldForSearch(c.text).includes(q));
		return { results: matches, total: matches.length };
	}

	// -------------------------------------------------------------------------
	// Media Session (now backed by a real <audio> element for audio engines)
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
		this.disarmResume?.();
		const wasSaved = this.positionSavedForNavigation;
		const capturedIndex = this.currentChunkIndex;
		this.positionSavedForNavigation = true;
		this.speakToken++;
		this.engine?.destroy?.();
		this.isPlaying = false;
		this.isSynthesizing = false;
		if (this.rateRestartTimer) clearTimeout(this.rateRestartTimer);
		if (!wasSaved && this.bookFolderPath) {
			this.doSavePosition(capturedIndex);
		}
		this.lastPositionSaveTime = 0;
	}
}

export const readerStore = new ReaderStore();
