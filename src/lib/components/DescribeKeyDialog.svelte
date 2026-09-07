<script lang="ts">
	/**
	 * Asks for the Claude API key the video description feature needs, the first
	 * time it is needed (or after the stored one is rejected).
	 *
	 * The key goes straight to the server and is never read back — this dialog only
	 * ever *writes* it — so there is no "current key" to show, and the field always
	 * starts empty. Focus lands in that field on open, since typing the key is the
	 * only reason the dialog exists; the caller restores focus when it closes.
	 */
	import { videoDescribeStore } from '$lib/stores/videoDescribe.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		/** Why we are asking: no key at all, or the stored one was rejected. */
		reason: 'missing' | 'invalid';
		/** Called after the key is stored, so the caller can retry the description. */
		onsaved: () => void;
		onclose: () => void;
	}

	let { reason, onsaved, onclose }: Props = $props();

	let apiKey = $state('');
	let reveal = $state(false);
	let saving = $state(false);
	let errorMessage = $state<string | null>(null);
	let inputElement: HTMLInputElement | null = $state(null);

	// An environment key is already in play; saving here replaces it for good.
	const replacingEnvKey = $derived(videoDescribeStore.keyStatus?.source === 'env');

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (saving) return;

		const value = apiKey.trim();
		if (!value) {
			errorMessage = t('describe.key.errorEmpty');
			inputElement?.focus();
			return;
		}

		saving = true;
		errorMessage = null;
		const result = await videoDescribeStore.saveKey(value);
		saving = false;

		if (!result.ok) {
			errorMessage =
				result.code === 'malformed'
					? t('describe.key.errorMalformed')
					: result.code === 'empty'
						? t('describe.key.errorEmpty')
						: t('describe.key.errorSaveFailed');
			inputElement?.focus();
			return;
		}

		// Never leave the key sitting in a component field once it is stored.
		apiKey = '';
		onsaved();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		}
	}

	$effect(() => {
		// The field is the whole point of the dialog — start in it.
		inputElement?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="describe-key-title"
	aria-describedby="describe-key-intro"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
		<h2 id="describe-key-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
			{t('describe.key.title')}
		</h2>

		<p id="describe-key-intro" class="text-sm text-gray-600 dark:text-gray-400 mb-4">
			{reason === 'invalid' ? t('describe.key.reasonInvalid') : t('describe.key.reasonMissing')}
			{' '}{t('describe.key.intro')}
		</p>

		<form onsubmit={handleSubmit}>
			<div class="mb-4">
				<label for="describe-key-input" class="block text-sm text-gray-600 dark:text-gray-400 mb-2">
					{t('describe.key.label')}
				</label>
				<input
					bind:this={inputElement}
					bind:value={apiKey}
					id="describe-key-input"
					type={reveal ? 'text' : 'password'}
					class="input w-full font-mono"
					placeholder={t('describe.key.placeholder')}
					autocomplete="off"
					autocapitalize="off"
					autocorrect="off"
					spellcheck="false"
					aria-describedby="describe-key-help"
					aria-invalid={errorMessage ? 'true' : undefined}
				/>
				{#if errorMessage}
					<p class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{errorMessage}</p>
				{/if}

				<label class="mt-3 flex items-center gap-2 text-sm text-gray-600 dark:text-gray-400">
					<input type="checkbox" bind:checked={reveal} class="rounded" />
					{t('describe.key.show')}
				</label>

				<p id="describe-key-help" class="mt-3 text-sm text-gray-500 dark:text-gray-400">
					{t('describe.key.help')}
					{#if replacingEnvKey}
						{' '}{t('describe.key.envNote')}
					{/if}
				</p>
			</div>

			<div class="flex gap-3">
				<button type="button" onclick={onclose} class="btn-secondary flex-1" disabled={saving}>
					{t('common.cancel')}
				</button>
				<button type="submit" class="btn-primary flex-1" disabled={saving}>
					{saving ? t('describe.key.saving') : t('describe.key.save')}
				</button>
			</div>
		</form>
	</div>
</div>
