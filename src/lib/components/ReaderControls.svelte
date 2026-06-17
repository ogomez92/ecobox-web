<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		isPlaying: boolean;
		ontoggle: () => void;
		onprev: () => void;
		onnext: () => void;
		onprevpara: () => void;
		onnextpara: () => void;
		playButtonRef?: HTMLButtonElement | null;
	}

	let {
		isPlaying,
		ontoggle,
		onprev,
		onnext,
		onprevpara,
		onnextpara,
		playButtonRef = $bindable(null)
	}: Props = $props();
</script>

<div class="flex items-center justify-center gap-2 sm:gap-4">
	<button
		type="button"
		onclick={onprevpara}
		class="btn-ghost p-3 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
		aria-label={t('reader.prevPara')}
	>
		<span class="relative">
			<Icon name="skip-back" size={24} />
			<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-medium">¶</span>
		</span>
	</button>

	<button
		type="button"
		onclick={onprev}
		class="btn-ghost p-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
		aria-label={t('reader.prevSentence')}
	>
		<Icon name="skip-back" size={28} />
	</button>

	<button
		bind:this={playButtonRef}
		type="button"
		onclick={ontoggle}
		class="btn-primary w-16 h-16 sm:w-20 sm:h-20 rounded-full shadow-lg"
		aria-label={isPlaying ? t('reader.pause') : t('reader.play')}
	>
		<Icon name={isPlaying ? 'pause' : 'play'} size={32} />
	</button>

	<button
		type="button"
		onclick={onnext}
		class="btn-ghost p-3 text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
		aria-label={t('reader.nextSentence')}
	>
		<Icon name="skip-forward" size={28} />
	</button>

	<button
		type="button"
		onclick={onnextpara}
		class="btn-ghost p-3 text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100"
		aria-label={t('reader.nextPara')}
	>
		<span class="relative">
			<Icon name="skip-forward" size={24} />
			<span class="absolute -bottom-1 left-1/2 -translate-x-1/2 text-[10px] font-medium">¶</span>
		</span>
	</button>
</div>
