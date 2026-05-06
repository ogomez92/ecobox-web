<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		speed: number;
		onchange: (speed: number) => void;
	}

	let { speed, onchange }: Props = $props();

	const presets = [0.5, 0.75, 1, 1.25, 1.5, 1.75, 2];

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onchange(parseFloat(target.value));
	}
</script>

<div class="space-y-3">
	<div class="flex items-center justify-between">
		<span class="text-sm text-gray-600 dark:text-gray-400">{t('speed.label')}</span>
		<span class="text-sm font-medium text-gray-900 dark:text-gray-100">{speed.toFixed(2)}x</span>
	</div>

	<label class="block">
		<span class="sr-only">{t('speed.srValue', { value: speed })}</span>
		<input
			type="range"
			min="0.5"
			max="2"
			step="0.05"
			value={speed}
			oninput={handleInput}
			class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer accent-primary-500"
			aria-label={t('speed.aria')}
		/>
	</label>

	<div class="flex justify-between gap-1" role="group" aria-label={t('speed.presets')}>
		{#each presets as preset}
			<button
				type="button"
				onclick={() => onchange(preset)}
				class="flex-1 py-1 text-xs rounded transition-colors min-h-[36px]"
				class:bg-primary-100={speed === preset}
				class:dark:bg-primary-900={speed === preset}
				class:text-primary-700={speed === preset}
				class:dark:text-primary-300={speed === preset}
				class:text-gray-600={speed !== preset}
				class:dark:text-gray-400={speed !== preset}
				class:hover:bg-gray-100={speed !== preset}
				class:dark:hover:bg-gray-800={speed !== preset}
				aria-pressed={speed === preset}
			>
				{preset}x
			</button>
		{/each}
	</div>
</div>
