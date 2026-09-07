<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto, beforeNavigate } from '$app/navigation';
	import Icon from './Icon.svelte';
	import SeekBar from './SeekBar.svelte';
	import PlaybackControls from './PlaybackControls.svelte';
	import VolumeControl from './VolumeControl.svelte';
	import PlayerSettingsDialog from './PlayerSettingsDialog.svelte';
	import ChapterList from './ChapterList.svelte';
	import BookmarkList from './BookmarkList.svelte';
	import GoToTimeDialog from './GoToTimeDialog.svelte';
	import SleepTimer from './SleepTimer.svelte';
	import EffectsPanel from './EffectsPanel.svelte';
	import CastDialog from './CastDialog.svelte';
	import DescribeKeyDialog from './DescribeKeyDialog.svelte';
	import { playerStore } from '$lib/stores/player.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { subtitlesStore } from '$lib/stores/subtitles.svelte';
	import { videoDescribeStore } from '$lib/stores/videoDescribe.svelte';
	import { isPlayableMedia, isVideoExtension } from '$lib/utils/mediaTypes';
	import { recentStore } from '$lib/stores/recent.svelte';
	import { audioEffects } from '$lib/services/audioEffects';
	import { roomCaster } from '$lib/services/roomCaster.svelte';
	import { formatDuration } from '$lib/utils/format';
	import { i18n, t } from '$lib/i18n/index.svelte';
	import { MAX_DESCRIBE_SECONDS, type ChapteredBookManifest } from '$lib/types';

	/**
	 * Either flavour of audio bookmark. Single files store a time against the file;
	 * a multi-file book stores it against one file *of* the book, hence `filePath`.
	 */
	type PlaybackBookmark = { id: number; time: number; label: string | null; filePath?: string };

	interface Props {
		filePath: string;
	}

	let { filePath }: Props = $props();

	let audioElement: HTMLAudioElement | null = $state(null);
	let playButtonRef: HTMLButtonElement | null = $state(null);
	let settingsButtonRef: HTMLButtonElement | null = $state(null);
	let chaptersButtonRef: HTMLButtonElement | null = $state(null);
	let showChapters = $state(false);
	let showSettings = $state(false);
	let showBookmarks = $state(false);
	let showGoToTime = $state(false);
	let showSleepTimer = $state(false);
	let showEffects = $state(false);
	let showCast = $state(false);
	let showDescribeKey = $state(false);
	let describeKeyReason = $state<'missing' | 'invalid'>('missing');
	let describeButtonRef: HTMLButtonElement | null = $state(null);
	let bookmarks = $state<PlaybackBookmark[]>([]);

	// Presentation rows for the shared BookmarkList (keyed by bookmark id; time → detail).
	// A book's bookmarks are shown at their position in the book, not in their file.
	const bookmarkEntries = $derived(
		bookmarks.map((b) => {
			const shown = formatDuration(playerStore.absoluteTimeFor(b.filePath, b.time));
			return {
				id: b.id,
				label: b.label ?? '',
				detail: shown,
				deleteAria: t('bookmarks.deleteAt', { time: shown })
			};
		})
	);

	// Sleep timer state
	let sleepTimerMinutes = $state<number | null>(null);
	let sleepTimerRemaining = $state(0);
	let sleepTimerInterval: ReturnType<typeof setInterval> | null = null;

	// Seek unit system - matches settings page options
	const SEEK_UNITS = [1, 5, 30, 60, 300, 900, 1800, 3600]; // 1s, 5s, 30s, 1m, 5m, 15m, 30m, 60m
	// One index past the time units means "seek by chapter" — offered only while
	// the current media actually has chapters (see hasChapters).
	const CHAPTER_UNIT_INDEX = SEEK_UNITS.length;
	let seekUnitIndex = $state(1); // Default to 5 seconds
	const seekUnit = $derived(SEEK_UNITS[Math.min(seekUnitIndex, SEEK_UNITS.length - 1)]);
	let seekUnitAnnouncement = $state('');
	let timeInfoAnnouncement = $state('');
	let bookmarkAnnouncement = $state('');
	let subtitleAnnouncement = $state('');
	let describeAnnouncement = $state('');

	const title = $derived(playerStore.currentTitle);
	const chapterTitle = $derived(playerStore.currentChapter?.title);
	const isRadio = $derived(playerStore.isRadioStream);
	const hasChapters = $derived(!isRadio && playerStore.chapters.length > 0);
	// Chapter seeking stays selectable only as long as chapters exist; if the
	// media has none (or they load late), the arrows fall back to time seeking.
	const isChapterSeek = $derived(seekUnitIndex === CHAPTER_UNIT_INDEX && hasChapters);

	// Sidecar subtitles (`<media name>.srt` / `.vtt`). The track belongs to the file that is
	// actually loaded — for a chaptered/DAISY book that changes as playback moves
	// through the book, so reload on every file change rather than once on mount.
	$effect(() => {
		const file = playerStore.currentFile;
		if (!file || playerStore.isRadioStream) {
			subtitlesStore.clear();
			return;
		}
		subtitlesStore.load(file);
	});

	const hasSubtitles = $derived(!isRadio && subtitlesStore.available);
	const showSubtitles = $derived(hasSubtitles && settingsStore.subtitlesEnabled);
	// Cue times are file-relative, which is exactly what currentTime is — even
	// inside a book, where chapters use the absolute timeline but audio does not.
	const subtitleText = $derived(
		showSubtitles ? (subtitlesStore.cueAt(playerStore.currentTime)?.text ?? '') : ''
	);
	// The live region is the screen-reader copy of the caption; when it is carrying
	// the text, the visible box is hidden from AT so the line isn't duplicated in
	// the buffer. With announcements off, the visible box is the only copy.
	const announcesSubtitles = $derived(settingsStore.subtitleAnnounce !== 'off');
	// A cue's line breaks are layout, not pauses — speak it as one sentence.
	const spokenSubtitle = $derived(announcesSubtitles ? subtitleText.replace(/\n/g, ' ') : '');

	// --- Video description ---------------------------------------------------
	// A video plays through the same <audio> element as everything else, so the
	// picture is simply not there for anyone. Marking a segment and asking Claude
	// what it shows is offered for every video container, playable or not: ffmpeg
	// can read an .mkv the browser refuses to open.
	//
	// What a description would be *of*: the page's own file normally, and whichever
	// file a chaptered folder currently has loaded. (Reading `currentFile` only in
	// that case keeps the buttons right during SSR, where the store is not yet the
	// file this page is about.)
	const describeTarget = $derived(
		playerStore.isChapteredPlayback ? (playerStore.currentFile ?? filePath) : filePath
	);
	const isVideo = $derived(!isRadio && isVideoExtension(describeTarget));

	// Marks belong to one file. Moving through a chaptered folder loads a different
	// file under the same page, and a mark at 3:20 means nothing in the next one.
	// Keyed on the same value the description is *about*, so a mark made before the
	// file finishes loading isn't wiped by the load itself.
	$effect(() => {
		videoDescribeStore.resetFor(describeTarget);
	});

	const describeErrorText = $derived.by(() => {
		const code = videoDescribeStore.errorCode;
		if (!code) return '';
		switch (code) {
			case 'noStart': return t('describe.errorNoStart');
			case 'noEnd': return t('describe.errorNoEnd');
			case 'noKey': return t('describe.errorNoKey');
			case 'badKey': return t('describe.errorBadKey');
			case 'rateLimited': return t('describe.errorRateLimited');
			case 'quota': return t('describe.errorQuota');
			case 'upstream': return t('describe.errorUpstream');
			case 'badModel': return t('describe.errorBadModel');
			case 'network': return t('describe.errorNetwork');
			case 'timeout': return t('describe.errorTimeout');
			case 'notFound': return t('describe.errorNotFound');
			case 'notVideo': return t('describe.errorNotVideo');
			case 'noVideoStream': return t('describe.errorNoVideoStream');
			case 'badRange': return t('describe.errorBadRange');
			case 'tooLong': return t('describe.errorTooLong', { minutes: Math.floor(MAX_DESCRIBE_SECONDS / 60) });
			case 'ffmpegMissing': return t('describe.errorFfmpegMissing');
			case 'ffmpegFailed': return t('describe.errorFfmpegFailed');
			case 'emptyClip': return t('describe.errorEmptyClip');
			case 'uploadFailed': return t('describe.errorUploadFailed');
			case 'refusal': return t('describe.errorRefusal');
			case 'empty': return t('describe.errorEmpty');
			default: return t('describe.errorServer');
		}
	});

	const describeSegmentLabel = $derived.by(() => {
		const start = videoDescribeStore.startMark;
		const end = videoDescribeStore.endMark;
		if (start === null) return t('describe.noMarks');
		if (end === null) return t('describe.startOnly', { start: formatDuration(start) });
		return t('describe.segment', {
			start: formatDuration(start),
			end: formatDuration(end),
			duration: formatDuration(Math.max(0, end - start))
		});
	});

	function announceDescribe(message: string) {
		describeAnnouncement = message;
		// Cleared so the same message announces again next time it is triggered.
		setTimeout(() => { describeAnnouncement = ''; }, 100);
	}

	function markDescribeStart() {
		const time = playerStore.currentTime;
		videoDescribeStore.markStart(time);
		announceDescribe(t('describe.startMarked', { time: formatDuration(time) }));
	}

	function markDescribeEnd() {
		const time = playerStore.currentTime;
		videoDescribeStore.markEnd(time);
		// An end at or before the start can never be described — say so now rather
		// than letting the user press Describe and wait for a refusal.
		if (videoDescribeStore.startMark !== null && time <= videoDescribeStore.startMark) {
			videoDescribeStore.reportError('badRange');
			announceDescribe(t('describe.errorBadRange'));
			return;
		}
		announceDescribe(t('describe.endMarked', { time: formatDuration(time) }));
	}

	function clearDescribeMarks() {
		videoDescribeStore.clear();
		announceDescribe(t('describe.cleared'));
		requestAnimationFrame(() => describeButtonRef?.focus());
	}

	/** Send the marked segment off, announcing the wait and then the outcome. */
	async function runDescription() {
		announceDescribe(t('describe.working'));
		const ok = await videoDescribeStore.describe(describeTarget, i18n.locale);
		if (ok) return; // the description's own live region carries it

		// A key problem is recoverable right here: reopen the dialog instead of
		// leaving the user with an error and nowhere to go.
		const code = videoDescribeStore.errorCode;
		if (code === 'noKey' || code === 'badKey') {
			describeKeyReason = code === 'badKey' ? 'invalid' : 'missing';
			showDescribeKey = true;
		}
		// Everything else is announced by the panel's role="alert".
	}

	/**
	 * The Describe action. Marks are checked before the key is, so an unmarked
	 * segment never turns into a request for an API key.
	 */
	async function requestDescription() {
		if (!isVideo || videoDescribeStore.isDescribing) return;

		const problem = videoDescribeStore.markError();
		if (problem) {
			videoDescribeStore.reportError(problem);
			announceDescribe(describeErrorText);
			return;
		}

		const status = videoDescribeStore.keyStatus ?? (await videoDescribeStore.loadKeyStatus());
		if (!status.configured) {
			describeKeyReason = 'missing';
			showDescribeKey = true;
			return;
		}

		await runDescription();
	}

	function closeDescribeKey() {
		showDescribeKey = false;
		requestAnimationFrame(() => describeButtonRef?.focus());
	}

	function onDescribeKeySaved() {
		showDescribeKey = false;
		announceDescribe(t('describe.key.saved'));
		requestAnimationFrame(() => describeButtonRef?.focus());
		runDescription();
	}

	// Bookmarks in a multi-file book live in their own table: a bare time would be
	// ambiguous across 50 files, so each row also records the file it points into.
	const bookmarksEndpoint = $derived(
		playerStore.isChapteredPlayback ? '/api/chaptered/bookmarks' : '/api/bookmarks'
	);

	async function loadBookmarks() {
		if (!filePath) return;
		const path = playerStore.chapteredFolderPath ?? filePath;
		try {
			const response = await fetch(`${bookmarksEndpoint}?path=${encodeURIComponent(path)}`);
			if (response.ok) {
				bookmarks = await response.json();
			}
		} catch {
			// Ignore errors
		}
	}

	async function addBookmark(label?: string) {
		if (!filePath) return;
		const time = playerStore.currentTime;
		// The label reads as a position in the *book*, not in whichever file is loaded.
		const formatted = formatDuration(playerStore.absoluteTimeFor(playerStore.currentFile, time));
		bookmarkAnnouncement = t('bookmarks.added', { time: formatted });
		setTimeout(() => { bookmarkAnnouncement = ''; }, 100);

		const body = playerStore.isChapteredPlayback
			? {
					folderPath: playerStore.chapteredFolderPath,
					filePath: playerStore.currentFile,
					time,
					label: label || t('bookmarks.bookmarkAt', { time: formatted })
				}
			: {
					mediaPath: filePath,
					time,
					label: label || t('bookmarks.bookmarkAt', { time: formatted })
				};

		try {
			const response = await fetch(bookmarksEndpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(body)
			});
			if (response.ok) {
				await loadBookmarks();
			}
		} catch {
			// Ignore errors
		}
	}

	// Track previous playing state to detect pause
	let wasPlaying = $state(false);

	// Create bookmark on pause if setting is enabled
	$effect(() => {
		const isPlaying = playerStore.isPlaying;
		if (wasPlaying && !isPlaying && settingsStore.createBookmarkOnPause && !playerStore.isRadioStream) {
			addBookmark(t('bookmarks.pausedAt', { time: formatDuration(playerStore.currentTime) }));
		}
		wasPlaying = isPlaying;
	});

	async function deleteBookmark(id: number) {
		try {
			const response = await fetch(`${bookmarksEndpoint}?id=${id}`, { method: 'DELETE' });
			if (response.ok) {
				await loadBookmarks();
			}
		} catch {
			// Ignore errors
		}
	}

	// Save position on page unload
	function handleBeforeUnload() {
		playerStore.savePosition();
	}

	// Save position when tab becomes hidden
	function handleVisibilityChange() {
		if (document.hidden) {
			playerStore.savePosition();
		}
	}

	onMount(async () => {
		// Load settings first so autoplay setting is available
		await settingsStore.load();

		// Load saved seek unit index
		try {
			const saved = localStorage.getItem('ecobox-seek-unit-index');
			if (saved !== null) {
				const idx = parseInt(saved, 10);
				if (idx >= 0 && idx <= CHAPTER_UNIT_INDEX) {
					seekUnitIndex = idx;
				}
			}
		} catch {
			// Ignore storage errors
		}

		if (audioElement) {
			playerStore.initialize(audioElement);

			// Auto-advance to the next file in the folder when a single track ends
			// (opt-in). Chaptered folders already auto-advance internally.
			playerStore.onTrackEnded = () => {
				if (settingsStore.autoAdvanceTracks) nextTrack();
			};

			// Check if this is a radio file
			if (filePath.endsWith('.radio')) {
				// Don't initialize audio effects for radio streams (CORS restrictions)
				playerStore.loadRadio(filePath);
				recentStore.record(filePath, 'radio');
			} else {
				// Initialize audio effects chain (connects Web Audio API to the audio element)
				await audioEffects.initialize(audioElement);

				// One request answers both "is this a book folder?" and "what's inside",
				// so opening a DAISY book never makes the server parse it twice.
				const manifest = await loadBookManifest(filePath);
				if (manifest && manifest.type !== 'file') {
					await playerStore.loadChapteredFolder(filePath, manifest);
					bookmarks = manifest.bookmarks ?? [];
					recentStore.record(filePath, manifest.type);
				} else {
					playerStore.loadFile(filePath);
					loadBookmarks();
					recentStore.record(filePath, 'file');
				}
			}
		}

		// Sync position on page unload and visibility change
		window.addEventListener('beforeunload', handleBeforeUnload);
		document.addEventListener('visibilitychange', handleVisibilityChange);

		// Focus play button after render
		requestAnimationFrame(() => {
			playButtonRef?.focus();
		});
	});

	async function loadBookManifest(path: string): Promise<ChapteredBookManifest | null> {
		try {
			const response = await fetch(`/api/chaptered/book?path=${encodeURIComponent(path)}`);
			if (response.ok) return await response.json();
		} catch {
			// Treat an unreachable manifest as "ordinary file"
		}
		return null;
	}

	onDestroy(() => {
		if (typeof window !== 'undefined') {
			window.removeEventListener('beforeunload', handleBeforeUnload);
			document.removeEventListener('visibilitychange', handleVisibilityChange);
		}
		cancelSleepTimer();
		subtitlesStore.clear();
		videoDescribeStore.cancel();
		// Stop casting first — audioEffects.destroy() closes the context and would
		// otherwise leave the caster producing a dead track.
		if (roomCaster.isCasting) roomCaster.stop();
		playerStore.onTrackEnded = null;
		playerStore.destroy();
		audioEffects.destroy();
	});

	// Save position before any client-side navigation
	beforeNavigate(async () => {
		await playerStore.savePositionForNavigation();
	});

	async function handleBack() {
		await playerStore.savePositionForNavigation();

		// For chaptered playback, use the folder path for navigation
		const pathToUse = playerStore.isChapteredPlayback && playerStore.chapteredFolderPath
			? playerStore.chapteredFolderPath
			: filePath;

		const pathParts = pathToUse.split('/');
		const itemName = pathParts.pop();
		const parentPath = pathParts.join('/');
		const focusParam = itemName ? `?focus=${encodeURIComponent(itemName)}` : '';

		if (parentPath) {
			goto(`/browse/${parentPath}${focusParam}`);
		} else {
			goto(`/${focusParam}`);
		}
	}

	// Audio files in the current file's folder, natural-sorted the same way the
	// browser and chaptered playback order them.
	async function loadFolderSiblings(): Promise<string[]> {
		const slash = filePath.lastIndexOf('/');
		const folder = slash >= 0 ? filePath.slice(0, slash) : '';
		try {
			const response = await fetch(`/api/files?path=${encodeURIComponent(folder)}`);
			if (!response.ok) return [];
			const data = await response.json();
			return (data.files as { name: string; path: string; isDirectory: boolean }[])
				.filter((f) => !f.isDirectory && isPlayableMedia(f.name))
				.map((f) => f.path)
				.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
		} catch {
			return [];
		}
	}

	// Winamp-style next/previous track. Stays strictly within the current folder:
	// never crosses a folder boundary and never wraps past the first/last file.
	// Chaptered folders move by chapter (the whole folder is one unit); radio has
	// no tracks. Reused by the `b`/`z` shortcuts and by auto-advance-on-finish.
	async function switchTrack(direction: 1 | -1) {
		if (isRadio) return;

		if (playerStore.isChapteredPlayback) {
			if (direction === 1) playerStore.nextChapter();
			else playerStore.previousChapter();
			return;
		}

		const siblings = await loadFolderSiblings();
		const idx = siblings.indexOf(filePath);
		if (idx === -1) return;
		const targetIdx = idx + direction;
		if (targetIdx < 0 || targetIdx >= siblings.length) return; // folder boundary — stop

		// Keep playing across the switch even if the autoplay setting is off.
		playerStore.playOnNextLoad = true;
		goto(`/play/${siblings[targetIdx]}`);
	}

	const nextTrack = () => switchTrack(1);
	const prevTrack = () => switchTrack(-1);

	// The arrow keys and the inner transport buttons both seek by the selected
	// unit — which is a chapter jump when "Chapter" is the chosen unit.
	function seekBackward() {
		if (isChapterSeek) playerStore.previousChapter();
		else playerStore.seekRelative(-seekUnit);
	}

	function seekForward() {
		if (isChapterSeek) playerStore.nextChapter();
		else playerStore.seekRelative(seekUnit);
	}

	// Master switch for the caption box and its live region. Persisted like any
	// setting, so it holds across files and sessions; announced either way so the
	// state change is audible without looking at the button.
	function toggleSubtitles() {
		if (!hasSubtitles) {
			subtitleAnnouncement = t('subtitles.none');
		} else {
			const enabled = !settingsStore.subtitlesEnabled;
			settingsStore.setSubtitlesEnabled(enabled);
			subtitleAnnouncement = enabled ? t('subtitles.on') : t('subtitles.off');
		}
		// Clear after a moment so repeat announcements work
		setTimeout(() => {
			subtitleAnnouncement = '';
		}, 100);
	}

	function openChapters() {
		if (!hasChapters) return;
		showChapters = true;
	}

	function closeChapters() {
		showChapters = false;
		requestAnimationFrame(() => chaptersButtonRef?.focus());
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.target instanceof HTMLInputElement) return;

		// Escape: close any open modal first; otherwise go back.
		// If Escape originated inside a dialog, defer to its local handler.
		if (e.code === 'Escape') {
			const fromDialog = e.target instanceof HTMLElement && e.target.closest('[role="dialog"]');
			if (fromDialog) return;
			e.preventDefault();
			if (showEffects) { closeEffectsPanel(); return; }
			if (showDescribeKey) { closeDescribeKey(); return; }
			if (showCast) { showCast = false; return; }
			if (showGoToTime) { showGoToTime = false; return; }
			if (showBookmarks) {
				showBookmarks = false;
				requestAnimationFrame(() => playButtonRef?.focus());
				return;
			}
			if (showChapters) { closeChapters(); return; }
			if (showSleepTimer) { showSleepTimer = false; return; }
			if (showSettings) { closeSettingsPanel(); return; }
			handleBack();
			return;
		}

		// For other keys, bail when any modal is open
		if (showGoToTime || showBookmarks || showChapters || showSleepTimer || showCast || showDescribeKey)
			return;

		// F key toggles effects panel even when it's open
		if (e.code === 'KeyF' && !isRadio) {
			e.preventDefault();
			toggleEffectsPanel();
			return;
		}

		if (showEffects) return;

		// Ctrl+, toggles the in-player settings panel (the player-context
		// "settings"; the file browser maps the same shortcut to /settings).
		// Reached only when no modal/effects panel is open, so it never stacks.
		if (e.code === 'Comma' && e.ctrlKey && !e.metaKey && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			toggleSettingsPanel();
			return;
		}

		// Winamp-style transport keys (opt-in). Bare keys only, so Ctrl/Cmd combos
		// still work; when enabled, `b` means next-track and overrides add-bookmark.
		if (settingsStore.winampShortcuts && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			switch (e.code) {
				case 'KeyX': // play — never pauses if already playing
					e.preventDefault();
					if (!playerStore.isPlaying) playerStore.play();
					return;
				case 'KeyC': // play / pause toggle
					e.preventDefault();
					playerStore.togglePlayPause();
					return;
				case 'KeyV': // stop == pause (keeps position; never seeks to 0)
					e.preventDefault();
					playerStore.pause();
					return;
				case 'KeyB': // next track (within folder)
					e.preventDefault();
					nextTrack();
					return;
				case 'KeyZ': // previous track (within folder)
					e.preventDefault();
					prevTrack();
					return;
			}
		}

		switch (e.code) {

			case 'Space':
				e.preventDefault();
				playerStore.togglePlayPause();
				break;

			// Arrow keys: seek with current unit (not for radio)
			case 'ArrowLeft':
				if (isRadio) return;
				e.preventDefault();
				seekBackward();
				break;
			case 'ArrowRight':
				if (isRadio) return;
				e.preventDefault();
				seekForward();
				break;

			// Up/Down: change seek unit (not for radio)
			case 'ArrowUp':
				if (isRadio) return;
				e.preventDefault();
				if (seekUnitIndex < (hasChapters ? CHAPTER_UNIT_INDEX : SEEK_UNITS.length - 1)) {
					seekUnitIndex++;
					announceSeekUnit();
				}
				break;
			case 'ArrowDown':
				if (isRadio) return;
				e.preventDefault();
				if (seekUnitIndex > 0) {
					seekUnitIndex--;
					announceSeekUnit();
				}
				break;

			// J: Jump to time dialog (not for radio)
			case 'KeyJ':
				if (isRadio) return;
				e.preventDefault();
				showGoToTime = true;
				break;

			// C: Open the chapter list (when the media has chapters). With Winamp
			// shortcuts on, bare `c` is play/pause and is handled above — Shift+C
			// still reaches here, so chapters stay keyboard-reachable either way.
			case 'KeyC':
				if (isRadio || !hasChapters) return;
				e.preventDefault();
				openChapters();
				break;

			// M: Add bookmark; Shift+M: Open bookmarks list
			case 'KeyM':
				if (isRadio) return;
				e.preventDefault();
				if (e.shiftKey) {
					showBookmarks = true;
				} else {
					addBookmark();
				}
				break;

			// I: Volume up
			case 'KeyI':
				e.preventDefault();
				playerStore.setVolume(Math.min(1, playerStore.volume + 0.1));
				break;

			// K: Volume down
			case 'KeyK':
				e.preventDefault();
				playerStore.setVolume(Math.max(0, playerStore.volume - 0.1));
				break;

			// B: Add bookmark (not for radio)
			case 'KeyB':
				if (isRadio) return;
				e.preventDefault();
				addBookmark();
				break;

			// D: mark the start of a segment to describe; Shift+D marks its end;
			// Ctrl/Cmd+Shift+D asks Claude what happens in it. Bare Ctrl+D is left
			// to the browser (bookmark this page) — we never claim a key we don't use.
			case 'KeyD': {
				if (!isVideo || e.altKey) return;
				const withCtrl = e.ctrlKey || e.metaKey;
				if (withCtrl && !e.shiftKey) return;
				e.preventDefault();
				if (withCtrl) requestDescription();
				else if (e.shiftKey) markDescribeEnd();
				else markDescribeStart();
				break;
			}

			// S: Toggle subtitles (visible box + live region)
			case 'KeyS':
				if (isRadio) return;
				e.preventDefault();
				toggleSubtitles();
				break;

			// T: Announce time info (percentage and remaining)
			case 'KeyT':
				if (isRadio) return;
				e.preventDefault();
				announceTimeInfo();
				break;

			// Number keys: 0=beginning, 1-9=10%-90% (not for radio)
			case 'Digit0':
			case 'Digit1':
			case 'Digit2':
			case 'Digit3':
			case 'Digit4':
			case 'Digit5':
			case 'Digit6':
			case 'Digit7':
			case 'Digit8':
			case 'Digit9':
				if (isRadio) return;
				e.preventDefault();
				if (e.code === 'Digit0') {
					playerStore.seek(0);
				} else {
					const percent = parseInt(e.code.slice(-1), 10) * 10;
					playerStore.seekToPercent(percent);
				}
				// seek() already saves
				break;
		}
	}

	function formatSeekUnit(seconds: number): string {
		if (seconds >= 60) {
			const minutes = seconds / 60;
			return t('player.minutesShort', { n: minutes });
		}
		return `${seconds}s`;
	}

	function formatSeekUnitLong(seconds: number): string {
		if (seconds >= 60) {
			const minutes = seconds / 60;
			return t(minutes === 1 ? 'player.minute' : 'player.minutes', { n: minutes });
		}
		return t(seconds === 1 ? 'player.second' : 'player.seconds', { n: seconds });
	}

	function announceSeekUnit() {
		const unit = isChapterSeek ? t('chapters.seekUnit') : formatSeekUnitLong(seekUnit);
		seekUnitAnnouncement = t('player.seekUnitAnnounce', { unit });
		// Clear after a moment so repeat announcements work
		setTimeout(() => {
			seekUnitAnnouncement = '';
		}, 100);
		// Save to localStorage
		try {
			localStorage.setItem('ecobox-seek-unit-index', seekUnitIndex.toString());
		} catch {
			// Ignore storage errors
		}
	}

	function toggleEffectsPanel() {
		showEffects = !showEffects;
		if (!showEffects) {
			requestAnimationFrame(() => playButtonRef?.focus());
		}
	}

	function closeEffectsPanel() {
		showEffects = false;
		requestAnimationFrame(() => playButtonRef?.focus());
	}

	// In-player settings dialog (the player-context "settings"). The dialog
	// focuses itself on open; restore focus to its trigger when it closes.
	function closeSettingsPanel() {
		showSettings = false;
		requestAnimationFrame(() => settingsButtonRef?.focus());
	}

	function toggleSettingsPanel() {
		if (showSettings) {
			closeSettingsPanel();
		} else {
			showSettings = true;
		}
	}

	function announceTimeInfo() {
		const duration = playerStore.duration;
		const currentTime = playerStore.currentTime;
		if (duration <= 0) {
			timeInfoAnnouncement = t('player.durationNotAvailable');
		} else {
			const percent = Math.round((currentTime / duration) * 100);
			const remaining = duration - currentTime;
			timeInfoAnnouncement = t('player.timeAnnounce', { pct: percent, remaining: formatDuration(remaining) });
		}
		// Clear after a moment so repeat announcements work
		setTimeout(() => {
			timeInfoAnnouncement = '';
		}, 100);
	}

	// Sleep timer functions
	function startSleepTimer(minutes: number) {
		// Clear any existing timer
		cancelSleepTimer();

		sleepTimerMinutes = minutes;
		sleepTimerRemaining = minutes * 60;

		sleepTimerInterval = setInterval(() => {
			sleepTimerRemaining--;

			if (sleepTimerRemaining <= 0) {
				// Timer expired - pause playback
				playerStore.pause();
				cancelSleepTimer();
			}
		}, 1000);
	}

	function cancelSleepTimer() {
		if (sleepTimerInterval) {
			clearInterval(sleepTimerInterval);
			sleepTimerInterval = null;
		}
		sleepTimerMinutes = null;
		sleepTimerRemaining = 0;
	}
