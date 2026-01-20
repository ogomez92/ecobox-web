<script lang="ts">
	import { formatBytes } from '$lib/utils/format';
	import type { StorageInfo } from '$lib/types';

	interface Props {
		storage: StorageInfo | null;
	}

	let { storage }: Props = $props();

	const percentage = $derived(
		storage ? Math.round((storage.used / storage.total) * 100) : 0
	);
</script>

<footer
	class="fixed bottom-0 left-0 right-0 bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 px-4 py-3 safe-area-pb"
	aria-label="Storage information"
>
	{#if storage}
		<div class="max-w-4xl mx-auto">
			<div class="flex items-center justify-between text-sm mb-2">
				<span class="text-gray-600 dark:text-gray-400">
					{formatBytes(storage.used)} used
				</span>
				<span class="text-gray-600 dark:text-gray-400">
					{formatBytes(storage.free)} free
				</span>
			</div>
			<div
				class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"
				role="progressbar"
				aria-valuenow={percentage}
				aria-valuemin={0}
				aria-valuemax={100}
				aria-label="Storage usage: {percentage}% used"
			>
				<div
					class="h-full transition-all duration-300"
					class:bg-primary-500={percentage < 80}
					class:bg-yellow-500={percentage >= 80 && percentage < 95}
					class:bg-red-500={percentage >= 95}
					style="width: {percentage}%"
				></div>
			</div>
			<p class="sr-only">
				{formatBytes(storage.used)} of {formatBytes(storage.total)} used ({percentage}%)
			</p>
		</div>
	{:else}
		<div class="max-w-4xl mx-auto">
			<div class="h-2 bg-gray-200 dark:bg-gray-700 rounded-full animate-pulse"></div>
			<p class="sr-only">Loading storage information</p>
		</div>
	{/if}
</footer>

<style>
	.safe-area-pb {
		padding-bottom: max(0.75rem, env(safe-area-inset-bottom));
	}
</style>
