<script lang="ts">
	import { onMount, onDestroy } from 'svelte';
	import { beforeNavigate, goto } from '$app/navigation';
	import { readerStore } from '$lib/stores/reader.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { ttsConfigStore } from '$lib/stores/ttsConfig.svelte';
	import { recentStore } from '$lib/stores/recent.svelte';
	import ReaderControls from './ReaderControls.svelte';
	import FindInBook from './FindInBook.svelte';
	import BookmarkList from './BookmarkList.svelte';
	import BookInfoDialog from './BookInfoDialog.svelte';
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import type { BookInfo } from '$lib/types';

	interface Props {
		bookPath: string;
	}

	let { bookPath }: Props = $props();

	let playButtonRef = $state<HTMLButtonElement | null>(null);
	let audioEl = $state<HTMLAudioElement | null>(null);
	let showFind = $state(false);

	// Book info modal + the UI-only "language not detected" warning. Both read from
	// the additive /api/books/info endpoint (the app-facing /content is untouched).
	let bookInfo = $state<BookInfo | null>(null);
	let showInfo = $state(false);
	let showLangWarning = $state(false);

	async function loadBookInfo() {
		try {
			const res = await fetch(`/api/books/info?path=${encodeURIComponent(bookPath)}`);
			if (!res.ok) return;
			bookInfo = await res.json();
			// Only nag when detection actually fell back ('default'); 'unknown' (older
			// books, never recorded) stays silent to avoid spurious warnings.
			if (bookInfo?.localeSource === 'default') showLangWarning = true;
		} catch {
			// Non-fatal — the info button just stays disabled.
		}
	}

	function onInfoSaved(updated: BookInfo) {
		bookInfo = updated;
		readerStore.setLocale(updated.locale);
		showLangWarning = false;
	}

	// Bookmarks — the TTS analogue of the player's time bookmarks: a saved chunk
	// (sentence) index + optional label. Persisted via /api/books/bookmarks (the
	// same endpoint the iOS app uses), and shown through the shared BookmarkList.
	type BookBookmark = { chunkIndex: number; label: string | null };
	let bookmarks = $state<BookBookmark[]>([]);
	let showBookmarks = $state(false);
	let bookmarkAnnouncement = $state('');

	const isBookmarked = $derived(
		bookmarks.some((b) => b.chunkIndex === readerStore.currentChunkIndex)
	);

	// Secondary line in the list: a preview of the bookmarked sentence (or its number).
	function bookmarkDetail(chunkIndex: number): string {
		const text = readerStore.chunks[chunkIndex]?.text?.trim();
		if (text) return text.length > 80 ? text.slice(0, 80) + '…' : text;
		return t('reader.bookmarkSentence', { n: chunkIndex + 1 });
	}

	const bookmarkEntries = $derived(
		bookmarks.map((b) => ({
			id: b.chunkIndex,
			label: b.label ?? '',
			detail: bookmarkDetail(b.chunkIndex),
			deleteAria: t('reader.deleteBookmarkAt', { n: b.chunkIndex + 1 })
		}))
	);

	function announceBookmark(message: string) {
		bookmarkAnnouncement = message;
		setTimeout(() => {
			bookmarkAnnouncement = '';
		}, 1000);
	}

	// T: announce reading position — percentage and, for books with headings,
	// the current chapter ("n%, chapter x of y"). The player's analogue reads
	// out time remaining; here position is a chunk index, so percent + chapter.
	let progressAnnouncement = $state('');
	function announceProgress() {
		const pct = Math.round(readerStore.progress);
		const total = readerStore.chapterCount;
		const chapter = readerStore.currentChapter;
		progressAnnouncement =
			total > 0 && chapter > 0
				? t('reader.progressAnnounce', { pct, chapter, total })
				: t('reader.progressPercent', { pct });
		// Clear after a moment so repeat presses re-announce.
		setTimeout(() => {
			progressAnnouncement = '';
		}, 1000);
		// For cloud services with a subscription character quota (currently
		// ElevenLabs), also announce how many characters are left in the plan.
		void announceCharactersRemaining();
	}

	// Quota readout for the active TTS service. Web Speech is local (no quota) and
	// other cloud services (Azure/Google) expose usage only through cloud billing,
	// so /api/tts/quota returns { supported: false } for them and we stay silent.
	let quotaAnnouncement = $state('');
	let quotaInFlight = false;
	async function announceCharactersRemaining() {
		const service = readerStore.service;
		if (service === 'webspeech' || quotaInFlight) return;
		quotaInFlight = true;
		try {
			const res = await fetch(`/api/tts/quota?service=${encodeURIComponent(service)}`);
			if (!res.ok) return;
			const data = (await res.json()) as { remaining?: number };
			if (typeof data.remaining !== 'number') return; // service has no quota
			quotaAnnouncement = t('reader.charactersRemaining', {
				remaining: data.remaining.toLocaleString()
			});
			setTimeout(() => {
				quotaAnnouncement = '';
			}, 1500);
		} catch {
			// Non-fatal — pressing T still announced reading position.
		} finally {
			quotaInFlight = false;
		}
	}

	async function loadBookmarks() {
		try {
			const res = await fetch(`/api/books/bookmarks?path=${encodeURIComponent(bookPath)}`);
			if (res.ok) bookmarks = await res.json();
		} catch {
			// Non-critical — reading works without bookmarks.
		}
	}

	async function addBookmark() {
		const chunkIndex = readerStore.currentChunkIndex;
		try {
			const res = await fetch('/api/books/bookmarks', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ bookFolderPath: bookPath, chunkIndex })
			});
			if (res.ok) {
				await loadBookmarks();
				announceBookmark(t('reader.bookmarkAdded'));
			}
		} catch {
			// ignore
		}
	}

	async function removeBookmark(chunkIndex: number) {
		try {
			const res = await fetch(
				`/api/books/bookmarks?path=${encodeURIComponent(bookPath)}&chunkIndex=${chunkIndex}`,
				{ method: 'DELETE' }
			);
			if (res.ok) {
				await loadBookmarks();
				announceBookmark(t('reader.bookmarkRemoved'));
			}
		} catch {
			// ignore
		}
	}

	function toggleBookmark() {
		if (isBookmarked) removeBookmark(readerStore.currentChunkIndex);
		else addBookmark();
	}

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
			// Settings (saved speed + service) and TTS config before loadBook, the
			// <audio> element wired before play, and voices before autoplay —
			// otherwise the first unit uses the default rate/voice, not the saved one.
			await settingsStore.load();
			await ttsConfigStore.load();
			readerStore.initializeAudio(audioEl);
			await readerStore.loadBook(bookPath);
			recentStore.record(bookPath, 'book');
			loadBookmarks();
			loadBookInfo();
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

	// Winamp b/z in the book reader navigate by chapter (heading). The reader store's
	// heading nav resumes reading if we were already playing, mirroring the media player.
	function nextTrack() {
		readerStore.nextHeading();
	}
	function prevTrack() {
		readerStore.prevHeading();
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

		// Ctrl/Cmd+I: open Book info (once loaded, and not stacked over another modal).
		if (e.code === 'KeyI' && (e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey) {
			e.preventDefault();
			if (bookInfo && !showFind && !showBookmarks && !showInfo && !showLangWarning) {
				showInfo = true;
			}
			return;
		}

		// While a modal is open it owns the keyboard (find, bookmarks, info, warning).
		if (showFind || showBookmarks || showInfo || showLangWarning) return;

		// Form controls (rate slider, voice combo box) handle their own keys —
		// critically Up/Down must adjust them, not navigate the book.
		if (isFormTarget(e.target)) return;

		// Winamp-style transport keys (opt-in). Bare keys only. x/c/v control
		// playback; b/z move to the next/previous chapter (heading).
		if (settingsStore.winampShortcuts && !e.ctrlKey && !e.metaKey && !e.altKey && !e.shiftKey) {
			switch (e.code) {
				case 'KeyX': // play — never pauses if already playing
					e.preventDefault();
					if (!readerStore.isPlaying) readerStore.play();
					return;
				case 'KeyC': // play / pause toggle
					e.preventDefault();
					readerStore.togglePlayPause();
					return;
				case 'KeyV': // stop == pause (keeps the reading position)
					e.preventDefault();
					readerStore.pause();
					return;
				case 'KeyB': // next chapter (heading)
					e.preventDefault();
					nextTrack();
					return;
				case 'KeyZ': // previous chapter (heading)
					e.preventDefault();
					prevTrack();
					return;
			}
		}

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
			// M: toggle a bookmark on the current sentence; Shift+M: open the list.
			case 'KeyM':
				e.preventDefault();
				if (e.shiftKey) showBookmarks = true;
				else toggleBookmark();
				break;
			// T: announce reading position (percentage + chapter).
			case 'KeyT':
				e.preventDefault();
				announceProgress();
				break;
		}
	}

	function onRateInput(e: Event) {
		readerStore.setRate(parseFloat((e.target as HTMLInputElement).value));
	}
