<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from './Icon.svelte';
	import { formatDuration } from '$lib/utils/format';
	import { t } from '$lib/i18n/index.svelte';
	import type { Chapter } from '$lib/types';

	interface Props {
		chapters: Chapter[];
		currentChapterIndex: number;
		onselect: (index: number) => void;
		onclose: () => void;
	}

	let { chapters, currentChapterIndex, onselect, onclose }: Props = $props();

	// Roving tabindex. Focus starts on the chapter that's playing (set on mount),
	// so opening the list lands a screen reader where the listener actually is.
	let focusedIndex = $state(0);
	let itemRefs: Array<HTMLButtonElement | null> = $state([]);

	function focusItem(idx: number) {
		const clamped = Math.max(0, Math.min(chapters.length - 1, idx));
		focusedIndex = clamped;
		itemRefs[clamped]?.focus();
	}

	onMount(() => {
		tick().then(() => {
			if (chapters.length > 0) {
				focusItem(Math.max(0, currentChapterIndex));
				itemRefs[focusedIndex]?.scrollIntoView({ block: 'center' });
			}
		});
	});

	function selectAt(idx: number) {
		if (idx < 0 || idx >= chapters.length) return;
		onselect(idx);
		onclose();
	}

	function handleDialogKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function handleListKeydown(e: KeyboardEvent) {
		if (chapters.length === 0) return;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				focusItem(focusedIndex + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				focusItem(focusedIndex - 1);
				break;
			case 'Home':
				e.preventDefault();
				focusItem(0);
				break;
			case 'End':
				e.preventDefault();
				focusItem(chapters.length - 1);
				break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				selectAt(focusedIndex);
				break;
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
	role="dialog"
	aria-modal="true"
	aria-labelledby="chapter-list-title"
	onkeydown={handleDialogKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('chapters.closeList')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:rounded-xl shadow-xl max-h-[80vh] overflow-hidden flex flex-col">
		<header class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
			<h2 id="chapter-list-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
				{t('chapters.title')}
			</h2>
			<button
				type="button"
				onclick={onclose}
				class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
				aria-label={t('common.close')}
			>
				<Icon name="x" size={24} />
			</button>
		</header>

		{#if chapters.length === 0}
			<div class="flex-1 flex flex-col items-center justify-center py-12 px-4 text-center">
				<Icon name="menu" size={48} class="text-gray-400 mb-4" />
				<p class="text-gray-600 dark:text-gray-400">{t('chapters.empty')}</p>
			</div>
		{:else}
			<p id="chapter-list-hint" class="sr-only">
				{t('chapters.hint')}
			</p>
			<ul
				class="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700"
				role="listbox"
				aria-labelledby="chapter-list-title"
				aria-describedby="chapter-list-hint"
				onkeydown={handleListKeydown}
			>
				{#each chapters as chapter, index}
					{@const isCurrent = index === currentChapterIndex}
					<li>
						<button
							bind:this={itemRefs[index]}
							type="button"
							role="option"
							aria-selected={isCurrent}
							tabindex={focusedIndex === index ? 0 : -1}
							onclick={() => selectAt(index)}
							onfocus={() => { focusedIndex = index; }}
							class="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-primary-500 {isCurrent ? 'bg-primary-50 dark:bg-primary-900' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}"
						>
							<div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm"
								class:bg-primary-500={isCurrent}
								class:text-white={isCurrent}
								class:bg-gray-200={!isCurrent}
								class:dark:bg-gray-700={!isCurrent}
								class:text-gray-600={!isCurrent}
								class:dark:text-gray-400={!isCurrent}
							>
								{index + 1}
							</div>
							<div class="flex-1 min-w-0">
								<p class="font-medium truncate"
									class:text-primary-700={isCurrent}
									class:dark:text-primary-300={isCurrent}
									class:text-gray-900={!isCurrent}
									class:dark:text-gray-100={!isCurrent}
								>
									{chapter.title || t('chapters.numbered', { n: index + 1 })}
								</p>
							</div>
							<span class="text-sm text-gray-500 dark:text-gray-400">
								{formatDuration(chapter.startTime)}
							</span>
							{#if isCurrent}
								<Icon name="play" size={16} class="text-primary-500" />
								<span class="sr-only">{t('chapters.playing')}</span>
							{/if}
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
