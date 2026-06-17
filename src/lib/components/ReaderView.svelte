<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { readerStore } from '$lib/stores/reader.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import ReaderControls from './ReaderControls.svelte';
	import FindInBook from './FindInBook.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		bookPath: string;
	}

	let { bookPath }: Props = $props();

	let playButtonRef = $state<HTMLButtonElement | null>(null);
	let showFind = $state(false);

	// Seek unit, mirroring the media player: Left/Right move by the chosen unit,
	// Up/Down cycle through the units. Persisted per device.
	type SeekUnit = 'sentence' | 'paragraph' | 'heading';
	const SEEK_UNITS: SeekUnit[] = ['sentence', 'paragraph', 'heading'];
	const SEEK_UNIT_KEY = 'ecobox-reader-seek-unit';
	let seekUnitIndex = $state(0);
	let seekUnitAnnouncement = $state('');
	const seekUnit = $derived(SEEK_UNITS[seekUnitIndex]);

	const parentHref = $derived('/browse/' + bookPath.split('/').slice(0, -1).join('/'));
	const progressPct = $derived(Math.round(readerStore.progress));

	function unitLabel(u: SeekUnit): string {
		if (u === 'paragraph') return t('reader.seekUnitParagraph');
		if (u === 'heading') return t('reader.seekUnitHeading');
		return t('reader.seekUnitSentence');
	}

	function changeSeekUnit(delta: number) {
		const next = seekUnitIndex + delta;
		if (next < 0 || next >= SEEK_UNITS.length) return;
		seekUnitIndex = next;
		try {
			localStorage.setItem(SEEK_UNIT_KEY, SEEK_UNITS[seekUnitIndex]);
		} catch {
			// ignore
		}
		seekUnitAnnouncement = t('reader.seekUnitAnnounce', { unit: unitLabel(seekUnit) });
	}

	function seekBy(dir: 1 | -1) {
		if (seekUnit === 'paragraph') {
			dir < 0 ? readerStore.prevParagraph() : readerStore.nextParagraph();
		} else if (seekUnit === 'heading') {
			dir < 0 ? readerStore.prevHeading() : readerStore.nextHeading();
		} else {
			dir < 0 ? readerStore.prev() : readerStore.next();
		}
	}

	onMount(() => {
		try {
			const saved = SEEK_UNITS.indexOf(localStorage.getItem(SEEK_UNIT_KEY) as SeekUnit);
			if (saved >= 0) seekUnitIndex = saved;
		} catch {
			// ignore
		}
		(async () => {
			// Settings (saved speed) before loadBook, and voices before autoplay —
			// otherwise the first utterance uses the default rate/voice, not the saved one.
			await settingsStore.load();
			await readerStore.loadBook(bookPath);
			await readerStore.loadVoices();
			playButtonRef?.focus();
			// Start reading automatically on open, now that voice + speed are resolved.
			readerStore.play();
		})();
	});

	beforeNavigate(() => {
		readerStore.savePositionForNavigation();
	});

	onDestroy(() => {
		readerStore.destroy();
	});

	function handleBeforeUnload() {
		readerStore.savePosition();
	}

	function handleVisibility() {
		if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
			readerStore.savePosition();
		}
	}

	function isFormTarget(target: EventTarget | null): boolean {
		const el = target as HTMLElement | null;
		if (!el) return false;
		const tag = el.tagName;
		return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || el.isContentEditable;
	}

	// Mirrors the media player (PlaybackView) shortcut model: code-based keys,
	// Escape goes back, Space toggles, arrows navigate.
	function handleKeydown(e: KeyboardEvent) {
		// Escape: close the find modal if open, otherwise go back to the folder.
		// If it originated inside a dialog, defer to that dialog's own handler.
		if (e.code === 'Escape') {
			const fromDialog = e.target instanceof HTMLElement && e.target.closest('[role="dialog"]');
			if (fromDialog) return;
			e.preventDefault();
			if (showFind) {
				showFind = false;
				playButtonRef?.focus();
				return;
			}
			goto(parentHref);
			return;
		}

		// Ctrl/Cmd+F: open Find in book (overrides the browser's native find).
		if (e.code === 'KeyF' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			showFind = true;
			return;
		}

		// While the find modal is open it owns the keyboard.
		if (showFind) return;

		// Form controls (rate slider, voice combo box) handle their own keys —
		// critically Up/Down must adjust them, not navigate the book.
		if (isFormTarget(e.target)) return;

		switch (e.code) {
			case 'Space':
				e.preventDefault();
				readerStore.togglePlayPause();
				break;
			// Left/Right: move by the current unit (sentence / paragraph / heading).
			case 'ArrowLeft':
				e.preventDefault();
				seekBy(-1);
				break;
			case 'ArrowRight':
				e.preventDefault();
				seekBy(1);
				break;
			// Up/Down: change the seek unit.
			case 'ArrowUp':
				e.preventDefault();
				changeSeekUnit(1);
				break;
			case 'ArrowDown':
				e.preventDefault();
				changeSeekUnit(-1);
				break;
		}
	}

	function onRateInput(e: Event) {
		readerStore.setRate(parseFloat((e.target as HTMLInputElement).value));
	}

	function onVoiceChange(e: Event) {
		readerStore.setVoice((e.target as HTMLSelectElement).value);
	}