</script>

<svelte:window
	onkeydown={handleKeydown}
	onbeforeunload={handleBeforeUnload}
	onvisibilitychange={handleVisibility}
/>

<!-- Shared sink for audio-based TTS services (ElevenLabs/Azure/Google). Web Speech
	 doesn't use it. Wired to the reader via initializeAudio(); a real media element
	 is what enables MediaSession / lock-screen controls for those services. -->
<audio bind:this={audioEl} preload="auto" class="hidden"></audio>

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
		<button
			type="button"
			class="btn-ghost p-2 ml-auto text-gray-700 dark:text-gray-300"
			aria-label={t('reader.bookInfo')}
			onclick={() => (showInfo = true)}
			disabled={!bookInfo}
		>
			<Icon name="info" size={22} />
		</button>
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

				<!-- Voice selection lives in Settings (provider tabs + voice params).
				     This jumps there with the provider selector focused on arrival. -->
				<button
					type="button"
					onclick={() => goto('/settings#tts-service')}
					class="btn-secondary flex items-center gap-2"
				>
					<Icon name="settings" size={16} />
					{t('reader.changeVoice')}
				</button>

				<div class="flex flex-wrap justify-center gap-2">
					<button
						type="button"
						onclick={toggleBookmark}
						class="btn-secondary flex items-center justify-center gap-2 {isBookmarked
							? 'text-primary-600 dark:text-primary-400'
							: ''}"
						aria-pressed={isBookmarked}
						aria-label={isBookmarked
							? t('reader.removeBookmarkAria')
							: t('reader.addBookmarkAria')}
					>
						<Icon name="bookmark" size={18} fill={isBookmarked ? 'currentColor' : 'none'} />
						{isBookmarked ? t('reader.removeBookmark') : t('reader.addBookmark')}
					</button>

					{#if bookmarks.length > 0}
						{@const countLabel = t(
							bookmarks.length === 1 ? 'bookmarks.countOne' : 'bookmarks.countOther',
							{ n: bookmarks.length }
						)}
						<button
							type="button"
							onclick={() => (showBookmarks = true)}
							class="btn-secondary flex items-center justify-center gap-2"
							aria-label={t('bookmarks.openListAria', { count: countLabel })}
						>
							<Icon name="bookmark" size={18} />
							{t('bookmarks.button', { count: bookmarks.length })}
						</button>
					{/if}

					<button
						type="button"
						onclick={() => (showFind = true)}
						class="btn-secondary flex items-center justify-center gap-2"
					>
						<Icon name="search" size={18} />
						{t('reader.findInBook')}
					</button>
				</div>
			</div>

			{#if readerStore.isSynthesizing}
				<p
					class="flex items-center gap-2 text-sm text-gray-500 dark:text-gray-400"
					role="status"
					aria-live="polite"
				>
					<span
						class="inline-block w-4 h-4 rounded-full border-2 border-gray-300 border-t-blue-600 animate-spin"
						aria-hidden="true"
					></span>
					{t('reader.generating')}
				</p>
			{/if}

			{#if readerStore.notice}
				<p class="text-sm text-amber-600 dark:text-amber-400" role="status" aria-live="polite">
					{readerStore.notice}
				</p>
			{/if}

			<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{seekUnitAnnouncement}
			</div>

			<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{bookmarkAnnouncement}
			</div>

			<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{progressAnnouncement}
			</div>

			<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
				{quotaAnnouncement}
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

{#if showBookmarks}
	<BookmarkList
		bookmarks={bookmarkEntries}
		onselect={(id: number) => readerStore.seekToChunk(id)}
		ondelete={(id: number) => removeBookmark(id)}
		onclose={() => {
			showBookmarks = false;
			playButtonRef?.focus();
		}}
	/>
{/if}

{#if showInfo && bookInfo}
	<BookInfoDialog
		{bookPath}
		info={bookInfo}
		onsaved={onInfoSaved}
		onclose={() => {
			showInfo = false;
			playButtonRef?.focus();
		}}
	/>
{/if}

<!-- UI-only warning when the book's language couldn't be detected. -->
{#if showLangWarning && bookInfo}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="langwarn-title"
		aria-describedby="langwarn-body"
		onkeydown={(e) => {
			if (e.key === 'Escape') {
				e.stopPropagation();
				showLangWarning = false;
			}
		}}
		tabindex="-1"
	>
		<button
			type="button"
			class="absolute inset-0 bg-black/50"
			onclick={() => (showLangWarning = false)}
			aria-label={t('common.closeDialog')}
		></button>
		<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
			<h2 id="langwarn-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
				{t('reader.langWarnTitle')}
			</h2>
			<p id="langwarn-body" class="text-sm text-gray-600 dark:text-gray-300">
				{t('reader.langWarnBody', { locale: bookInfo.locale })}
			</p>
			<div class="mt-5 flex justify-end gap-2">
				<button type="button" class="btn-secondary" onclick={() => (showLangWarning = false)}>
					{t('reader.langWarnDismiss')}
				</button>
				<button
					type="button"
					class="btn-primary"
					onclick={() => {
						showLangWarning = false;
						showInfo = true;
					}}
				>
					{t('reader.langWarnSet')}
				</button>
			</div>
		</div>
	</div>
{/if}
