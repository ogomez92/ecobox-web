<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { goto } from '$app/navigation';
	import Icon from './Icon.svelte';
	import SeekBar from './SeekBar.svelte';
	import PlaybackControls from './PlaybackControls.svelte';
	import VolumeControl from './VolumeControl.svelte';
	import SpeedControl from './SpeedControl.svelte';
	import ChapterList from './ChapterList.svelte';
	import BookmarkList from './BookmarkList.svelte';
	import GoToTimeDialog from './GoToTimeDialog.svelte';
	import SleepTimer from './SleepTimer.svelte';
	import EffectsPanel from './EffectsPanel.svelte';
	import { playerStore } from '$lib/stores/player.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { audioEffects } from '$lib/services/audioEffects';
	import { formatDuration } from '$lib/utils/format';
	import type { Bookmark } from '$server/db/schema';

	interface Props {
		filePath: string;
	}

	let { filePath }: Props = $props();

	let audioElement: HTMLAudioElement | null = $state(null);
	let showChapters = $state(false);
	let showSettings = $state(false);
	let showBookmarks = $state(false);
	let showGoToTime = $state(false);
	let showSleepTimer = $state(false);
	let showEffects = $state(false);
	let bookmarks = $state<Bookmark[]>([]);

	// Sleep timer state
	let sleepTimerMinutes = $state<number | null>(null);
	let sleepTimerRemaining = $state(0);
	let sleepTimerInterval: ReturnType<typeof setInterval> | null = null;

	// Seek unit system (like iOS)
	const SEEK_UNITS = [1, 5, 10, 30, 60, 300, 600];
	let seekUnitIndex = $state(1); // Default to 5 seconds
	const seekUnit = $derived(SEEK_UNITS[seekUnitIndex]);

	const title = $derived(playerStore.currentTitle);
	const chapterTitle = $derived(playerStore.currentChapter?.title);
	const isRadio = $derived(playerStore.isRadioStream);

	async function loadBookmarks() {
		if (!filePath) return;
		try {
			const response = await fetch(`/api/bookmarks?path=${encodeURIComponent(filePath)}`);
			if (response.ok) {
				bookmarks = await response.json();
			}
		} catch {
			// Ignore errors
		}
	}

	async function addBookmark(label?: string) {
		if (!filePath) return;
		try {
			const response = await fetch('/api/bookmarks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					mediaPath: filePath,
					time: playerStore.currentTime,
					label: label || `Bookmark at ${formatDuration(playerStore.currentTime)}`
				})
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
			addBookmark(`Paused at ${formatDuration(playerStore.currentTime)}`);
		}
		wasPlaying = isPlaying;
	});

	async function deleteBookmark(id: number) {
		try {
			const response = await fetch(`/api/bookmarks?id=${id}`, { method: 'DELETE' });
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

		if (audioElement) {
			playerStore.initialize(audioElement);

			// Initialize audio effects chain (connects Web Audio API to the audio element)
			await audioEffects.initialize(audioElement);

			// Check if this is a radio file
			if (filePath.endsWith('.radio')) {
				playerStore.loadRadio(filePath);
			} else {
				playerStore.loadFile(filePath);
				loadBookmarks();
			}
		}

		// Sync position on page unload and visibility change
		window.addEventListener('beforeunload', handleBeforeUnload);
		document.addEventListener('visibilitychange', handleVisibilityChange);
	});

	onDestroy(() => {
		window.removeEventListener('beforeunload', handleBeforeUnload);
		document.removeEventListener('visibilitychange', handleVisibilityChange);
		cancelSleepTimer();
		playerStore.destroy();
		audioEffects.destroy();
	});

	function handleBack() {
		playerStore.savePosition();
		const pathParts = filePath.split('/');
		const fileName = pathParts.pop();
		const parentPath = pathParts.join('/');
		const focusParam = fileName ? `?focus=${encodeURIComponent(fileName)}` : '';

		if (parentPath) {
			goto(`/browse/${parentPath}${focusParam}`);
		} else {
			goto(`/${focusParam}`);
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		// Skip if in input field or dialog is open
		if (e.target instanceof HTMLInputElement || showGoToTime) return;

		switch (e.code) {
			case 'Escape':
				e.preventDefault();
				handleBack();
				break;

			case 'Space':
				e.preventDefault();
				playerStore.togglePlayPause();
				break;

			// Arrow keys: seek with current unit
			case 'ArrowLeft':
				e.preventDefault();
				playerStore.seekRelative(-seekUnit);
				playerStore.savePosition();
				break;
			case 'ArrowRight':
				e.preventDefault();
				playerStore.seekRelative(seekUnit);
				playerStore.savePosition();
				break;

			// Up/Down: change seek unit
			case 'ArrowUp':
				e.preventDefault();
				if (seekUnitIndex < SEEK_UNITS.length - 1) {
					seekUnitIndex++;
				}
				break;
			case 'ArrowDown':
				e.preventDefault();
				if (seekUnitIndex > 0) {
					seekUnitIndex--;
				}
				break;

			// J: Jump to time dialog
			case 'KeyJ':
				e.preventDefault();
				showGoToTime = true;
				break;

			// M: Mute toggle
			case 'KeyM':
				playerStore.setVolume(playerStore.volume > 0 ? 0 : 1);
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

			// B: Add bookmark
			case 'KeyB':
				e.preventDefault();
				addBookmark();
				break;

			// Number keys: 1=beginning, 2-9=20%-90%, 0=end
			case 'Digit1':
				e.preventDefault();
				playerStore.seek(0);
				playerStore.savePosition();
				break;
			case 'Digit2':
			case 'Digit3':
			case 'Digit4':
			case 'Digit5':
			case 'Digit6':
			case 'Digit7':
			case 'Digit8':
			case 'Digit9':
				e.preventDefault();
				const percent = parseInt(e.code.slice(-1), 10) * 10;
				playerStore.seekToPercent(percent);
				playerStore.savePosition();
				break;
			case 'Digit0':
				e.preventDefault();
				playerStore.seek(playerStore.duration);
				playerStore.savePosition();
				break;
		}
	}

	function formatSeekUnit(seconds: number): string {
		if (seconds >= 60) {
			return `${seconds / 60}m`;
		}
		return `${seconds}s`;
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

<audio bind:this={audioElement} class="hidden" preload="metadata"></audio>

<div class="min-h-screen flex flex-col bg-gradient-to-b from-gray-100 to-gray-200 dark:from-gray-900 dark:to-gray-800">
	<!-- Header -->
	<header class="px-4 pt-safe-top sticky top-0 z-10">
		<div class="flex items-center justify-between py-3 max-w-2xl mx-auto">
			<button
				type="button"
				onclick={handleBack}
				class="btn-ghost p-2"
				aria-label="Go back"
			>
				<Icon name="chevron-down" size={24} />
			</button>

			<div class="flex-1 text-center px-4">
				<p class="text-sm text-gray-500 dark:text-gray-400 truncate">Now Playing</p>
			</div>

			<button
				type="button"
				onclick={() => showSettings = !showSettings}
				class="btn-ghost p-2"
				aria-label="Settings"
				aria-pressed={showSettings}
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
						LIVE
					</div>
				{/if}
			</div>

			<h1 class="text-xl sm:text-2xl font-bold text-gray-900 dark:text-gray-100 line-clamp-2 mb-2">
				{title}
			</h1>

			{#if chapterTitle && !isRadio}
				<p class="text-gray-600 dark:text-gray-400">
					{chapterTitle}
				</p>
			{/if}

			{#if isRadio}
				<p class="text-gray-600 dark:text-gray-400">
					Internet Radio
				</p>
			{/if}

			<!-- Seek unit indicator (keyboard hint) - hide for radio -->
			{#if !isRadio}
				<div class="mt-4 px-3 py-1.5 bg-gray-100 dark:bg-gray-700 rounded-full text-sm text-gray-600 dark:text-gray-400">
					Seek: ±{formatSeekUnit(seekUnit)} (← →)
				</div>
			{/if}
		</div>

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
				seekInterval={playerStore.seekInterval}
				longSeekInterval={playerStore.longSeekInterval}
				ontoggle={() => playerStore.togglePlayPause()}
				onseekback={() => playerStore.seekRelative(-playerStore.seekInterval)}
				onseekforward={() => playerStore.seekRelative(playerStore.seekInterval)}
				onlongseekback={() => playerStore.seekRelative(-playerStore.longSeekInterval)}
				onlongseekforward={() => playerStore.seekRelative(playerStore.longSeekInterval)}
			/>
		</div>

		<!-- Loading / Error states -->
		{#if playerStore.isLoading}
			<div class="text-center py-4" aria-live="polite">
				<div class="inline-block animate-spin rounded-full h-6 w-6 border-b-2 border-primary-500"></div>
				<span class="sr-only">Loading audio...</span>
			</div>
		{/if}

		{#if playerStore.error}
			<div class="text-center py-4 text-red-600 dark:text-red-400" role="alert">
				{playerStore.error}
			</div>
		{/if}

		<!-- Settings panel -->
		{#if showSettings}
			<div class="card p-4 space-y-6 mb-6">
				<VolumeControl
					volume={playerStore.volume}
					onchange={(v) => playerStore.setVolume(v)}
				/>

				<SpeedControl
					speed={playerStore.playbackRate}
					onchange={(s) => playerStore.setPlaybackRate(s)}
				/>
			</div>
		{/if}
	</main>

	<!-- Bottom actions -->
	<footer class="px-4 pb-safe-bottom">
		<div class="flex justify-center gap-2 sm:gap-4 py-4 max-w-2xl mx-auto flex-wrap">
			{#if !isRadio && playerStore.chapters.length > 0}
				<button
					type="button"
					onclick={() => showChapters = true}
					class="btn-secondary"
				>
					<Icon name="menu" size={20} class="mr-2" />
					Chapters ({playerStore.chapters.length})
				</button>
			{/if}

			{#if !isRadio}
				<button
					type="button"
					class="btn-secondary"
					onclick={() => addBookmark()}
					aria-label="Add bookmark at current position"
				>
					<Icon name="bookmark" size={20} class="mr-2" />
					Add
				</button>

				{#if bookmarks.length > 0}
					<button
						type="button"
						class="btn-secondary"
						onclick={() => showBookmarks = true}
					>
						<Icon name="bookmark" size={20} class="mr-2" />
						Bookmarks ({bookmarks.length})
					</button>
				{/if}

				<button
					type="button"
					class="btn-secondary"
					onclick={() => showGoToTime = true}
					aria-label="Jump to time (J)"
				>
					<Icon name="clock" size={20} class="mr-2" />
					Jump
				</button>
			{/if}

			<button
				type="button"
				class="btn-secondary"
				onclick={() => showSleepTimer = true}
				aria-label="Sleep timer"
			>
				<Icon name="clock" size={20} class="mr-2" />
				{#if sleepTimerMinutes !== null}
					{Math.ceil(sleepTimerRemaining / 60)}m
				{:else}
					Sleep
				{/if}
			</button>

			<button
				type="button"
				class="btn-secondary"
				onclick={() => showEffects = true}
				aria-label="Audio effects"
				aria-expanded={showEffects}
				aria-haspopup="dialog"
			>
				<Icon name="settings" size={20} class="mr-2" />
				Effects
			</button>
		</div>
	</footer>
</div>

<!-- Chapter list modal -->
{#if showChapters}
	<ChapterList
		chapters={playerStore.chapters}
		currentChapterIndex={playerStore.currentChapterIndex}
		onselect={(index: number) => playerStore.seekToChapter(index)}
		onclose={() => showChapters = false}
	/>
{/if}

<!-- Bookmark list modal -->
{#if showBookmarks}
	<BookmarkList
		{bookmarks}
		onselect={(time: number) => playerStore.seek(time)}
		ondelete={deleteBookmark}
		onclose={() => showBookmarks = false}
	/>
{/if}

<!-- Go to time dialog -->
{#if showGoToTime}
	<GoToTimeDialog
		duration={playerStore.duration}
		currentTime={playerStore.currentTime}
		onseek={(time: number) => playerStore.seek(time)}
		onclose={() => showGoToTime = false}
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
	<EffectsPanel onclose={() => showEffects = false} />
{/if}

<style>
	.pt-safe-top {
		padding-top: max(0.75rem, env(safe-area-inset-top));
	}
	.pb-safe-bottom {
		padding-bottom: max(1rem, env(safe-area-inset-bottom));
	}
</style>