</script>

<svelte:window
	onkeydown={handleKeydown}
	onbeforeunload={handleBeforeUnload}
	onvisibilitychange={handleVisibility}
/>

<div class="min-h-screen flex flex-col bg-gray-50 dark:bg-gray-900">
	<header class="flex items-center gap-3 p-4">
		<a
			href={parentHref}
			class="btn-ghost p-2 text-gray-700 dark:text-gray-300"
			aria-label={t('common.goBack')}
		>
			<Icon name="chevron-right" size={24} class="rotate-180" />
		</a>
		<span class="text-sm font-medium text-gray-500 dark:text-gray-400">{t('reader.reading')}</span>
	</header>

	<main class="flex-1 flex flex-col items-center justify-center gap-8 p-6 max-w-xl mx-auto w-full">
		{#if readerStore.isLoading}
			<p class="text-gray-500 dark:text-gray-400">{t('reader.loading')}</p>
		{:else if readerStore.error}
			<p class="text-red-600 dark:text-red-400" role="alert">{readerStore.error}</p>
		{:else}
			<div class="text-center">
				<Icon name="book" size={48} class="mx-auto text-gray-400 dark:text-gray-500" />
				<h1 class="mt-4 text-xl font-semibold text-gray-900 dark:text-gray-100">{readerStore.title}</h1>
				{#if readerStore.currentHeading}
					<p class="mt-1 text-base text-gray-600 dark:text-gray-300">{readerStore.currentHeading}</p>
				{/if}
			</div>

			<div class="w-full">
				<div
					class="h-2 w-full rounded-full bg-gray-200 dark:bg-gray-700 overflow-hidden"
					role="progressbar"
					aria-valuemin={0}
					aria-valuemax={100}
					aria-valuenow={progressPct}
					aria-valuetext={t('reader.progress', {
						pct: progressPct,
						current: readerStore.currentChunkIndex + 1,
						total: readerStore.totalChunks
					})}
				>
					<div class="h-full bg-blue-600 dark:bg-blue-500" style="width: {progressPct}%"></div>
				</div>
				<p class="mt-2 text-center text-sm text-gray-500 dark:text-gray-400">
					{t('reader.progress', {
						pct: progressPct,
						current: readerStore.currentChunkIndex + 1,
						total: readerStore.totalChunks
					})}
				</p>
			</div>

			<ReaderControls
				isPlaying={readerStore.isPlaying}
				bind:playButtonRef
				ontoggle={() => readerStore.togglePlayPause()}
				onprev={() => readerStore.prev()}
				onnext={() => readerStore.next()}
				onprevpara={() => readerStore.prevParagraph()}
				onnextpara={() => readerStore.nextParagraph()}
			/>

			<p class="text-xs text-gray-500 dark:text-gray-400">
				{t('reader.seekUnit')}: {unitLabel(seekUnit)}
			</p>

			<div class="w-full space-y-4">
				<div>
					<label
						for="rate-slider"
						class="block text-sm text-gray-600 dark:text-gray-400 mb-1"
					>
						{t('reader.rate')}: {readerStore.rate.toFixed(1)}x
					</label>
					<input
						id="rate-slider"
						type="range"
						min="0.5"
						max="5"
						step="0.1"
						value={readerStore.rate}
						oninput={onRateInput}
						class="w-full"
						aria-label={t('reader.rate')}
						aria-valuetext={`${readerStore.rate.toFixed(1)}x`}
					/>
				</div>

				<div>
					<label for="voice-select" class="block text-sm text-gray-600 dark:text-gray-400 mb-1">
						{t('reader.voice')}
					</label>
					<select
						id="voice-select"
						value={readerStore.voiceURI}
						onchange={onVoiceChange}
						class="input w-full"
						aria-label={t('reader.voice')}
					>
						{#each readerStore.voices as voice (voice.voiceURI)}
							<option value={voice.voiceURI}>{voice.name} ({voice.lang})</option>
						{/each}
					</select>
				</div>

				<button
					type="button"
					onclick={() => (showFind = true)}
					class="btn-secondary w-full flex items-center justify-center gap-2"
				>
					<Icon name="search" size={18} />
					{t('reader.findInBook')}
				</button>
			</div>

			<div class="sr-only" role="status" aria-live="polite">
				{readerStore.isPlaying ? t('reader.playing') : t('reader.paused')}
			</div>

			<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{seekUnitAnnouncement}
			</div>
		{/if}
	</main>
</div>

{#if showFind}
	<FindInBook
		onclose={() => {
			showFind = false;
			playButtonRef?.focus();
		}}
	/>
{/if}
