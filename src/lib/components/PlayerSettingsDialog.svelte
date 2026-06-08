<script lang="ts">
	import { onMount, tick } from 'svelte';
	import Icon from './Icon.svelte';
	import SpeedControl from './SpeedControl.svelte';
	import { playerStore } from '$lib/stores/player.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	let closeButtonRef: HTMLButtonElement | null = $state(null);

	onMount(() => {
		// Move focus into the dialog when it opens (parent restores focus on close).
		tick().then(() => closeButtonRef?.focus());
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
	role="dialog"
	aria-modal="true"
	aria-labelledby="player-settings-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.close')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:rounded-xl shadow-xl max-h-[80vh] overflow-hidden flex flex-col">
		<header class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
			<h2 id="player-settings-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
				{t('common.settings')}
			</h2>
			<button
				bind:this={closeButtonRef}
				type="button"
				onclick={onclose}
				class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
				aria-label={t('common.close')}
			>
				<Icon name="x" size={24} />
			</button>
		</header>

		<div class="p-4 overflow-y-auto">
			<SpeedControl
				speed={playerStore.playbackRate}
				onchange={(s) => playerStore.setPlaybackRate(s)}
			/>
		</div>
	</div>
</div>
