<script lang="ts">
	import Icon from './Icon.svelte';

	const SPEED_OPTIONS = [0.5, 1, 1.25, 1.5, 2] as const;

	interface Props {
		isPlaying: boolean;
		playbackRate: number;
		seekInterval: number;
		longSeekInterval: number;
		ontoggle: () => void;
		onratechange: (rate: number) => void;
		onseekback: () => void;
		onseekforward: () => void;
		onlongseekback: () => void;
		onlongseekforward: () => void;
		playButtonRef?: HTMLButtonElement | null;
		isRadio?: boolean;
	}

	let {
		isPlaying,
		playbackRate,
		seekInterval,
		longSeekInterval,
		ontoggle,
		onratechange,
		onseekback,
		onseekforward,
		onlongseekback,
		onlongseekforward,
		playButtonRef = $bindable(null),
		isRadio = false
	}: Props = $props();

	function cycleSpeed() {
		const currentIndex = SPEED_OPTIONS.indexOf(playbackRate as typeof SPEED_OPTIONS[number]);
		const nextIndex = currentIndex === -1 ? 1 : (currentIndex + 1) % SPEED_OPTIONS.length;
		onratechange(SPEED_OPTIONS[nextIndex]);
	}

	function formatSpeed(rate: number): string {
		return rate === 1 ? '1x' : `${rate}x`;
	}
</script>

<div class="flex items-center justify-center gap-2 sm:gap-4">
	{#if !isRadio}
		<button
			type="button"
			onclick={onlongseekback}
			class="btn-ghost p-3 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
			aria-label="Skip back {longSeekInterval} seconds"
		>
			<span class="relative">
				<Icon name="skip-back" size={24} />
				<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-medium">{longSeekInterval}</span>
			</span>
		</button>

		<button
			type="button"
			onclick={onseekback}
			class="btn-ghost p-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
			aria-label="Skip back {seekInterval} seconds"
		>
			<span class="relative">
				<Icon name="skip-back" size={28} />
				<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-xs font-medium">{seekInterval}</span>
			</span>
		</button>
	{/if}

	<button
		bind:this={playButtonRef}
		type="button"
		onclick={ontoggle}
		class="btn-primary w-16 h-16 sm:w-20 sm:h-20 rounded-full shadow-lg"
		aria-label={isPlaying ? 'Pause' : 'Play'}
	>
		<Icon name={isPlaying ? 'pause' : 'play'} size={32} />
	</button>

	<button
		type="button"
		onclick={cycleSpeed}
		class="btn-ghost px-2 py-1 min-w-[3rem] text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 rounded-lg"
		aria-label="Playback speed {formatSpeed(playbackRate)}"
	>
		{formatSpeed(playbackRate)}
	</button>

	{#if !isRadio}
		<button
			type="button"
			onclick={onseekforward}
			class="btn-ghost p-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
			aria-label="Skip forward {seekInterval} seconds"
		>
			<span class="relative">
				<Icon name="skip-forward" size={28} />
				<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-xs font-medium">{seekInterval}</span>
			</span>
		</button>

		<button
			type="button"
			onclick={onlongseekforward}
			class="btn-ghost p-3 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
			aria-label="Skip forward {longSeekInterval} seconds"
		>
			<span class="relative">
				<Icon name="skip-forward" size={24} />
				<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-medium">{longSeekInterval}</span>
			</span>
		</button>
	{/if}
</div>
