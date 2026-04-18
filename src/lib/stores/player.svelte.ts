import type { Chapter } from '$lib/types';
import { settingsStore } from './settings.svelte';
import { audioEffects } from '$lib/services/audioEffects';

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
	chapteredFiles = $state<string[]>([]); // Ordered list of audio files
	currentFileIndex = $state(-1);
	chapteredTotalDuration = $state(0);

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
			this.isLoading = false;
			this.error = 'Failed to load audio';
		});

		this.audio.addEventListener('volumechange', () => {
			this.volume = this.audio?.volume || 1;
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
				if (settingsStore.autoplay) {
					// Catch autoplay errors (browser blocks autoplay without user interaction)
					this.audio.play().catch(() => {
						// Silently ignore - user will need to click play manually
					});
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

	async loadChapteredFolder(folderPath: string) {
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

		let startFilePath: string | null = null;
		let startPosition = 0;

		// Load saved chaptered metadata (folder-level position)
		try {
			const response = await fetch(`/api/chaptered/metadata?path=${encodeURIComponent(folderPath)}`);
			if (response.ok) {
				const metadata = await response.json();
				if (metadata.currentFilePath) {
					startFilePath = metadata.currentFilePath;
					startPosition = metadata.currentFilePosition || 0;
				}
				if (metadata.totalDuration) {
					this.chapteredTotalDuration = metadata.totalDuration;
				}
			}
		} catch {
			// Ignore metadata loading errors
		}

		// Load chapters (this also returns file list for DAISY)
		try {
			const response = await fetch(`/api/media/chapters?path=${encodeURIComponent(folderPath)}`);
			if (response.ok) {
				const data = await response.json();
				if (data.chapters && data.chapters.length > 0) {
					this.chapters = data.chapters;

					// Extract unique file paths from chapters
					const files = data.chapters
						.filter((ch: Chapter) => ch.filePath)
						.map((ch: Chapter) => ch.filePath as string);
					this.chapteredFiles = [...new Set(files)] as string[];

					if (data.totalDuration) {
						this.chapteredTotalDuration = data.totalDuration;
					}
					if (data.title) {
						this.currentTitle = data.title;
					}
				}
			}
		} catch {
			// Ignore chapter loading errors
		}

		// If no chapters with files, try to get audio files directly
		if (this.chapteredFiles.length === 0) {
			try {
				const response = await fetch(`/api/files?path=${encodeURIComponent(folderPath)}`);
				if (response.ok) {
					const data = await response.json();
					const audioExtensions = ['.mp3', '.m4a', '.m4b', '.wav', '.aac', '.flac'];
					this.chapteredFiles = data.files
						.filter((f: { name: string; isDirectory: boolean }) =>
							!f.isDirectory && audioExtensions.some(ext => f.name.toLowerCase().endsWith(ext)))
						.map((f: { path: string }) => f.path)
						.sort((a: string, b: string) => a.localeCompare(b, undefined, { numeric: true }));
				}
			} catch {
				// Ignore errors
			}
		}

		if (this.chapteredFiles.length === 0) {
			this.error = 'No audio files found';
			return;
		}

		// Determine which file to start with
		if (!startFilePath || !this.chapteredFiles.includes(startFilePath)) {
			startFilePath = this.chapteredFiles[0];
			startPosition = 0;
		}

		this.currentFileIndex = this.chapteredFiles.indexOf(startFilePath);

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
						audio.play().catch(() => {
							// Silently ignore - user will need to click play manually
						});
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
						this.audio.play().catch(() => {
							// Silently ignore - user will need to click play manually
						});
					}
				}, { once: true });

				this.updateMediaSessionMetadata();
			} else {
				this.error = 'Failed to load radio station';
			}
		} catch {
			this.error = 'Failed to load radio station';
		}
	}

	async play() {
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
		this.audio?.pause();
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
		if (this.audio) {
			this.audio.volume = Math.max(0, Math.min(1, volume));
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

		// For chaptered playback, calculate absolute time across all files
		let absoluteTime = this.currentTime;
		if (this.isChapteredPlayback && this.currentFile) {
			const fileStartTime = this.getFileStartTime(this.currentFile);
			absoluteTime = fileStartTime + this.currentTime;
		}

		for (let i = this.chapters.length - 1; i >= 0; i--) {
			const chapter = this.chapters[i];
			// For chaptered playback, also check if we're in the right file
			if (this.isChapteredPlayback && chapter.filePath && chapter.filePath !== this.currentFile) {
				// Check if this chapter is in an earlier file
				const chapterFileIndex = this.chapteredFiles.indexOf(chapter.filePath);
				if (chapterFileIndex > this.currentFileIndex) {
					continue; // Chapter is in a later file, skip
				}
			}

			if (absoluteTime >= chapter.startTime) {
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

		// Check if this chapter is in a different file (DAISY/chaptered playback)
		if (this.isChapteredPlayback && chapter.filePath) {
			const currentFilePath = this.currentFile;

			// Need to switch files?
			if (chapter.filePath !== currentFilePath) {
				// Save position first
				await this.saveChapteredPosition();

				// Calculate position within the target file
				// For DAISY, startTime is absolute across all files, we need file-relative time
				const fileStartTime = this.getFileStartTime(chapter.filePath);
				const positionInFile = chapter.startTime - fileStartTime;

				// Update file index
				this.currentFileIndex = this.chapteredFiles.indexOf(chapter.filePath);

				// Switch files
				this.switchingFiles = true;
				await this.loadFileInternal(chapter.filePath, Math.max(0, positionInFile));
				this.switchingFiles = false;

				this.currentChapterIndex = index;
				this.updateMediaSessionMetadata();
				return;
			}
		}

		// Same file - just seek
		// For chaptered playback, convert absolute time to file-relative time
		let seekTime = chapter.startTime;
		if (this.isChapteredPlayback && chapter.filePath) {
			const fileStartTime = this.getFileStartTime(chapter.filePath);
			seekTime = chapter.startTime - fileStartTime;
		}

		this.seek(Math.max(0, seekTime));
	}

	// Get the cumulative start time of a file in the chaptered sequence
	private getFileStartTime(filePath: string): number {
		// Find the first chapter of this file to get its start time offset
		for (const chapter of this.chapters) {
			if (chapter.filePath === filePath) {
				// Look for the minimum startTime for this file
				const fileChapters = this.chapters.filter(ch => ch.filePath === filePath);
				if (fileChapters.length > 0) {
					return Math.min(...fileChapters.map(ch => ch.startTime));
				}
			}
		}
		return 0;
	}

	previousChapter() {
		// If we're more than 3 seconds into the chapter, restart it
		// Otherwise, go to the previous chapter
		const chapter = this.currentChapter;

		if (this.isChapteredPlayback && chapter) {
			// For chaptered playback, calculate time into current chapter
			const fileStartTime = this.currentFile ? this.getFileStartTime(this.currentFile) : 0;
			const absoluteTime = fileStartTime + this.currentTime;
			const timeIntoChapter = absoluteTime - chapter.startTime;

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
		this.chapteredFiles = [];
		this.currentFileIndex = -1;
		this.chapteredTotalDuration = 0;
		this.switchingFiles = false;
	}
}

export const playerStore = new PlayerStore();
