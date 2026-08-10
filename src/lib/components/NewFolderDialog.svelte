<script lang="ts">
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		/** Parent directory the folder is created in ('' = media root). */
		currentPath: string;
		/** Called with the created folder's name once the server has made it. */
		oncreated: (name: string) => void;
		onclose: () => void;
	}

	let { currentPath, oncreated, onclose }: Props = $props();

	let name = $state('');
	let error = $state<string | null>(null);
	let isCreating = $state(false);
	let inputElement: HTMLInputElement | undefined = $state();
	let panelElement: HTMLDivElement | undefined = $state();

	const location = $derived(currentPath || t('breadcrumbs.home'));

	/** Map the server's refusal codes onto the localized explanations. */
	function messageFor(code: string, folderName: string): string {
		switch (code) {
			case 'empty':
				return t('newFolder.errorEmpty');
			case 'invalidChars':
				return t('newFolder.errorInvalidChars');
			case 'reserved':
				return t('newFolder.errorReserved');
			case 'tooLong':
				return t('newFolder.errorTooLong');
			case 'exists':
				return t('newFolder.errorExists', { name: folderName });
			default:
				return t('newFolder.errorFailed');
		}
	}

	async function handleSubmit(e: Event) {
		e.preventDefault();
		if (isCreating) return;

		const trimmed = name.trim();
		// Cheap client-side check for the one case worth catching before a round
		// trip; every other rule is enforced (and reported) by the server.
		if (!trimmed) {
			error = t('newFolder.errorEmpty');
			inputElement?.focus();
			return;
		}

		isCreating = true;
		error = null;
		try {
			const res = await fetch('/api/files', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: currentPath, name: trimmed })
			});
			const data = await res.json().catch(() => ({}));
			if (!res.ok) {
				error = messageFor(data.error ?? '', trimmed);
				inputElement?.focus();
				return;
			}
			oncreated(data.name ?? trimmed);
		} catch {
			error = t('newFolder.errorFailed');
			inputElement?.focus();
		} finally {
			isCreating = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			onclose();
			return;
		}
		// Keep Tab inside the dialog — the backdrop sits behind it in the tab order
		// and the page underneath must stay unreachable while it's modal.
		if (e.key !== 'Tab' || !panelElement) return;
		const focusable = panelElement.querySelectorAll<HTMLElement>(
			'input:not([disabled]), button:not([disabled])'
		);
		if (focusable.length === 0) return;
		const first = focusable[0];
		const last = focusable[focusable.length - 1];
		const active = document.activeElement;
		if (e.shiftKey && (active === first || !panelElement.contains(active))) {
			e.preventDefault();
			last.focus();
		} else if (!e.shiftKey && active === last) {
			e.preventDefault();
			first.focus();
		}
	}

	$effect(() => {
		inputElement?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="new-folder-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div
		bind:this={panelElement}
		class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6"
	>
		<h2 id="new-folder-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
			{t('newFolder.title')}
		</h2>
		<p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
			{t('newFolder.location', { path: location })}
		</p>

		<form onsubmit={handleSubmit}>
			<div class="mb-4">
				<label
					for="new-folder-name"
					class="block text-sm text-gray-600 dark:text-gray-400 mb-2"
				>
					{t('newFolder.label')}
				</label>
				<input
					bind:this={inputElement}
					bind:value={name}
					id="new-folder-name"
					type="text"
					class="input w-full"
					autocomplete="off"
					spellcheck="false"
					aria-describedby={error ? 'new-folder-error' : undefined}
					aria-invalid={error ? 'true' : undefined}
					disabled={isCreating}
				/>
				{#if error}
					<p
						id="new-folder-error"
						class="mt-2 text-sm text-red-600 dark:text-red-400"
						role="alert"
					>
						{error}
					</p>
				{/if}
			</div>

			<div class="flex gap-3">
				<button type="button" onclick={onclose} class="btn-secondary flex-1" disabled={isCreating}>
					{t('common.cancel')}
				</button>
				<button type="submit" class="btn-primary flex-1" disabled={isCreating}>
					{t('newFolder.create')}
				</button>
			</div>
		</form>
	</div>
</div>
