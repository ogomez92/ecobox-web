<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		volume: number;
		onchange: (volume: number) => void;
	}

	let { volume, onchange }: Props = $props();

	let isMuted = $state(false);
	let previousVolume = $state(1);

	function toggleMute() {
		if (isMuted) {
			onchange(previousVolume);
			isMuted = false;
		} else {
			previousVolume = volume;
			onchange(0);
			isMuted = true;
		}
	}

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		const newVolume = parseFloat(target.value);
		onchange(newVolume);
		isMuted = newVolume === 0;
	}
</script>

<div class="flex items-center gap-2">
	<button
		type="button"
		onclick={toggleMute}
		class="btn-ghost p-2"
		aria-label={isMuted || volume === 0 ? t('volume.unmute') : t('volume.mute')}
	>
		<Icon name={isMuted || volume === 0 ? 'volume-off' : 'volume'} size={20} />
	</button>

	<label class="flex-1 flex items-center gap-2">
		<span class="sr-only">{t('volume.label', { pct: Math.round(volume * 100) })}</span>
		<input
			type="range"
			min="0"
			max="1"
			step="0.05"
			value={volume}
			oninput={handleInput}
			class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer accent-primary-500"
			aria-label={t('volume.aria')}
		/>
	</label>

	<span class="text-sm text-gray-600 dark:text-gray-400 w-10 text-right" aria-hidden="true">
		{Math.round(volume * 100)}%
	</span>
</div>