</script>

<svelte:window onkeydown={handleKeydown} />

<audio bind:this={audioElement} class="hidden" preload="metadata" playsinline></audio>

<div class="min-h-screen flex flex-col bg-gradient-to-b from-gray-100 to-gray-200 dark:from-gray-900 dark:to-gray-800">
	<!-- Header -->
	<header class="px-4 pt-safe-top sticky top-0 z-10">
		<div class="flex items-center justify-between py-3 max-w-2xl mx-auto">
			<button
				type="button"
				onclick={handleBack}
				class="btn-ghost p-2 flex items-center gap-1"
				aria-label={t('player.goBackAria')}
			>
				<Icon name="chevron-down" size={24} />
				<span class="text-xs text-gray-500 dark:text-gray-400">{t('player.escLabel')}</span>
			</button>

			<div class="flex-1 text-center px-4">
				<p class="text-sm text-gray-500 dark:text-gray-400 truncate">{t('player.nowPlaying')}</p>
			</div>

			<button
				bind:this={settingsButtonRef}
				type="button"
				onclick={toggleSettingsPanel}
				class="btn-ghost p-2"
				aria-label={t('common.settings')}
				aria-haspopup="dialog"
				aria-expanded={showSettings}
			>
				<Icon name="settings" size={24} />
			</button>
		</div>
	</header>

	<!-- Main content -->
	<main class="flex-1 flex flex-col px-4 py-6 max-w-2xl mx-auto w-full">
		<!-- Album art placeholder / Title area -->
		<div class="flex-1 flex flex-col items-center justify-center text-center mb-8">
			<div class="relative w-48 h-48 sm:w-64 sm:h-64 bg-primary-100 dark:bg-primary-900 rounded-2xl shadow-lg flex items-center justify-center mb-6">
				<Icon name={isRadio ? 'radio' : 'audio'} size={64} class="text-primary-500" />
				{#if isRadio}
					<div class="absolute top-2 right-2 px-2 py-1 bg-red-500 text-white text-xs font-bold rounded-full animate-pulse">
						{t('radio.live')}
					</div>
				{/if}
			</div>

			<h1 class="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 line-clamp-2 mb-2">
				{title}
			</h1>

			{#if roomCaster.isCasting}
				<div
					class="mb-2 inline-flex items-center gap-1.5 rounded-full bg-primary-100 dark:bg-primary-900 px-3 py-1 text-sm text-primary-700 dark:text-primary-300"
					role="status"
					aria-live="polite"
				>
					<Icon name="broadcast" size={16} />
					{t('cast.casting', { room: roomCaster.roomName ?? '' })}
				</div>
			{/if}

			{#if chapterTitle && !isRadio}
				<p class="text-gray-600 dark:text-gray-400">
					{chapterTitle}
				</p>
			{/if}

			{#if isRadio}
				<p class="text-gray-600 dark:text-gray-400">
					{t('radio.internetRadio')}
				</p>
			{/if}

			<!-- Seek unit selector - hide for radio -->
			{#if !isRadio}
				<fieldset class="mt-4">
					<legend class="sr-only">{t('player.seekUnit')}</legend>
					<div class="flex flex-wrap justify-center gap-1.5">
						{#each SEEK_UNITS as unit, i}
							<label class="cursor-pointer">
								<input
									type="radio"
									name="seek-unit"
									value={i}
									checked={seekUnitIndex === i}
									onchange={() => { seekUnitIndex = i; announceSeekUnit(); }}
									class="sr-only peer"
								/>
								<span class="inline-block px-2.5 py-1 rounded-full text-sm transition-colors
									peer-checked:bg-blue-600 peer-checked:text-white
									bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400
									hover:bg-gray-200 dark:hover:bg-gray-600">
									{formatSeekUnit(unit)}
								</span>
							</label>
						{/each}

						<!-- Chapter jump, offered alongside the time units when the media has chapters -->
						{#if hasChapters}
							<label class="cursor-pointer">
								<input
									type="radio"
									name="seek-unit"
									value={CHAPTER_UNIT_INDEX}
									checked={seekUnitIndex === CHAPTER_UNIT_INDEX}
									onchange={() => { seekUnitIndex = CHAPTER_UNIT_INDEX; announceSeekUnit(); }}
									class="sr-only peer"
								/>
								<span class="inline-block px-2.5 py-1 rounded-full text-sm transition-colors
									peer-checked:bg-blue-600 peer-checked:text-white
									bg-gray-100 dark:bg-gray-700 text-gray-600 dark:text-gray-400
									hover:bg-gray-200 dark:hover:bg-gray-600">
									{t('chapters.seekUnit')}
								</span>
							</label>
						{/if}
					</div>
				</fieldset>
			{/if}
		</div>

		<!-- Subtitles: the visible caption. The screen-reader copy is the live region
		     at the bottom of the page, so this box is hidden from AT while that is
		     carrying the text (see announcesSubtitles). -->
		{#if showSubtitles}
			<div class="mb-6 min-h-[5rem] flex items-center justify-center">
				{#if subtitleText}
					<p
						class="w-full rounded-lg bg-gray-900/90 dark:bg-black/80 px-4 py-3 text-center text-lg sm:text-2xl font-medium leading-snug text-white whitespace-pre-line"
						aria-hidden={announcesSubtitles}
					>
						{subtitleText}
					</p>
				{/if}
			</div>
		{/if}

		<!-- Video description. The picture is never rendered anywhere in this app, so
		     this panel is the only place its content ever appears. The description
		     itself sits in an ASSERTIVE live region: the user asked for it and is
		     waiting on it, and a polite one would queue behind running captions. -->
		{#if isVideo && (videoDescribeStore.hasStart || videoDescribeStore.description || videoDescribeStore.errorCode || videoDescribeStore.isDescribing)}
			<section
				class="mb-6 rounded-lg border border-gray-300 dark:border-gray-700 bg-white/70 dark:bg-gray-800/70 p-4"
				aria-labelledby="describe-panel-heading"
				aria-busy={videoDescribeStore.isDescribing}
			>
				<div class="flex items-start justify-between gap-3">
					<h2
						id="describe-panel-heading"
						class="text-sm font-semibold uppercase tracking-wide text-gray-500 dark:text-gray-400"
					>
						{t('describe.heading')}
					</h2>
					{#if videoDescribeStore.hasStart || videoDescribeStore.description}
						<button
							type="button"
							class="btn-ghost text-sm px-2 py-1"
							onclick={clearDescribeMarks}
							aria-label={t('describe.clearAria')}
						>
							{t('describe.clear')}
						</button>
					{/if}
				</div>

				<p class="mt-1 text-sm text-gray-600 dark:text-gray-400">{describeSegmentLabel}</p>

				{#if videoDescribeStore.isDescribing}
					<p class="mt-2 text-sm text-gray-600 dark:text-gray-400">{t('describe.working')}</p>
				{/if}

				<div aria-live="assertive" aria-atomic="true">
					{#if videoDescribeStore.description}
						<p class="mt-3 text-base leading-relaxed text-gray-900 dark:text-gray-100 whitespace-pre-line">
							{videoDescribeStore.description}
						</p>
					{/if}
				</div>

				{#if describeErrorText}
					<p class="mt-3 text-sm text-red-600 dark:text-red-400" role="alert">
						{describeErrorText}{#if videoDescribeStore.errorDetail}
							<span class="opacity-70"> ({videoDescribeStore.errorDetail})</span>
						{/if}
					</p>
				{/if}
			</section>
		{/if}

		<!-- Seek bar (hide for radio) -->
		{#if !isRadio}
			<div class="mb-6">
				<SeekBar
					currentTime={playerStore.currentTime}
					duration={playerStore.duration}
					onseek={(time) => playerStore.seek(time)}
				/>
			</div>
		{/if}

		<!-- Playback controls -->
		<div class="mb-6">
			<PlaybackControls
				isPlaying={playerStore.isPlaying}
				playbackRate={playerStore.playbackRate}
				seekInterval={seekUnit}
				longSeekInterval={playerStore.longSeekInterval}
				seekLabel={isChapterSeek ? t('chapters.seekUnitShort') : undefined}
				seekBackAria={isChapterSeek ? t('chapters.previous') : undefined}
				seekForwardAria={isChapterSeek ? t('chapters.next') : undefined}
				ontoggle={() => playerStore.togglePlayPause()}
				onratechange={(rate) => playerStore.setPlaybackRate(rate)}
				onseekback={seekBackward}
				onseekforward={seekForward}
				onlongseekback={() => playerStore.seekRelative(-playerStore.longSeekInterval)}
				onlongseekforward={() => playerStore.seekRelative(playerStore.longSeekInterval)}
				bind:playButtonRef
				{isRadio}
			/>
		</div>

		<!-- Volume control -->
		<div class="mb-6 max-w-xs mx-auto w-full">
			<VolumeControl
				volume={playerStore.volume}
				onchange={(v) => playerStore.setVolume(v)}
			/>
		</div>

		<!-- Loading / Error states -->
		{#if playerStore.isLoading}
			<div class="text-center py-4" aria-live="polite">
				<div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500"></div>
				<span class="sr-only">{t('player.loadingAudio')}</span>
			</div>
		{/if}

		{#if playerStore.error}
			<div class="text-center py-4 text-red-600 dark:text-red-400" role="alert">
				{playerStore.error}
			</div>
		{/if}

	</main>

	<!-- Bottom actions -->
	<footer class="px-4 pb-safe-bottom">
		<div class="flex justify-center gap-2 sm:gap-4 py-4 max-w-2xl mx-auto flex-wrap">
			{#if hasChapters}
				{@const chapterCount = t(playerStore.chapters.length === 1 ? 'chapters.countOne' : 'chapters.countOther', { n: playerStore.chapters.length })}
				<button
					bind:this={chaptersButtonRef}
					type="button"
					onclick={openChapters}
					class="btn-secondary"
					aria-label={t('chapters.openListAria', { count: chapterCount })}
					aria-haspopup="dialog"
					aria-expanded={showChapters}
				>
					<Icon name="menu" size={20} class="mr-2" />
					{t('chapters.button', { count: playerStore.chapters.length })}
				</button>
			{/if}

			{#if !isRadio}
				<button
					type="button"
					class="btn-secondary"
					onclick={() => addBookmark()}
					aria-label={t('bookmarks.addAria')}
				>
					<Icon name="bookmark" size={20} class="mr-2" />
					{t('bookmarks.add')}
				</button>

				{#if bookmarks.length > 0}
					{@const bookmarkCount = t(bookmarks.length === 1 ? 'bookmarks.countOne' : 'bookmarks.countOther', { n: bookmarks.length })}
					<button
						type="button"
						class="btn-secondary"
						onclick={() => showBookmarks = true}
						aria-label={t('bookmarks.openListAria', { count: bookmarkCount })}
					>
						<Icon name="bookmark" size={20} class="mr-2" />
						{t('bookmarks.button', { count: bookmarks.length })}
					</button>
				{/if}

				<button
					type="button"
					class="btn-secondary"
					onclick={() => showGoToTime = true}
					aria-label={t('player.jumpAria')}
				>
					<Icon name="clock" size={20} class="mr-2" />
					{t('player.jump')}
				</button>

				<button
					type="button"
					class="btn-secondary"
					onclick={announceTimeInfo}
					aria-label={t('player.timeAria')}
				>
					<Icon name="clock" size={20} class="mr-2" />
					{t('player.timeBtn')}
				</button>

				<!-- Only offered when the file actually has a sidecar .srt -->
				{#if hasSubtitles}
					<button
						type="button"
						class="btn-secondary {settingsStore.subtitlesEnabled ? 'ring-2 ring-primary-500 text-primary-600 dark:text-primary-400' : ''}"
						onclick={toggleSubtitles}
						aria-label={t('subtitles.toggleAria')}
						aria-pressed={settingsStore.subtitlesEnabled}
					>
						<Icon name="captions" size={20} class="mr-2" />
						{t('subtitles.button')}
					</button>
				{/if}

				<!-- Describe what is on screen. Only for videos: everything else has no
				     picture to miss. -->
				{#if isVideo}
					<button
						type="button"
						class="btn-secondary {videoDescribeStore.hasStart ? 'ring-2 ring-primary-500 text-primary-600 dark:text-primary-400' : ''}"
						onclick={markDescribeStart}
						aria-label={t('describe.markStartAria')}
					>
						<Icon name="mark-start" size={20} class="mr-2" />
						{t('describe.markStart')}
					</button>

					<button
						type="button"
						class="btn-secondary {videoDescribeStore.hasEnd ? 'ring-2 ring-primary-500 text-primary-600 dark:text-primary-400' : ''}"
						onclick={markDescribeEnd}
						aria-label={t('describe.markEndAria')}
					>
						<Icon name="mark-end" size={20} class="mr-2" />
						{t('describe.markEnd')}
					</button>

					<button
						bind:this={describeButtonRef}
						type="button"
						class="btn-secondary"
						onclick={requestDescription}
						disabled={videoDescribeStore.isDescribing}
						aria-busy={videoDescribeStore.isDescribing}
						aria-label={t('describe.buttonAria')}
					>
						<Icon name="video" size={20} class="mr-2" />
						{videoDescribeStore.isDescribing ? t('describe.working') : t('describe.button')}
					</button>
				{/if}
			{/if}

			<button
				type="button"
				class="btn-secondary"
				onclick={() => showSleepTimer = true}
				aria-label={t('player.sleepAria')}
			>
				<Icon name="clock" size={20} class="mr-2" />
				{#if sleepTimerMinutes !== null}
					{t('player.minutesShort', { n: Math.ceil(sleepTimerRemaining / 60) })}
				{:else}
					{t('player.sleep')}
				{/if}
			</button>

			{#if !isRadio}
				<button
					type="button"
					class="btn-secondary"
					onclick={toggleEffectsPanel}
					aria-label={t('player.effectsAria')}
					aria-expanded={showEffects}
					aria-haspopup="dialog"
				>
					<Icon name="settings" size={20} class="mr-2" />
					{t('player.effects')}
				</button>

				<button
					type="button"
					class="btn-secondary {roomCaster.isCasting ? 'ring-2 ring-primary-500 text-primary-600 dark:text-primary-400' : ''}"
					onclick={() => { if (roomCaster.isCasting) roomCaster.stop(); else showCast = true; }}
					aria-label={roomCaster.isCasting ? t('cast.stop') : t('cast.aria')}
					aria-expanded={roomCaster.isCasting ? undefined : showCast}
					aria-haspopup={roomCaster.isCasting ? undefined : 'dialog'}
					aria-pressed={roomCaster.isCasting}
				>
					<Icon name="broadcast" size={20} class="mr-2" />
					{roomCaster.isCasting ? t('cast.stop') : t('cast.button')}
				</button>
			{/if}
		</div>
	</footer>
</div>

<!-- Chapter list modal -->
{#if showChapters}
	<ChapterList
		chapters={playerStore.chapters}
		currentChapterIndex={playerStore.currentChapterIndex}
		onselect={(index: number) => playerStore.seekToChapter(index)}
		onclose={closeChapters}
	/>
{/if}

<!-- Bookmark list modal -->
{#if showBookmarks}
	<BookmarkList
		bookmarks={bookmarkEntries}
		onselect={(id: number) => {
			const b = bookmarks.find((x) => x.id === id);
			// Switches files first when the bookmark lives in another part of the book.
			if (b) playerStore.seekToBookPosition(b.filePath, b.time);
		}}
		ondelete={deleteBookmark}
		onclose={() => {
			showBookmarks = false;
			requestAnimationFrame(() => playButtonRef?.focus());
		}}
	/>
{/if}

<!-- Go to time dialog -->
{#if showGoToTime}
	<GoToTimeDialog
		duration={playerStore.duration}
		currentTime={playerStore.currentTime}
		onseek={(time: number) => playerStore.seek(time)}
		onclose={() => {
			showGoToTime = false;
			requestAnimationFrame(() => playButtonRef?.focus());
		}}
	/>
{/if}

<!-- Sleep timer modal -->
{#if showSleepTimer}
	<SleepTimer
		onstart={startSleepTimer}
		oncancel={cancelSleepTimer}
		onclose={() => showSleepTimer = false}
		activeMinutes={sleepTimerMinutes}
		remainingSeconds={sleepTimerRemaining}
	/>
{/if}

<!-- Effects panel modal -->
{#if showEffects}
	<EffectsPanel onclose={closeEffectsPanel} />
{/if}

<!-- Player settings modal -->
{#if showSettings}
	<PlayerSettingsDialog onclose={closeSettingsPanel} />
{/if}

<!-- Cast dialog -->
{#if showCast}
	<CastDialog
		currentTitle={playerStore.currentTitle}
		onclose={() => {
			showCast = false;
			requestAnimationFrame(() => playButtonRef?.focus());
		}}
	/>
{/if}

<!-- Claude API key prompt — opened the first time a description is asked for
     without a key on the server, and again if the stored key is rejected. -->
{#if showDescribeKey}
	<DescribeKeyDialog
		reason={describeKeyReason}
		onsaved={onDescribeKeySaved}
		onclose={closeDescribeKey}
	/>
{/if}

<!-- Live region for announcements -->
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{seekUnitAnnouncement}
</div>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{timeInfoAnnouncement}
</div>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{bookmarkAnnouncement}
</div>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{subtitleAnnouncement}
</div>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{describeAnnouncement}
</div>

<!-- Subtitle live regions. Both are rendered so the one in use is registered with
     the screen reader from the start (swapping aria-live on a live element is
     unreliable); only the chosen politeness ever receives text. Assertive is the
     default: each caption supersedes the last instead of queueing behind it. -->
<div class="sr-only" role="alert" aria-live="assertive" aria-atomic="true">
	{settingsStore.subtitleAnnounce === 'assertive' ? spokenSubtitle : ''}
</div>
<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
	{settingsStore.subtitleAnnounce === 'polite' ? spokenSubtitle : ''}
</div>

<style>
	.pt-safe-top {
		padding-top: max(0.75rem, env(safe-area-inset-top));
	}
	.pb-safe-bottom {
		padding-bottom: max(1rem, env(safe-area-inset-bottom));
	}
</style>
