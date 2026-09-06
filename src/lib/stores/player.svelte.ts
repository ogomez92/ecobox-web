import type { Chapter, ChapteredBookManifest, ChapteredFile } from '$lib/types';
import { settingsStore } from './settings.svelte';
import { audioEffects } from '$lib/services/audioEffects';
import { t } from '$lib/i18n/index.svelte';

class PlayerStore {
	// Playback state
	isPlaying = $state(false);
	currentTime = $state(0);
	duration = $state(0);
	playbackRate = $state(1);
	volume = $state(1);
	isLoading = $state(false);
	error = $state<string | null>(null);

	// Current media
	currentFile = $state<string | null>(null);
	currentTitle = $state<string>('');
	chapters = $state<Chapter[]>([]);
	currentChapterIndex = $state(-1);

	// Chaptered folder / DAISY state
	isChapteredPlayback = $state(false);
	chapteredFolderPath = $state<string | null>(null);
	/** The book's files in playback order, each with its duration and timeline offset. */
	chapteredFileList = $state<ChapteredFile[]>([]);
	currentFileIndex = $state(-1);
	chapteredTotalDuration = $state(0);

	/** Just the paths, in playback order. */
	chapteredFiles = $derived(this.chapteredFileList.map((file) => file.path));
	/** Where each file starts on the book timeline — what makes positions absolute. */
	private fileStartTimes = $derived(
		new Map(this.chapteredFileList.map((file) => [file.path, file.startTime]))
	);

	// Radio stream state
	isRadioStream = $state(false);
	radioStreamUrl = $state<string | null>(null);

	// Settings
	seekInterval = $state(5);
	longSeekInterval = $state(30);

	// Audio element reference
	private audio: HTMLAudioElement | null = null;
	private mediaSessionSetup = false;
	private positionSavedForNavigation = false;
	private switchingFiles = false; // Flag to prevent save during file switch
	private lastPositionSaveTime = 0; // Track last save time for throttling
	private disarmResume: (() => void) | null = null; // Removes the pending resume-on-gesture listener

	// Force playback on the next loadFile even when autoplay is off — set by the
	// view before a Winamp next/prev-track switch or auto-advance so the new track
	// keeps playing. One-shot: consumed (reset to false) on the next load.
	playOnNextLoad = false;
	// Fired when a single (non-chaptered, non-radio) track reaches its end, so the
	// view can auto-advance to the next file in the folder when the user opted in.
	// Real next/prev-track navigation lives in the view (it owns routing + siblings).
	onTrackEnded: (() => void) | null = null;

	get currentChapter(): Chapter | null {
		if (this.currentChapterIndex >= 0 && this.currentChapterIndex < this.chapters.length) {
			return this.chapters[this.currentChapterIndex];
		}
		return null;
	}

	get progress(): number {
		if (this.duration <= 0) return 0;
		return (this.currentTime / this.duration) * 100;
	}

	get remainingTime(): number {
		return Math.max(0, this.duration - this.currentTime);
	}

	initialize(audioElement: HTMLAudioElement) {
		this.audio = audioElement;
		this.setupEventListeners();
		this.setupMediaSession();
	}

	private setupEventListeners() {
		if (!this.audio) return;

		this.audio.addEventListener('loadstart', () => {
			this.isLoading = true;
			this.error = null;
		});

		this.audio.addEventListener('loadedmetadata', () => {
			this.duration = this.audio?.duration || 0;
			this.isLoading = false;
		});

		this.audio.addEventListener('canplay', () => {
			this.isLoading = false;
		});

		this.audio.addEventListener('play', () => {
			this.isPlaying = true;
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'playing';
			}
			this.updateMediaSessionPosition();
			// Resume AudioContext if needed (e.g. after iOS background resume)
			audioEffects.resumeContext().catch(() => {});
		});

