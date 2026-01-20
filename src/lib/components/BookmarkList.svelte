<script lang="ts">
	import Icon from './Icon.svelte';
	import { formatDuration } from '$lib/utils/format';
	import type { Bookmark } from '$server/db/schema';

	interface Props {
		bookmarks: Bookmark[];
		onselect: (time: number) => void;
		ondelete: (id: number) => void;
		onclose: () => void;
	}

	let { bookmarks, onselect, ondelete, onclose }: Props = $props();

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
	aria-labelledby="bookmark-list-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label="Close bookmark list"
	></button>

	<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:rounded-xl shadow-xl max-h-[80vh] overflow-hidden flex flex-col">
		<header class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
			<h2 id="bookmark-list-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
				Bookmarks
			</h2>
			<button
				type="button"
				onclick={onclose}
				class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
				aria-label="Close"
			>
				<Icon name="x" size={24} />
			</button>
		</header>

		{#if bookmarks.length === 0}
			<div class="flex-1 flex flex-col items-center justify-center py-12 px-4 text-center">
				<Icon name="bookmark" size={48} class="text-gray-400 mb-4" />
				<p class="text-gray-600 dark:text-gray-400">No bookmarks yet</p>
				<p class="text-sm text-gray-500 dark:text-gray-500 mt-1">
					Tap the bookmark button to add one
				</p>
			</div>
		{:else}
			<ul class="flex-1 overflow-y-auto divide-y divide-gray-100 dark:divide-gray-700" role="list">
				{#each bookmarks as bookmark}
					<li class="flex items-center gap-3 px-4 py-3">
						<button
							type="button"
							onclick={() => { onselect(bookmark.time); onclose(); }}
							class="flex-1 flex items-center gap-3 text-left hover:bg-gray-50 dark:hover:bg-gray-700 rounded-lg transition-colors -mx-2 px-2 py-1"
						>
							<div class="flex-shrink-0 w-8 h-8 rounded-full bg-primary-100 dark:bg-primary-900 flex items-center justify-center">
								<Icon name="bookmark" size={16} class="text-primary-600 dark:text-primary-400" />
							</div>
							<div class="flex-1 min-w-0">
								<p class="font-medium text-gray-900 dark:text-gray-100 truncate">
									{bookmark.label || 'Bookmark'}
								</p>
								<p class="text-sm text-gray-500 dark:text-gray-400">
									{formatDuration(bookmark.time)}
								</p>
							</div>
						</button>
						<button
							type="button"
							onclick={() => ondelete(bookmark.id)}
							class="btn-icon p-2 text-gray-400 hover:text-red-500"
							aria-label="Delete bookmark"
						>
							<Icon name="trash" size={20} />
						</button>
					</li>
				{/each}
			</ul>
		{/if}
	</div>
</div>
