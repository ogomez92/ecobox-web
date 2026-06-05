<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { isIOS } from '$lib/utils/platform';
	import { roomCaster, parseCastInput } from '$lib/services/roomCaster.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';

	interface Props {
		/** Title of the currently-playing item, shown to listeners in the call. */
		currentTitle: string;
		onclose: () => void;
	}

	let { currentTitle, onclose }: Props = $props();

	const STORAGE_KEY = 'ecobox-cast-target';

	let inputValue = $state('');
	let inputElement: HTMLInputElement | null = $state(null);
	let localError = $state<string | null>(null);

	// Reflect the shared caster state reactively.
	const status = $derived(roomCaster.status);
	const isCasting = $derived(roomCaster.isCasting);
	const isConnecting = $derived(status === 'connecting');
	const error = $derived(localError ?? roomCaster.error);

	$effect(() => {
		// Prefill the last-used target, or the configured SonicRoom URL from Settings.
		try {
			inputValue = localStorage.getItem(STORAGE_KEY) ?? settingsStore.sonicroomUrl;
		} catch {
			inputValue = settingsStore.sonicroomUrl;
		}
		inputElement?.focus();
	});

	function sanitizeName(name: string): string {
		return name.replace(/[<>"'&]/g, '').trim().slice(0, 30);
	}

	async function handleStart(e: Event) {
		e.preventDefault();
		localError = null;
		const target = parseCastInput(inputValue);
		if (!target) {
			localError = t('cast.invalidTarget');
			return;
		}
		try {
			localStorage.setItem(STORAGE_KEY, inputValue.trim());
		} catch {
			// ignore storage errors
		}
		const displayName = `🎵 ${sanitizeName(currentTitle) || 'Ecobox'}`;
		try {
			await roomCaster.start(target, displayName);
			// Streaming runs in the standalone roomCaster singleton, so close the
			// dialog (it otherwise swallows the player's seek/arrow keys). The
			// footer button switches to "Stop casting" to end it later.
			onclose();
		} catch {
			// roomCaster.error is already set and surfaced via {error}
		}
	}

	function handleStop() {
		roomCaster.stop();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') onclose();
	}
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="cast-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6">
		<h2
			id="cast-title"
			class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4 flex items-center gap-2"
		>
			<Icon name="broadcast" size={20} class="text-primary-500" />
			{t('cast.title')}
		</h2>

		{#if isCasting}
			<p class="mb-4 text-sm text-gray-700 dark:text-gray-300" role="status" aria-live="polite">
				{t('cast.casting', { room: roomCaster.roomName ?? '' })}
			</p>
			<button type="button" onclick={handleStop} class="btn-primary w-full">
				<Icon name="x" size={18} class="mr-2" />
				{t('cast.stop')}
			</button>
		{:else}
			<form onsubmit={handleStart}>
				<div class="mb-3">
					<label for="cast-input" class="block text-sm text-gray-600 dark:text-gray-400 mb-2">
						{t('cast.label')}
					</label>
					<input
						bind:this={inputElement}
						id="cast-input"
						type="text"
						bind:value={inputValue}
						placeholder={t('cast.placeholder')}
						class="input w-full"
						autocomplete="off"
						disabled={isConnecting}
					/>
					{#if error}
						<p class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">
							{t('cast.failed', { error })}
						</p>
					{/if}
				</div>

				<p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
					{t('cast.help')}
				</p>

				{#if isIOS()}
					<p class="text-xs text-amber-600 dark:text-amber-400 mb-4">
						{t('cast.iosWarning')}
					</p>
				{/if}

				<div class="flex gap-3">
					<button type="button" onclick={onclose} class="btn-secondary flex-1">
						{t('common.cancel')}
					</button>
					<button type="submit" class="btn-primary flex-1" disabled={isConnecting}>
						{isConnecting ? t('cast.connecting') : t('cast.start')}
					</button>
				</div>
			</form>
		{/if}
	</div>
</div>
