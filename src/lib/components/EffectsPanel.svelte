<script lang="ts">
	import { onMount } from 'svelte';
	import { browser } from '$app/environment';
	import Icon from './Icon.svelte';
	import { audioEffects } from '$lib/services/audioEffects';
	import { DEFAULT_AUDIO_EFFECTS, type EffectPreset } from '$lib/types';

	interface Props {
		onclose: () => void;
	}

	let { onclose }: Props = $props();

	// Initialize with defaults during SSR, update on mount
	let isEnabled = $state(false);
	let effects = $state(DEFAULT_AUDIO_EFFECTS);
	let activeTab = $state<'boost' | 'eq' | 'compressor' | 'reverb'>('boost');
	let dialogElement: HTMLDivElement | null = $state(null);
	let allEffectsToggleRef: HTMLButtonElement | null = $state(null);

	const presets: { value: EffectPreset; label: string }[] = [
		{ value: 'flat', label: 'Flat' },
		{ value: 'dialog', label: 'Dialog' },
		{ value: 'bass', label: 'Bass' },
		{ value: 'treble', label: 'Treble' }
	];

	const eqLabels = ['60Hz', '230Hz', '910Hz', '3.6kHz', '8kHz', '14kHz'];

	onMount(() => {
		// Load current effects state on mount (client-side only)
		isEnabled = audioEffects.isEnabled();
		effects = audioEffects.getEffects();

		// Focus the All Effects toggle when dialog opens
		requestAnimationFrame(() => {
			allEffectsToggleRef?.focus();
		});
	});

	function toggleEffects() {
		audioEffects.toggle();
		isEnabled = audioEffects.isEnabled();
	}

	function setPreset(preset: EffectPreset) {
		audioEffects.setEQPreset(preset);
		effects = audioEffects.getEffects();
	}

	function setEQBand(index: number, value: number) {
		audioEffects.setEQBand(index, value);
		effects = audioEffects.getEffects();
	}

	function setCompressorThreshold(value: number) {
		audioEffects.setCompressorThreshold(value);
		effects = audioEffects.getEffects();
	}

	function setCompressorRatio(value: number) {
		audioEffects.setCompressorRatio(value);
		effects = audioEffects.getEffects();
	}

	function toggleReverb() {
		audioEffects.setReverbEnabled(!effects.reverb.enabled);
		effects = audioEffects.getEffects();
	}

	function setReverbWetDry(value: number) {
		audioEffects.setReverbWetDry(value);
		effects = audioEffects.getEffects();
	}

	function toggleHighPass() {
		audioEffects.setHighPassEnabled(!effects.highPass.enabled);
		effects = audioEffects.getEffects();
	}

	function setHighPassFrequency(value: number) {
		audioEffects.setHighPassFrequency(value);
		effects = audioEffects.getEffects();
	}

	function toggleVolumeBoost() {
		audioEffects.setVolumeBoostEnabled(!effects.volumeBoost.enabled);
		effects = audioEffects.getEffects();
	}

	function setVolumeBoostGain(value: number) {
		audioEffects.setVolumeBoostGain(value);
		effects = audioEffects.getEffects();
	}

	const tabs = ['boost', 'eq', 'compressor', 'reverb'] as const;
	let tabRefs: Record<string, HTMLButtonElement | null> = $state({
		boost: null,
		eq: null,
		compressor: null,
		reverb: null
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
		}
	}

	function handleTabKeydown(e: KeyboardEvent) {
		const currentIndex = tabs.indexOf(activeTab);
		let newIndex = currentIndex;

		if (e.key === 'ArrowRight') {
			e.preventDefault();
			newIndex = currentIndex < tabs.length - 1 ? currentIndex + 1 : 0;
		} else if (e.key === 'ArrowLeft') {
			e.preventDefault();
			newIndex = currentIndex > 0 ? currentIndex - 1 : tabs.length - 1;
		} else if (e.key === 'Home') {
			e.preventDefault();
			newIndex = 0;
		} else if (e.key === 'End') {
			e.preventDefault();
			newIndex = tabs.length - 1;
		}

		if (newIndex !== currentIndex) {
			activeTab = tabs[newIndex];
			tabRefs[tabs[newIndex]]?.focus();
		}
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={dialogElement}
	class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
	role="dialog"
	aria-modal="true"
	aria-labelledby="effects-panel-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label="Close effects panel"
	></button>

	<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:rounded-xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col">
		<header class="flex items-center justify-between px-4 py-3 border-b border-gray-200 dark:border-gray-700">
			<h2 id="effects-panel-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
				Audio Effects
			</h2>
			<div class="flex items-center gap-2">
				<button
					type="button"
					onclick={onclose}
					class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
					aria-label="Close"
				>
					<Icon name="x" size={24} />
				</button>
				<button
					bind:this={allEffectsToggleRef}
					type="button"
					onclick={toggleEffects}
					class="px-3 py-1.5 text-sm rounded-full transition-colors"
					class:bg-primary-500={isEnabled}
					class:text-white={isEnabled}
					class:bg-gray-200={!isEnabled}
					class:dark:bg-gray-700={!isEnabled}
					class:text-gray-700={!isEnabled}
					class:dark:text-gray-300={!isEnabled}
					aria-pressed={isEnabled}
				>
					All Effects
				</button>
			</div>
		</header>

		<!-- Tabs -->
		<div class="flex border-b border-gray-200 dark:border-gray-700" role="tablist" aria-label="Audio effect categories">
			<button
				bind:this={tabRefs.boost}
				type="button"
				role="tab"
				id="tab-boost"
				aria-selected={activeTab === 'boost'}
				aria-controls="tabpanel-boost"
				tabindex={activeTab === 'boost' ? 0 : -1}
				class="flex-1 py-3 text-sm font-medium transition-colors"
				class:text-primary-600={activeTab === 'boost'}
				class:border-b-2={activeTab === 'boost'}
				class:border-primary-600={activeTab === 'boost'}
				class:text-gray-500={activeTab !== 'boost'}
				onclick={() => activeTab = 'boost'}
				onkeydown={handleTabKeydown}
			>
				Boost
			</button>
			<button
				bind:this={tabRefs.eq}
				type="button"
				role="tab"
				id="tab-eq"
				aria-selected={activeTab === 'eq'}
				aria-controls="tabpanel-eq"
				tabindex={activeTab === 'eq' ? 0 : -1}
				class="flex-1 py-3 text-sm font-medium transition-colors"
				class:text-primary-600={activeTab === 'eq'}
				class:border-b-2={activeTab === 'eq'}
				class:border-primary-600={activeTab === 'eq'}
				class:text-gray-500={activeTab !== 'eq'}
				onclick={() => activeTab = 'eq'}
				onkeydown={handleTabKeydown}
			>
				Equalizer
			</button>
			<button
				bind:this={tabRefs.compressor}
				type="button"
				role="tab"
				id="tab-compressor"
				aria-selected={activeTab === 'compressor'}
				aria-controls="tabpanel-compressor"
				tabindex={activeTab === 'compressor' ? 0 : -1}
				class="flex-1 py-3 text-sm font-medium transition-colors"
				class:text-primary-600={activeTab === 'compressor'}
				class:border-b-2={activeTab === 'compressor'}
				class:border-primary-600={activeTab === 'compressor'}
				class:text-gray-500={activeTab !== 'compressor'}
				onclick={() => activeTab = 'compressor'}
				onkeydown={handleTabKeydown}
			>
				Compressor
			</button>
			<button
				bind:this={tabRefs.reverb}
				type="button"
				role="tab"
				id="tab-reverb"
				aria-selected={activeTab === 'reverb'}
				aria-controls="tabpanel-reverb"
				tabindex={activeTab === 'reverb' ? 0 : -1}
				class="flex-1 py-3 text-sm font-medium transition-colors"
				class:text-primary-600={activeTab === 'reverb'}
				class:border-b-2={activeTab === 'reverb'}
				class:border-primary-600={activeTab === 'reverb'}
				class:text-gray-500={activeTab !== 'reverb'}
				onclick={() => activeTab = 'reverb'}
				onkeydown={handleTabKeydown}
			>
				Reverb
			</button>
		</div>

		<div class="flex-1 overflow-y-auto p-4">
			{#if activeTab === 'boost'}
				<div id="tabpanel-boost" role="tabpanel" aria-labelledby="tab-boost" class="space-y-6">
					<div>
						<label class="flex items-center justify-between mb-4">
							<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Enable Volume Boost</span>
							<button
								type="button"
								onclick={toggleVolumeBoost}
								class="relative w-12 h-6 rounded-full transition-colors"
								class:bg-primary-500={effects.volumeBoost.enabled}
								class:bg-gray-300={!effects.volumeBoost.enabled}
								class:dark:bg-gray-600={!effects.volumeBoost.enabled}
								role="switch"
								aria-checked={effects.volumeBoost.enabled}
								aria-label="Toggle volume boost"
							>
								<span
									class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
									class:translate-x-0.5={!effects.volumeBoost.enabled}
									class:translate-x-6={effects.volumeBoost.enabled}
								></span>
							</button>
						</label>

						<div class="flex justify-between mb-2">
							<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Boost Amount</span>
							<span class="text-sm text-gray-500">+{effects.volumeBoost.gain.toFixed(0)} dB</span>
						</div>
						<input
							type="range"
							min="0"
							max="12"
							step="1"
							value={effects.volumeBoost.gain}
							oninput={(e) => setVolumeBoostGain(parseFloat((e.target as HTMLInputElement).value))}
							class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer"
							aria-label="Volume boost amount in decibels"
							aria-valuemin={0}
							aria-valuemax={12}
							aria-valuenow={effects.volumeBoost.gain}
						/>
						<div class="flex justify-between text-xs text-gray-400 mt-1">
							<span>0 dB</span>
							<span>+6 dB</span>
							<span>+12 dB</span>
						</div>
					</div>

					<div class="p-3 bg-amber-50 dark:bg-amber-900/30 border border-amber-200 dark:border-amber-700 rounded-lg">
						<p class="text-sm text-amber-800 dark:text-amber-200">
							Volume boost amplifies the audio signal beyond normal levels. Use with caution to avoid distortion or hearing damage at high volumes.
						</p>
					</div>

					<div class="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
						<p class="text-sm text-gray-600 dark:text-gray-400">
							Useful for quiet recordings or when you need extra loudness. Enable effects (On button above) for boost to take effect.
						</p>
					</div>
				</div>
			{:else if activeTab === 'eq'}
				<div id="tabpanel-eq" role="tabpanel" aria-labelledby="tab-eq">
					<!-- Presets -->
					<div class="mb-6">
						<p class="text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">Presets</p>
						<div class="flex gap-2" role="group" aria-label="EQ presets">
							{#each presets as preset}
								<button
									type="button"
									onclick={() => setPreset(preset.value)}
									class="flex-1 py-2 text-sm rounded-lg transition-colors min-h-[44px]"
									class:bg-primary-100={effects.preset === preset.value}
									class:dark:bg-primary-900={effects.preset === preset.value}
									class:text-primary-700={effects.preset === preset.value}
									class:dark:text-primary-300={effects.preset === preset.value}
									class:bg-gray-100={effects.preset !== preset.value}
									class:dark:bg-gray-700={effects.preset !== preset.value}
									class:text-gray-700={effects.preset !== preset.value}
									class:dark:text-gray-300={effects.preset !== preset.value}
									aria-pressed={effects.preset === preset.value}
								>
									{preset.label}
								</button>
							{/each}
						</div>
					</div>

					<!-- EQ Bands -->
					<div class="space-y-4">
						<p class="text-sm font-medium text-gray-700 dark:text-gray-300">Bands</p>
						<div class="grid grid-cols-6 gap-2">
							{#each effects.eq.bands as band, index}
								<div class="flex flex-col items-center gap-2">
									<input
										type="range"
										min="-12"
										max="12"
										step="0.5"
										value={band.gain}
										oninput={(e) => setEQBand(index, parseFloat((e.target as HTMLInputElement).value))}
										class="h-24 appearance-none bg-gray-200 dark:bg-gray-700 rounded-full"
										style="writing-mode: vertical-lr; direction: rtl;"
										aria-label="{eqLabels[index]} gain"
									/>
									<span class="text-xs text-gray-500 dark:text-gray-400">
										{band.gain > 0 ? '+' : ''}{band.gain.toFixed(0)}
									</span>
									<span class="text-xs text-gray-600 dark:text-gray-400">{eqLabels[index]}</span>
								</div>
							{/each}
						</div>
					</div>
				</div>
			{:else if activeTab === 'compressor'}
				<div id="tabpanel-compressor" role="tabpanel" aria-labelledby="tab-compressor" class="space-y-6">
					<div>
						<div class="flex justify-between mb-2">
							<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Threshold</span>
							<span class="text-sm text-gray-500">{effects.compressor.threshold} dB</span>
						</div>
						<input
							type="range"
							min="-60"
							max="0"
							step="1"
							value={effects.compressor.threshold}
							oninput={(e) => setCompressorThreshold(parseFloat((e.target as HTMLInputElement).value))}
							class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer"
							aria-label="Compressor threshold"
						/>
					</div>

					<div>
						<div class="flex justify-between mb-2">
							<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Ratio</span>
							<span class="text-sm text-gray-500">{effects.compressor.ratio}:1</span>
						</div>
						<input
							type="range"
							min="1"
							max="20"
							step="0.5"
							value={effects.compressor.ratio}
							oninput={(e) => setCompressorRatio(parseFloat((e.target as HTMLInputElement).value))}
							class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer"
							aria-label="Compressor ratio"
						/>
					</div>

					<div class="p-3 bg-gray-50 dark:bg-gray-700 rounded-lg">
						<p class="text-sm text-gray-600 dark:text-gray-400">
							The compressor reduces dynamic range, making quiet parts louder and loud parts quieter.
							Useful for spoken word content.
						</p>
					</div>
				</div>
			{:else if activeTab === 'reverb'}
				<div id="tabpanel-reverb" role="tabpanel" aria-labelledby="tab-reverb" class="space-y-6">
					<label class="flex items-center justify-between">
						<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Enable Reverb</span>
						<button
							type="button"
							onclick={toggleReverb}
							class="relative w-12 h-6 rounded-full transition-colors"
							class:bg-primary-500={effects.reverb.enabled}
							class:bg-gray-300={!effects.reverb.enabled}
							class:dark:bg-gray-600={!effects.reverb.enabled}
							role="switch"
							aria-checked={effects.reverb.enabled}
							aria-label="Toggle reverb"
						>
							<span
								class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
								class:translate-x-0.5={!effects.reverb.enabled}
								class:translate-x-6={effects.reverb.enabled}
							></span>
						</button>
					</label>

					{#if effects.reverb.enabled}
						<div>
							<div class="flex justify-between mb-2">
								<span class="text-sm font-medium text-gray-700 dark:text-gray-300">Wet/Dry Mix</span>
								<span class="text-sm text-gray-500">{Math.round(effects.reverb.wetDry * 100)}%</span>
							</div>
							<input
								type="range"
								min="0"
								max="1"
								step="0.05"
								value={effects.reverb.wetDry}
								oninput={(e) => setReverbWetDry(parseFloat((e.target as HTMLInputElement).value))}
								class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer"
								aria-label="Reverb wet/dry mix"
							/>
						</div>
					{/if}

					<div class="border-t border-gray-200 dark:border-gray-700 pt-6">
						<label class="flex items-center justify-between">
							<span class="text-sm font-medium text-gray-700 dark:text-gray-300">High-Pass Filter</span>
							<button
								type="button"
								onclick={toggleHighPass}
								class="relative w-12 h-6 rounded-full transition-colors"
								class:bg-primary-500={effects.highPass.enabled}
								class:bg-gray-300={!effects.highPass.enabled}
								class:dark:bg-gray-600={!effects.highPass.enabled}
								role="switch"
								aria-checked={effects.highPass.enabled}
								aria-label="Toggle high-pass filter"
							>
								<span
									class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
									class:translate-x-0.5={!effects.highPass.enabled}
									class:translate-x-6={effects.highPass.enabled}
								></span>
							</button>
						</label>

						{#if effects.highPass.enabled}
							<div class="mt-4">
								<div class="flex justify-between mb-2">
									<span class="text-sm text-gray-600 dark:text-gray-400">Cutoff Frequency</span>
									<span class="text-sm text-gray-500">{effects.highPass.frequency} Hz</span>
								</div>
								<input
									type="range"
									min="20"
									max="500"
									step="10"
									value={effects.highPass.frequency}
									oninput={(e) => setHighPassFrequency(parseFloat((e.target as HTMLInputElement).value))}
									class="w-full h-2 bg-gray-200 dark:bg-gray-700 rounded-full appearance-none cursor-pointer"
									aria-label="High-pass filter frequency"
								/>
							</div>
						{/if}

						<p class="mt-3 text-sm text-gray-600 dark:text-gray-400">
							Removes low-frequency rumble and noise below the cutoff frequency.
						</p>
					</div>
				</div>
			{/if}
		</div>
	</div>
</div>