		this.audio.addEventListener('pause', () => {
			this.isPlaying = false;
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
			}
			// Suspend AudioContext so the OS audio session is released — keeps
			// paused Web Audio from ducking or crackling other apps' playback.
			audioEffects.suspendContext().catch(() => {});
			// Always save position on pause (works on iOS background/lock screen)
			if (!this.positionSavedForNavigation && this.audio && this.currentTime > 0) {
				this.savePosition();
			}
		});

		this.audio.addEventListener('ended', () => {
			this.isPlaying = false;
			this.handleEnded();
		});

		this.audio.addEventListener('timeupdate', () => {
			this.currentTime = this.audio?.currentTime || 0;
			this.updateCurrentChapter();
			// Save position every 5 seconds during playback
			// Using timeupdate instead of setInterval because it works on iOS in background
			this.throttledSavePosition();
		});

		this.audio.addEventListener('error', () => {
			// A deliberate radio teardown (see stopRadioStream) drops the src, which
			// fires a synthetic error with no real failure — ignore it. Genuine stream
			// errors always keep the src attribute set.
			if (this.isRadioStream && !this.audio?.getAttribute('src')) return;
			this.isLoading = false;
			this.error = t('player.loadFailed');
		});

		this.audio.addEventListener('volumechange', () => {
			// In graph mode the element is pinned to 1 and the master gain is the
			// authority, so don't let the element clobber the logical volume.
			if (audioEffects.isWebAudioConnected()) return;
			this.volume = this.audio?.volume ?? 1;
		});

		this.audio.addEventListener('ratechange', () => {
			this.playbackRate = this.audio?.playbackRate || 1;
		});
	}

	private setupMediaSession() {
		if (this.mediaSessionSetup || !('mediaSession' in navigator)) return;

		navigator.mediaSession.setActionHandler('play', () => this.play());
		navigator.mediaSession.setActionHandler('pause', () => this.pause());
		navigator.mediaSession.setActionHandler('seekbackward', () => this.seekRelative(-this.seekInterval));
		navigator.mediaSession.setActionHandler('seekforward', () => this.seekRelative(this.seekInterval));
		navigator.mediaSession.setActionHandler('previoustrack', () => this.previousChapter());
		navigator.mediaSession.setActionHandler('nexttrack', () => this.nextChapter());
		navigator.mediaSession.setActionHandler('seekto', (details) => {
			// Only seek if we have a valid time and audio is loaded
			if (details.seekTime !== undefined && details.seekTime >= 0 && this.duration > 0) {
				this.seek(details.seekTime); // seek() saves position
			}
		});

		this.mediaSessionSetup = true;
	}

	private updateMediaSessionMetadata() {
		if (!('mediaSession' in navigator)) return;

		navigator.mediaSession.metadata = new MediaMetadata({
			title: this.currentChapter?.title || this.currentTitle,
			artist: 'Ecobox',
			album: this.currentTitle
		});
	}

	private updateMediaSessionPosition() {
		if (!('mediaSession' in navigator) || !this.duration || this.isRadioStream) return;

		try {
			navigator.mediaSession.setPositionState({
				duration: this.duration,
				playbackRate: this.playbackRate,
				position: Math.min(this.currentTime, this.duration)
			});
		} catch {
			// Ignore errors (can happen if duration is invalid)
		}
	}

	async loadFile(filePath: string, startPosition: number = 0) {
		if (!this.audio) return;

		// Reset navigation save flag for new file
		this.positionSavedForNavigation = false;

		this.currentFile = filePath;
		this.currentTitle = filePath.split('/').pop() || 'Unknown';
		this.chapters = [];
		this.currentChapterIndex = -1;
		this.error = null;
		this.isRadioStream = false;
		this.radioStreamUrl = null;

		// Load saved metadata
		try {
			const response = await fetch(`/api/media/metadata?path=${encodeURIComponent(filePath)}`);
			if (response.ok) {
				const metadata = await response.json();
				if (metadata.lastPlayedPosition && startPosition === 0) {
					startPosition = metadata.lastPlayedPosition;
				}
			}
		} catch {
			// Ignore metadata loading errors
		}

		// Load chapters
		this.loadChapters(filePath);

		// Set the audio source
		this.audio.src = `/api/media/${encodeURIComponent(filePath)}`;

		// Wait for metadata to load, then seek and optionally play
		this.audio.addEventListener('loadedmetadata', () => {
			if (this.audio) {
				if (startPosition > 0) {
					this.audio.currentTime = startPosition;
				}
				// Play if autoplay is on, or if a track switch asked us to keep playing.
				const shouldPlay = settingsStore.autoplay || this.playOnNextLoad;
				this.playOnNextLoad = false;
				if (shouldPlay) {
					// Browser blocks autoplay without a user gesture (e.g. after a refresh).
					// Resume from the saved position on the next interaction instead.
					this.audio.play().catch(() => this.armResumeOnGesture());
				}
			}
		}, { once: true });

		this.updateMediaSessionMetadata();
	}

	async loadChapters(filePath: string) {
		try {
			const response = await fetch(`/api/media/chapters?path=${encodeURIComponent(filePath)}`);
			if (response.ok) {
				const data = await response.json();
				if (data.chapters && data.chapters.length > 0) {
					this.chapters = data.chapters;
					this.updateCurrentChapter();
				}
			}
		} catch {
			// Ignore chapter loading errors
		}
	}

	/**
	 * Open a DAISY book or chaptered folder.
	 *
	 * The manifest (`/api/chaptered/book`) carries chapters, the ordered files with
	 * their durations and timeline offsets, and the saved position in one response.
	 * Callers that already fetched it — the play page does, to decide between a file
	 * and a book — pass it in rather than making the server parse the book twice.
	 */
	async loadChapteredFolder(folderPath: string, manifest?: ChapteredBookManifest) {
		if (!this.audio) return;

		// Reset navigation save flag for new file
		this.positionSavedForNavigation = false;

		this.isChapteredPlayback = true;
		this.chapteredFolderPath = folderPath;
		this.currentTitle = folderPath.split('/').pop() || 'Unknown';
		this.chapters = [];
		this.currentChapterIndex = -1;
		this.error = null;
		this.isRadioStream = false;
		this.radioStreamUrl = null;

		let book = manifest;
		if (!book) {
			try {
				const response = await fetch(`/api/chaptered/book?path=${encodeURIComponent(folderPath)}`);
				if (response.ok) book = await response.json();
			} catch {
				// Fall through to the empty-book error below
			}
		}

		this.chapteredFileList = book?.files ?? [];
		if (this.chapteredFileList.length === 0) {
			this.error = t('player.noFiles');
			return;
		}

		this.chapters = book?.chapters ?? [];
		this.chapteredTotalDuration = book?.totalDuration || book?.metadata?.totalDuration || 0;
		if (book?.title) this.currentTitle = book.title;

		// Resume where the book was left, as long as that file is still part of it.
		const saved = book?.metadata;
		const files = this.chapteredFiles;
		let startFilePath = saved?.currentFilePath ?? null;
		let startPosition = saved?.currentFilePosition ?? 0;
		if (!startFilePath || !files.includes(startFilePath)) {
			startFilePath = files[0];
			startPosition = 0;
		}

		this.currentFileIndex = files.indexOf(startFilePath);

		// Load the starting file
		await this.loadFileInternal(startFilePath, startPosition);
		this.updateCurrentChapter();
		this.updateMediaSessionMetadata();
	}

	// Internal method to load a file without resetting chaptered state
	private async loadFileInternal(filePath: string, startPosition: number = 0) {
		if (!this.audio) return;

		this.currentFile = filePath;
		this.error = null;

		// Set the audio source using the path relative to media root
		const relativePath = this.getRelativePath(filePath);
		this.audio.src = `/api/media/${encodeURIComponent(relativePath)}`;

		// Wait for metadata to load, then seek and optionally play
		const audio = this.audio;
		return new Promise<void>((resolve) => {
			const onLoadedMetadata = () => {
				if (audio) {
					this.duration = audio.duration || 0;
					if (startPosition > 0 && startPosition < this.duration) {
						audio.currentTime = startPosition;
					}
					if (settingsStore.autoplay && !this.switchingFiles) {
						// Autoplay blocked (no gesture, e.g. after a refresh) → resume on the
						// next interaction rather than sitting paused.
						audio.play().catch(() => this.armResumeOnGesture());
					} else if (this.switchingFiles && this.isPlaying) {
						// Continue playing after file switch
						audio.play().catch(() => {});
					}
				}
				resolve();
			};
			audio.addEventListener('loadedmetadata', onLoadedMetadata, { once: true });
		});
	}

	// Get path relative to media root (for chaptered files which may have absolute paths)
	private getRelativePath(filePath: string): string {
		// If the path starts with the chaptered folder path, extract relative part
		// For DAISY, chapters already have full paths from the server
		// The API expects paths relative to MEDIA_ROOT
		return filePath;
	}

	async loadRadio(filePath: string) {
		if (!this.audio) return;

		this.currentFile = filePath;
		this.isRadioStream = true;
		this.chapters = [];
		this.currentChapterIndex = -1;
		this.error = null;
		this.duration = 0;

		try {
			const response = await fetch(`/api/radio?path=${encodeURIComponent(filePath)}`);
			if (response.ok) {
				const data = await response.json();
				this.radioStreamUrl = data.url;
				this.currentTitle = data.name || 'Radio Station';

				// Set the audio source to the stream URL
				this.audio.src = data.url;

				// Wait for stream to be ready, then optionally autoplay
				this.audio.addEventListener('canplay', () => {
					if (this.audio && settingsStore.autoplay) {
						this.audio.play().catch(() => this.armResumeOnGesture());
					}
				}, { once: true });

				this.updateMediaSessionMetadata();
			} else {
				this.error = t('player.radioFailed');
			}
		} catch {
			this.error = t('player.radioFailed');
		}
	}

	/**
	 * After a page refresh there's no user gesture, so the browser blocks
	 * audio.play() (autoplay policy — strongest on a freshly-served origin with no
	 * media-engagement history, e.g. right after a domain change). Rather than
	 * sitting silently paused, resume from the saved position on the user's very
	 * next interaction anywhere on the page. One-shot and re-armed per load;
	 * disarmed as soon as playback actually starts (see play()) or on destroy.
	 */
	private armResumeOnGesture() {
		if (typeof window === 'undefined') return;
		this.disarmResume?.();
		const resume = () => {
			this.disarmResume?.();
			this.play();
		};
		// pointerdown covers mouse / touch / pen. Keyboard users already resume via
		// Space (togglePlayPause), so we deliberately don't listen for keydown — that
		// would double-fire with the page's own Space handler and cancel itself out.
		window.addEventListener('pointerdown', resume, { once: true });
		this.disarmResume = () => {
			window.removeEventListener('pointerdown', resume);
			this.disarmResume = null;
		};
	}

	async play() {
		// Playback is starting for real — drop any pending resume-on-gesture listener.
		this.disarmResume?.();
		// Live streams ALWAYS (re)connect at the live edge on play — never resume from
		// a stale buffer (which would replay old audio with a growing delay). Reassigning
		// src + load() forces a fresh connection each time play is pressed. Only the
		// user-gesture play() path hits this; initial autoplay runs through loadRadio.
		if (this.isRadioStream && this.audio && this.radioStreamUrl) {
			this.audio.src = this.radioStreamUrl;
			this.audio.load();
		}
		// Call play() synchronously first — on iOS, awaiting anything before play()
		// loses the user-gesture context from Media Session handlers (control center),
		// causing play to fail when the app is backgrounded.
		const playPromise = this.audio?.play();

		// Resume AudioContext after starting playback (non-critical for iOS where
		// Web Audio is typically not connected)
		audioEffects.resumeContext().catch(() => {});

		playPromise?.catch((err) => {
			// Only ignore NotAllowedError (autoplay policy), log others
			if (err.name !== 'NotAllowedError') {
				console.error('Play error:', err);
			}
		});
	}

	pause() {
		// A live stream must never truly "pause": a paused <audio> stream holds a stale
		// buffer that plays back with a growing delay when resumed. Tear the stream down
		// so the next play() reconnects at the live edge (see play()).
		if (this.isRadioStream) {
			this.stopRadioStream();
			return;
		}
		// Only a pause that actually stops playback rewinds: pause() can be called on
		// an already-paused player (the sleep timer, a lock-screen button), and each
		// of those must not walk the position further back.
		const wasPlaying = this.audio ? !this.audio.paused : false;
		this.audio?.pause();
		if (wasPlaying) this.applySeekBackOnPause();
	}

	/**
	 * Rewind a few seconds when playback is paused, so resuming replays a little
	 * context (opt-in — `seekBackOnPause: 0` means off).
	 *
	 * Runs *after* audio.pause() so nothing is heard at the rewound point, and
	 * writes `currentTime` itself rather than waiting for the element's own
	 * `timeupdate`: the position save that rides on the pause event reads it, and
	 * the rewound point is what should be restored on the next open.
	 *
	 * In a chaptered book it clamps at the start of the *current* file — a pause
	 * two seconds into a chapter rewinds to its beginning, never back into the
	 * previous file.
	 */
	private applySeekBackOnPause() {
		const seconds = settingsStore.seekBackOnPause;
		if (!seconds || !this.audio || this.isRadioStream) return;

		const target = Math.max(0, this.audio.currentTime - seconds);
		this.currentTime = target;
		this.seek(target);
		this.updateCurrentChapter();
	}

	// Fully stop a live stream: pause, then drop the source so the browser closes the
	// connection and discards the buffer. removeAttribute (not src='') yields a clean
	// NETWORK_EMPTY state; src='' would resolve to the page URL and error.
	private stopRadioStream() {
		if (!this.audio) return;
		this.audio.pause();
		this.audio.removeAttribute('src');
		this.audio.load();
		this.isPlaying = false;
		this.isLoading = false;
	}

	togglePlayPause() {
		if (this.isPlaying) {
			this.pause();
		} else {
			this.play();
		}
	}

	seek(time: number) {
		if (this.audio) {
			// Only clamp to duration if duration is known (> 0)
			const clampedTime = this.duration > 0
				? Math.max(0, Math.min(time, this.duration))
				: Math.max(0, time);
			this.audio.currentTime = clampedTime;
			this.savePosition();
			this.updateMediaSessionPosition();
		}
	}

	seekRelative(delta: number) {
		this.seek(this.currentTime + delta);
	}

	seekToPercent(percent: number) {
		this.seek((percent / 100) * this.duration);
	}

	setVolume(volume: number) {
		const clamped = Math.max(0, Math.min(1, volume));
		this.volume = clamped;
		// Keep the Web Audio master gain in sync (it's the authority once the
		// graph is connected — e.g. effects on or casting — and is what reaches
		// the cast stream). When the graph is connected the element is pinned to
		// 1; otherwise the element's own volume is the only control.
		audioEffects.setOutputVolume(clamped);
		if (this.audio) {
			this.audio.volume = audioEffects.isWebAudioConnected() ? 1 : clamped;
		}
	}

	setPlaybackRate(rate: number) {
		if (this.audio) {
			this.audio.playbackRate = Math.max(0.5, Math.min(2, rate));
			this.updateMediaSessionPosition();
		}
	}

	setChapters(chapters: Chapter[]) {
		this.chapters = chapters;
		this.updateCurrentChapter();
	}

	private updateCurrentChapter() {
		if (this.chapters.length === 0) {
			this.currentChapterIndex = -1;
			return;
		}

		// Chapter starts are absolute across the book, so the position has to be too.
		const absoluteTime = this.absoluteTime;

		for (let i = this.chapters.length - 1; i >= 0; i--) {
			if (absoluteTime >= this.chapters[i].startTime) {
				if (this.currentChapterIndex !== i) {
					this.currentChapterIndex = i;
					this.updateMediaSessionMetadata();
				}
				return;
			}
		}
		this.currentChapterIndex = 0;
	}

	async seekToChapter(index: number) {
		if (index < 0 || index >= this.chapters.length) return;

		const chapter = this.chapters[index];
		// The server gives the in-file offset directly; subtracting the file's own
		// start is the fallback for chapter data that predates it.
		const positionInFile = Math.max(
			0,
			chapter.fileStartTime ?? chapter.startTime - this.getFileStartTime(chapter.filePath)
		);

		if (!this.isChapteredPlayback) {
			this.seek(chapter.startTime);
			return;
		}

		await this.seekToBookPosition(chapter.filePath, positionInFile);
		this.currentChapterIndex = index;
		this.updateMediaSessionMetadata();
	}

	/**
	 * Jump to an offset inside one specific file of the book, switching files when
	 * needed. Chapters and bookmarks both address positions this way — a file plus
	 * an offset in it — because a bare time means nothing across a multi-file book.
	 */
	async seekToBookPosition(filePath: string | undefined, positionInFile: number) {
		const target = Math.max(0, positionInFile);

		if (!this.isChapteredPlayback || !filePath || filePath === this.currentFile) {
			this.seek(target);
			return;
		}

		const index = this.chapteredFiles.indexOf(filePath);
		if (index < 0) return;

		await this.saveChapteredPosition();
		this.currentFileIndex = index;

		this.switchingFiles = true;
		await this.loadFileInternal(filePath, target);
		this.switchingFiles = false;

		this.updateCurrentChapter();
		this.updateMediaSessionMetadata();
	}

	/** Where a file begins on the book timeline (0 for single-file playback). */
	private getFileStartTime(filePath?: string): number {
		if (!filePath) return 0;
		return this.fileStartTimes.get(filePath) ?? 0;
	}

	/**
	 * Position on the book's timeline: the offset inside the current file plus
	 * everything before it. Equals `currentTime` for ordinary single-file playback.
	 */
	get absoluteTime(): number {
		return this.absoluteTimeFor(this.currentFile, this.currentTime);
	}

	/** Place an offset inside one of the book's files on the book timeline. */
	absoluteTimeFor(filePath: string | null | undefined, timeInFile: number): number {
		if (!this.isChapteredPlayback) return timeInFile;
		return this.getFileStartTime(filePath ?? undefined) + timeInFile;
	}

	previousChapter() {
		// If we're more than 3 seconds into the chapter, restart it
		// Otherwise, go to the previous chapter
		const chapter = this.currentChapter;

		if (this.isChapteredPlayback && chapter) {
			// Both sides of this comparison live on the book timeline.
			const timeIntoChapter = this.absoluteTime - chapter.startTime;

			if (timeIntoChapter > 3) {
				this.seekToChapter(this.currentChapterIndex);
			} else if (this.currentChapterIndex > 0) {
				this.seekToChapter(this.currentChapterIndex - 1);
			} else {
				this.seekToChapter(0);
			}
		} else {
			if (chapter && this.currentTime - chapter.startTime > 3) {
				this.seek(chapter.startTime);
			} else if (this.currentChapterIndex > 0) {
				this.seekToChapter(this.currentChapterIndex - 1);
			} else {
				this.seek(0);
			}
		}
	}

	nextChapter() {
		if (this.currentChapterIndex < this.chapters.length - 1) {
			this.seekToChapter(this.currentChapterIndex + 1);
		}
	}

	private async handleEnded() {
		// Don't save if we're navigating away (position already saved)
		if (!this.positionSavedForNavigation) {
			this.savePosition();
		}

		// Auto-advance to next file in chaptered playback
		if (this.isChapteredPlayback && this.chapteredFiles.length > 0) {
			const nextIndex = this.currentFileIndex + 1;
			if (nextIndex < this.chapteredFiles.length) {
				// Switch to next file
				this.currentFileIndex = nextIndex;
				const nextFile = this.chapteredFiles[nextIndex];

				this.switchingFiles = true;
				// Start from beginning of next file but keep playing
				await this.loadFileInternal(nextFile, 0);
				this.switchingFiles = false;

				// Continue playing
				this.audio?.play().catch(() => {});

				// Update chapter index to first chapter of new file
				this.updateCurrentChapter();
				this.updateMediaSessionMetadata();
			}
		} else if (!this.isChapteredPlayback && !this.isRadioStream) {
			// Single regular file ended. Let the view auto-advance to the next file
			// in the folder when the user enabled it (radio streams never "end").
			this.onTrackEnded?.();
		}
	}

	// Throttled position save - called on every timeupdate but only saves every 5 seconds
	// Using timeupdate instead of setInterval because it works on iOS in background
	private throttledSavePosition() {
		if (this.positionSavedForNavigation || !this.isPlaying) return;

		const now = Date.now();
		if (now - this.lastPositionSaveTime >= 5000) {
			this.lastPositionSaveTime = now;
			this.savePosition();
		}
	}

	private async doSavePosition(
		capturedTime?: number,
		capturedFile?: string | null,
		capturedDuration?: number
	) {
		// Use captured values if provided, otherwise use current state
		const time = capturedTime ?? this.currentTime;
		const file = capturedFile ?? this.currentFile;
		const duration = capturedDuration ?? this.duration;

		if (!file || this.isRadioStream || this.switchingFiles) return;

		// For chaptered playback, save folder-level position
		if (this.isChapteredPlayback && this.chapteredFolderPath) {
			await this.saveChapteredPosition(capturedTime);
			return;
		}

		// Regular single-file position save
		try {
			await fetch('/api/media/metadata', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: file,
					lastPlayedPosition: time,
					duration: duration
				})
			});
		} catch {
			// Ignore save errors
		}
	}

	async saveChapteredPosition(capturedTime?: number) {
		if (!this.chapteredFolderPath || !this.currentFile || this.switchingFiles) return;

		const time = capturedTime ?? this.currentTime;

		try {
			await fetch('/api/chaptered/metadata', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					folderPath: this.chapteredFolderPath,
					currentFilePath: this.currentFile,
					currentFilePosition: time,
					totalDuration: this.chapteredTotalDuration
				})
			});
		} catch {
			// Ignore save errors
		}
	}

	async savePosition() {
		// Don't save if already saved for navigation
		if (this.positionSavedForNavigation) return;
		await this.doSavePosition();
	}

	// Save position and mark as saved for navigation (prevents other saves)
	async savePositionForNavigation() {
		// Don't save again if already saved for this navigation
		if (this.positionSavedForNavigation) return;

		// Capture position immediately before any async operations
		// (timeupdate events during cleanup can reset currentTime to 0)
		const capturedTime = this.currentTime;
		const capturedFile = this.currentFile;
		const capturedDuration = this.duration;

		// Set flag FIRST to block any concurrent saves (like pause events)
		this.positionSavedForNavigation = true;
		await this.doSavePosition(capturedTime, capturedFile, capturedDuration);
	}

	destroy() {
		// Drop any pending resume-on-gesture listener so it can't fire after teardown.
		this.disarmResume?.();
		// Block any further saves from queued events
		const wasSavedForNavigation = this.positionSavedForNavigation;
		this.positionSavedForNavigation = true; // Keep it true to block queued events

		// Set audio to null to prevent event handlers from accessing it
		this.audio = null;
		this.isPlaying = false; // Stop throttled saves from firing

		// Only save if we haven't already saved for navigation
		if (!wasSavedForNavigation) {
			this.savePosition();
		}

		this.lastPositionSaveTime = 0;

		// Reset chaptered state
		this.isChapteredPlayback = false;
		this.chapteredFolderPath = null;
		this.chapteredFileList = [];
		this.currentFileIndex = -1;
		this.chapteredTotalDuration = 0;
		this.switchingFiles = false;
	}
}

export const playerStore = new PlayerStore();
