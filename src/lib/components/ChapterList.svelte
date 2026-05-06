<script lang="ts">
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

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
	role="dialog"
	aria-modal="true"
	aria-labelledby="chapter-list-title"
	onkeydown={handleKeydown}
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

		<ul class="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700" role="listbox">
			{#each chapters as chapter, index}
				<li>
					<button
						type="button"
						onclick={() => { onselect(index); onclose(); }}
						class="w-full flex items-center gap-3 px-4 py-3 text-left transition-colors {index === currentChapterIndex ? 'bg-primary-50 dark:bg-primary-900' : 'hover:bg-gray-50 dark:hover:bg-gray-700'}"
						role="option"
						aria-selected={index === currentChapterIndex}
					>
						<div class="flex-shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-sm"
							class:bg-primary-500={index === currentChapterIndex}
							class:text-white={index === currentChapterIndex}
							class:bg-gray-200={index !== currentChapterIndex}
							class:dark:bg-gray-700={index !== currentChapterIndex}
							class:text-gray-600={index !== currentChapterIndex}
							class:dark:text-gray-400={index !== currentChapterIndex}
						>
							{index + 1}
						</div>
						<div class="flex-1 min-w-0">
							<p class="font-medium truncate"
								class:text-primary-700={index === currentChapterIndex}
								class:dark:text-primary-300={index === currentChapterIndex}
								class:text-gray-900={index !== currentChapterIndex}
								class:dark:text-gray-100={index !== currentChapterIndex}
							>
								{chapter.title || t('chapters.numbered', { n: index + 1 })}
							</p>
						</div>
						<span class="text-sm text-gray-500 dark:text-gray-400">
							{formatDuration(chapter.startTime)}
						</span>
						{#if index === currentChapterIndex}
							<Icon name="play" size={16} class="text-primary-500" />
						{/if}
					</button>
				</li>
			{/each}
		</ul>
	</div>
</div>
