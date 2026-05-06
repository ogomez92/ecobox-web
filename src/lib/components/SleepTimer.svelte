<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		onstart: (minutes: number) => void;
		oncancel: () => void;
		onclose: () => void;
		activeMinutes: number | null;
		remainingSeconds: number;
	}

	let { onstart, oncancel, onclose, activeMinutes, remainingSeconds }: Props = $props();

	const durations = [5, 10, 15, 30, 45, 60, 90, 120];

	function formatRemaining(seconds: number): string {
		const mins = Math.floor(seconds / 60);
		const secs = seconds % 60;
		return `${mins}:${secs.toString().padStart(2, '0')}`;
	}

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
	aria-labelledby="sleep-timer-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('sleepTimer.close')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-sm sm:rounded-xl shadow-xl overflow-hidden">
		<header class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
			<h2 id="sleep-timer-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
				{t('sleepTimer.title')}
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

		<div class="p-4">
			{#if activeMinutes !== null}
				{@const mins = Math.ceil(remainingSeconds / 60)}
				<div class="text-center py-6">
					<div class="text-4xl font-bold text-primary-600 dark:text-primary-400 mb-2">
						{formatRemaining(remainingSeconds)}
					</div>
					<p class="text-gray-600 dark:text-gray-400 mb-6">
						{t(mins === 1 ? 'sleepTimer.willPauseOne' : 'sleepTimer.willPauseOther', { n: mins })}
					</p>
					<button
						type="button"
						onclick={oncancel}
						class="btn-secondary"
					>
						{t('sleepTimer.cancel')}
					</button>
				</div>
			{:else}
				<p class="text-sm text-gray-600 dark:text-gray-400 mb-4">
					{t('sleepTimer.description')}
				</p>

				<div class="grid grid-cols-4 gap-2">
					{#each durations as minutes}
						<button
							type="button"
							onclick={() => { onstart(minutes); onclose(); }}
							class="py-3 px-2 text-center rounded-lg bg-gray-100 dark:bg-gray-700 hover:bg-primary-100 dark:hover:bg-primary-900 transition-colors min-h-[60px]"
						>
							<span class="block text-lg font-semibold text-gray-900 dark:text-gray-100">
								{minutes}
							</span>
							<span class="block text-xs text-gray-500 dark:text-gray-400">
								{t('sleepTimer.minShort')}
							</span>
						</button>
					{/each}
				</div>
			{/if}
		</div>
	</div>
</div>
