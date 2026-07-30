<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte';
	import { foldForSearch } from '$lib/utils/text';
	import { formatBytes } from '$lib/utils/format';
	import type { FileEntry } from '$lib/types';

	interface Props {
		/** Folder the search is scoped to — results come from here and below, never above. */
		currentPath: string;
		/**
		 * Closes the dialog. `restoreFocus: false` is passed when the close is part of
		 * opening a result — the destination page owns focus from there, and yanking it
		 * back to the browser would fight with it.
		 */
		onclose: (options?: { restoreFocus?: boolean }) => void;
	}

	let { currentPath, onclose }: Props = $props();

	let query = $state('');
	let inputElement: HTMLInputElement | null = $state(null);
	let panelElement: HTMLDivElement | null = $state(null);
	let resultsList: HTMLUListElement | null = $state(null);
	let results = $state<FileEntry[]>([]);
	let total = $state(0);
	let searched = $state(false);
	let searching = $state(false);
	let errorMessage = $state<string | null>(null);
	// Guards against a slow earlier request overwriting a newer one's results.
	let requestSeq = 0;

	// The results are a WAI-ARIA listbox (role="listbox" + role="option") with a
	// roving tabindex: only the active option is tabbable, so Tab treats the whole
	// list as one stop and the arrow/Home/End keys move within it.
	let activeIndex = $state(0);

	const scopeLabel = $derived(
		currentPath ? currentPath.split('/').filter(Boolean).slice(-1)[0] : t('breadcrumbs.home')
	);

	async function runSearch(e?: Event) {
		e?.preventDefault();
		const q = query.trim();
		if (!q) {
			// Nothing to search for — put the user back in the field rather than
			// showing an empty "no results" state they didn't ask for.
			inputElement?.focus();
			return;
		}

		const seq = ++requestSeq;
		searching = true;
		errorMessage = null;

		try {
			const params = new URLSearchParams({ path: currentPath, q });
			const res = await fetch(`/api/search?${params}`);
			if (seq !== requestSeq) return;
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { results: FileEntry[]; total: number };
			if (seq !== requestSeq) return;
			results = data.results;
			total = data.total;
		} catch {
			if (seq !== requestSeq) return;
			results = [];
			total = 0;
			errorMessage = t('search.error');
		} finally {
			if (seq === requestSeq) searching = false;
		}

		searched = true;
		// Land focus on the first hit so the list is immediately navigable. With no
		// hits, focus stays in the input so the query can be edited.
		activeIndex = 0;
		await tick();
		if (results.length > 0) focusOption(0);
	}

	/**
	 * Where a result opens. Mirrors FileRow: converted books go to the reader,
	 * DAISY/chaptered folders and audio files to the player, plain folders to the
	 * browser. A raw (unconverted) book isn't playable, so it opens its containing
	 * folder with the file focused, where the Convert action lives.
	 */
	function hrefFor(entry: FileEntry): string {
		if (entry.isDirectory) {
			if (entry.isBookFolder) return `/read/${entry.path}`;
			if (entry.isDaisyBook || entry.isChapteredFolder) return `/play/${entry.path}`;
			return `/browse/${entry.path}`;
		}
		if (entry.isRawBook) {
			const parent = parentOf(entry.path);
			const focus = `?focus=${encodeURIComponent(entry.name)}`;
			return parent ? `/browse/${parent}${focus}` : `/${focus}`;
		}
		return `/play/${entry.path}`;
	}

	function parentOf(p: string): string {
		return p.split('/').slice(0, -1).join('/');
	}

	/** Folder the hit lives in, expressed relative to the folder being searched. */
	function location(entry: FileEntry): string {
		const parent = parentOf(entry.path);
		const base = currentPath.replace(/\/+$/, '');
		if (!base) return parent || t('search.thisFolder');
		if (parent === base) return t('search.thisFolder');
		if (parent.startsWith(`${base}/`)) return parent.slice(base.length + 1);
		return parent || t('search.thisFolder');
	}

	function typeLabel(entry: FileEntry): string {
		if (entry.isDirectory) {
			if (entry.isBookFolder) return t('fileTypes.book');
			if (entry.isDaisyBook) return t('fileTypes.daisyBook');
			if (entry.isChapteredFolder) return t('fileTypes.chapteredFolder');
			return t('fileTypes.folder');
		}
		if (entry.isRawBook) return t('fileTypes.rawBook');
		if (entry.isRadioFile) return t('radio.label');
		const parts = entry.name.split('.');
		return t('fileTypes.fileExt', { ext: parts.length > 1 ? parts.pop()!.toUpperCase() : 'Audio' });
	}

	function iconFor(entry: FileEntry): 'folder' | 'book' | 'radio' | 'audio' {
		if (entry.isDirectory) return entry.isBookFolder || entry.isDaisyBook ? 'book' : 'folder';
		if (entry.isRawBook) return 'book';
		if (entry.isRadioFile) return 'radio';
		return 'audio';
	}

	function optionLabel(entry: FileEntry): string {
		const parts = [entry.name, typeLabel(entry), t('search.inFolder', { folder: location(entry) })];
		if (!entry.isDirectory) parts.push(formatBytes(entry.size));
		return parts.join(', ');
	}

	function openResult(entry: FileEntry) {
		onclose({ restoreFocus: false });
		goto(hrefFor(entry));
	}

	function focusOption(i: number) {
		resultsList?.querySelectorAll<HTMLElement>('[role="option"]')[i]?.focus();
	}

	function moveActive(i: number) {
		if (results.length === 0) return;
		activeIndex = Math.max(0, Math.min(i, results.length - 1));
		focusOption(activeIndex);
		resultsList?.querySelectorAll<HTMLElement>('[role="option"]')[activeIndex]?.scrollIntoView({
			block: 'nearest'
		});
	}

	function onOptionKeydown(e: KeyboardEvent, index: number) {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				moveActive(index + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				moveActive(index - 1);
				break;
			case 'Home':
				e.preventDefault();
				moveActive(0);
				break;
			case 'End':
				e.preventDefault();
				moveActive(results.length - 1);
				break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				openResult(results[index]);
				break;
		}
	}

	/**
	 * Escape closes (the caller restores focus to whatever opened the dialog);
	 * Tab cycles inside the panel so focus can't wander onto the file list behind
	 * the overlay while the dialog is modal.
	 */
	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onclose();
			return;
		}
		if (e.key !== 'Tab' || !panelElement) return;

		const focusable = Array.from(
			panelElement.querySelectorAll<HTMLElement>(
				'a[href], button:not([disabled]), input, [role="option"][tabindex="0"]'
			)
		).filter((el) => el.offsetParent !== null || el === document.activeElement);
		if (focusable.length === 0) return;

		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		if (e.shiftKey && document.activeElement === first) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && document.activeElement === last) {
			e.preventDefault();
			first.focus();
		}
	}

	/**
	 * Split a name into highlighted / plain segments for the query, using the same
	 * fold as the search. If folding changed the length (rare, pre-decomposed text)
	 * the indices no longer line up, so skip highlighting rather than mis-slice.
	 */
	function segments(text: string): { text: string; match: boolean }[] {
		const q = query.trim();
		if (!q) return [{ text, match: false }];
		const folded = foldForSearch(text);
		const fq = foldForSearch(q);
		if (!fq || folded.length !== text.length) return [{ text, match: false }];
		const out: { text: string; match: boolean }[] = [];
		let i = 0;
		while (i < text.length) {
			const idx = folded.indexOf(fq, i);
			if (idx === -1) {
				out.push({ text: text.slice(i), match: false });
				break;
			}
			if (idx > i) out.push({ text: text.slice(i, idx), match: false });
			out.push({ text: text.slice(idx, idx + fq.length), match: true });
			i = idx + fq.length;
		}
		return out;
	}

	$effect(() => {
		inputElement?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-start sm:items-center justify-center p-4 pt-16 sm:pt-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="file-search-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={() => onclose()}
		aria-label={t('common.closeDialog')}
	></button>

	<div
		bind:this={panelElement}
		class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[80vh] flex flex-col"
	>
		<div class="flex items-center justify-between mb-1">
			<h2 id="file-search-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
				{t('search.title')}
			</h2>
			<button
				type="button"
				onclick={() => onclose()}
				class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
				aria-label={t('common.close')}
			>
				<Icon name="x" size={20} />
			</button>
		</div>

		<p id="file-search-scope" class="text-sm text-gray-500 dark:text-gray-400 mb-4">
			{t('search.scope', { folder: scopeLabel })}
		</p>

		<form onsubmit={runSearch} class="mb-4">
			<label for="file-search-input" class="sr-only">{t('search.label')}</label>
			<div class="flex gap-2">
				<input
					bind:this={inputElement}
					id="file-search-input"
					type="text"
					bind:value={query}
					placeholder={t('search.placeholder')}
					class="input flex-1"
					autocomplete="off"
					autocapitalize="none"
					spellcheck="false"
					aria-describedby="file-search-scope file-search-hint"
				/>
				<button type="submit" class="btn-primary" disabled={searching}>
					{t('search.button')}
				</button>
			</div>
		</form>

		<p id="file-search-hint" class="sr-only">{t('search.hint')}</p>

		<div class="sr-only" role="status" aria-live="polite">
			{#if searching}
				{t('search.searching')}
			{:else if errorMessage}
				{errorMessage}
			{:else if searched}
				{total === 0 ? t('search.noResults') : t('search.resultsCount', { n: total })}
			{/if}
		</div>

		{#if searching}
			<p class="text-sm text-gray-500 dark:text-gray-400">{t('search.searching')}</p>
		{:else if errorMessage}
			<p class="text-sm text-red-600 dark:text-red-400" role="alert">{errorMessage}</p>
		{:else if searched}
			{#if total === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">{t('search.noResults')}</p>
			{:else}
				{#if total > results.length}
					<p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
						{t('search.showingFirst', { shown: results.length, total })}
					</p>
				{/if}
				<ul
					bind:this={resultsList}
					role="listbox"
					class="overflow-y-auto flex-1 space-y-1"
					aria-label={t('search.resultsList')}
				>
					{#each results as entry, i (entry.path)}
						<li
							role="option"
							aria-selected={i === activeIndex}
							aria-label={optionLabel(entry)}
							tabindex={i === activeIndex ? 0 : -1}
							onclick={() => openResult(entry)}
							onkeydown={(e) => onOptionKeydown(e, i)}
							onfocus={() => (activeIndex = i)}
							class="flex items-center gap-3 p-2 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-primary-500 aria-selected:bg-gray-100 dark:aria-selected:bg-gray-700"
						>
							<div
								class="flex-shrink-0 w-8 h-8 rounded-lg flex items-center justify-center"
								class:bg-primary-100={entry.isDirectory}
								class:dark:bg-primary-900={entry.isDirectory}
								class:bg-gray-100={!entry.isDirectory}
								class:dark:bg-gray-700={!entry.isDirectory}
							>
								<Icon
									name={iconFor(entry)}
									size={16}
									class={entry.isDirectory
										? 'text-primary-600 dark:text-primary-400'
										: 'text-gray-600 dark:text-gray-400'}
								/>
							</div>
							<span class="min-w-0 flex-1">
								<span class="block text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
									{#each segments(entry.name) as seg}{#if seg.match}<mark
												class="bg-yellow-200 dark:bg-yellow-700 dark:text-white">{seg.text}</mark
											>{:else}{seg.text}{/if}{/each}
								</span>
								<span class="block text-xs text-gray-500 dark:text-gray-400 truncate">
									{location(entry)}
								</span>
							</span>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>
