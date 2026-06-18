<script lang="ts">
	import { tick } from 'svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { readerStore, foldForSearch } from '$lib/stores/reader.svelte';
	import type { Chunk } from '$lib/types';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	let query = $state('');
	let inputElement: HTMLInputElement | null = $state(null);
	let resultsList: HTMLUListElement | null = $state(null);
	let results = $state<Chunk[]>([]);
	let total = $state(0);
	let searched = $state(false);

	// The results are a WAI-ARIA listbox (role="listbox" + role="option"). Focus
	// uses a roving tabindex: only the active option is tabbable (tabindex 0), the
	// rest are -1, so Tab enters/leaves the whole list as a single stop and the
	// arrow/Home/End keys move within it.
	let activeIndex = $state(0);

	async function handleSubmit(e: Event) {
		e.preventDefault();
		const r = readerStore.find(query);
		results = r.results;
		total = r.total;
		searched = true;
		// Land focus on the first hit so the list is immediately navigable. With no
		// hits, focus stays in the input so the query can be edited.
		activeIndex = 0;
		await tick();
		if (results.length > 0) focusOption(0);
	}

	function selectResult(chunk: Chunk) {
		// Jump and begin reading from that sentence (stops any current speech).
		readerStore.seekToChunk(chunk.i, true);
		onclose();
	}

	function focusOption(i: number) {
		resultsList?.querySelectorAll<HTMLElement>('[role="option"]')[i]?.focus();
	}

	// Move the roving focus, clamped to the list bounds.
	function moveActive(i: number) {
		if (results.length === 0) return;
		activeIndex = Math.max(0, Math.min(i, results.length - 1));
		focusOption(activeIndex);
	}

	// Keyboard nav while an option has focus: Up/Down step, Home/End jump to the
	// first/last hit, Enter/Space select.
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
				selectResult(results[index]);
				break;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}

	// Split a result's text into highlighted / plain segments for the query.
	// Matching is case- and accent-insensitive (same folding as the search). The
	// fold must keep index alignment with the original to slice highlights; if it
	// doesn't (rare, e.g. pre-decomposed text), fall back to no highlight.
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

	// Nearest preceding heading (chapter title), or a paragraph label.
	function label(chunk: Chunk): string {
		for (let i = chunk.i; i >= 0; i--) {
			const c = readerStore.chunks[i];
			if (c?.type === 'heading') return c.text;
		}
		return t('reader.paragraphN', { n: chunk.para + 1 });
	}

	$effect(() => {
		inputElement?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="find-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div
		class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-lg p-6 max-h-[80vh] flex flex-col"
	>
		<h2 id="find-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
			{t('reader.findInBook')}
		</h2>

		<form onsubmit={handleSubmit} class="mb-4">
			<label for="find-input" class="sr-only">{t('reader.findInBook')}</label>
			<div class="flex gap-2">
				<input
					bind:this={inputElement}
					id="find-input"
					type="text"
					bind:value={query}
					placeholder={t('reader.findPlaceholder')}
					class="input flex-1"
					autocomplete="off"
				/>
				<button type="submit" class="btn-primary">{t('reader.findButton')}</button>
			</div>
		</form>

		<div class="sr-only" role="status" aria-live="polite">
			{#if searched}{t('reader.resultsCount', { n: total })}{/if}
		</div>

		{#if searched}
			{#if total === 0}
				<p class="text-sm text-gray-500 dark:text-gray-400">{t('reader.noResults')}</p>
			{:else}
				{#if total > results.length}
					<p class="text-xs text-gray-500 dark:text-gray-400 mb-2">
						{t('reader.showingFirst', { shown: results.length, total })}
					</p>
				{/if}
				<ul
					bind:this={resultsList}
					role="listbox"
					class="overflow-y-auto flex-1 space-y-1"
					aria-label={t('reader.resultsList')}
				>
					{#each results as chunk, i (chunk.i)}
						<li
							role="option"
							aria-selected={i === activeIndex}
							tabindex={i === activeIndex ? 0 : -1}
							onclick={() => selectResult(chunk)}
							onkeydown={(e) => onOptionKeydown(e, i)}
							class="block p-2 rounded-lg cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 aria-selected:bg-gray-100 dark:aria-selected:bg-gray-700"
						>
							<span class="block text-sm text-gray-800 dark:text-gray-200">
								{#each segments(chunk.text) as seg}{#if seg.match}<mark
											class="bg-yellow-200 dark:bg-yellow-700 dark:text-white">{seg.text}</mark
										>{:else}{seg.text}{/if}{/each}
							</span>
							<span class="block text-xs text-gray-500 dark:text-gray-400 mt-0.5"
								>{label(chunk)}</span
							>
						</li>
					{/each}
				</ul>
			{/if}
		{/if}
	</div>
</div>
