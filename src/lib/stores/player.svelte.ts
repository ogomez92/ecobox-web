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

	// Radio stream state
	isRadioStream = $state(false);
	radioStreamUrl = $state<string | null>(null);

	// Settings
	seekInterval = $state(5);
	longSeekInterval = $state(30);

	// Audio element reference
	private audio: HTMLAudioElement | null = null;
	private savePositionInterval: number | null = null;
	private mediaSessionSetup = false;
	private positionSavedForNavigation = false;

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
			this.startPositionSaving();
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'playing';
			}
			this.updateMediaSessionPosition();
		});

		this.audio.addEventListener('pause', () => {
			this.isPlaying = false;
			this.stopPositionSaving();
			if ('mediaSession' in navigator) {
				navigator.mediaSession.playbackState = 'paused';
			}
			// Don't save if we're navigating away or audio is being destroyed
			if (!this.positionSavedForNavigation && this.audio && this.currentTime > 0) {
				this.savePosition();
			}
		});

		this.audio.addEventListener('ended', () => {
			this.isPlaying = false;
			this.stopPositionSaving();
			this.handleEnded();
		});

		this.audio.addEventListener('timeupdate', () => {
			this.currentTime = this.audio?.currentTime || 0;
			this.updateCurrentChapter();
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
		// Resume AudioContext if suspended (required by browsers after page load)
		await audioEffects.resumeContext();

		this.audio?.play().catch((err) => {
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
			this.audio.currentTime = Math.max(0, Math.min(time, this.duration));
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

		for (let i = this.chapters.length - 1; i >= 0; i--) {
			if (this.currentTime >= this.chapters[i].startTime) {
				if (this.currentChapterIndex !== i) {
					this.currentChapterIndex = i;
					this.updateMediaSessionMetadata();
				}
				return;
			}
		}
		this.currentChapterIndex = 0;
	}

	seekToChapter(index: number) {
		if (index >= 0 && index < this.chapters.length) {
			this.seek(this.chapters[index].startTime);
		}
	}

	previousChapter() {
		// If we're more than 3 seconds into the chapter, restart it
		// Otherwise, go to the previous chapter
		const chapter = this.currentChapter;
		if (chapter && this.currentTime - chapter.startTime > 3) {
			this.seek(chapter.startTime);
		} else if (this.currentChapterIndex > 0) {
			this.seekToChapter(this.currentChapterIndex - 1);
		} else {
			this.seek(0);
		}
	}

	nextChapter() {
		if (this.currentChapterIndex < this.chapters.length - 1) {
			this.seekToChapter(this.currentChapterIndex + 1);
		}
	}

	private handleEnded() {
		// Don't save if we're navigating away (position already saved)
		if (!this.positionSavedForNavigation) {
			this.savePosition();
		}
		// Could implement auto-advance to next file here
	}

	private startPositionSaving() {
		this.stopPositionSaving();
		// Save position every 5 seconds
		this.savePositionInterval = window.setInterval(() => {
			// Don't save if we're navigating away
			if (!this.positionSavedForNavigation) {
				this.savePosition();
			}
		}, 5000);
	}

	private stopPositionSaving() {
		if (this.savePositionInterval) {
			clearInterval(this.savePositionInterval);
			this.savePositionInterval = null;
		}
	}

	private async doSavePosition() {
		if (!this.currentFile || this.isRadioStream) return;

		try {
			await fetch('/api/media/metadata', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: this.currentFile,
					lastPlayedPosition: this.currentTime,
					duration: this.duration
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
		// Set flag FIRST to block any concurrent saves (like pause events)
		this.positionSavedForNavigation = true;
		await this.doSavePosition();
	}

	destroy() {
		this.stopPositionSaving();
		// Set audio to null first to prevent pause event from saving
		const shouldSave = !this.positionSavedForNavigation;
		this.audio = null;
		if (shouldSave) {
			this.savePosition();
		}
		this.positionSavedForNavigation = false;
	}
}

export const playerStore = new PlayerStore();
