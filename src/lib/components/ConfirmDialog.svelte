<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		isOpen: boolean;
		title: string;
		message: string;
		confirmText?: string;
		cancelText?: string;
		destructive?: boolean;
		onconfirm: () => void;
		oncancel: () => void;
	}

	let {
		isOpen,
		title,
		message,
		confirmText = 'Confirm',
		cancelText = 'Cancel',
		destructive = false,
		onconfirm,
		oncancel
	}: Props = $props();

	let confirmButton: HTMLButtonElement | undefined = $state();

	$effect(() => {
		if (isOpen && confirmButton) {
			confirmButton.focus();
		}
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			oncancel();
		}
	}
</script>

{#if isOpen}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="fixed inset-0 z-50 flex items-center justify-center p-4"
		role="alertdialog"
		aria-modal="true"
		aria-labelledby="confirm-dialog-title"
		aria-describedby="confirm-dialog-description"
		onkeydown={handleKeydown}
		tabindex="-1"
	>
		<button
			type="button"
			class="absolute inset-0 bg-black/50"
			onclick={oncancel}
			aria-label="Close dialog"
		></button>

		<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6">
			<h2
				id="confirm-dialog-title"
				class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2"
			>
				{title}
			</h2>
			<p
				id="confirm-dialog-description"
				class="text-gray-600 dark:text-gray-400 mb-6"
			>
				{message}
			</p>

			<div class="flex gap-3">
				<button
					type="button"
					onclick={oncancel}
					class="btn-secondary flex-1"
				>
					{cancelText}
				</button>
				<button
					bind:this={confirmButton}
					type="button"
					onclick={onconfirm}
					class="btn flex-1"
					class:bg-red-600={destructive}
					class:hover:bg-red-700={destructive}
					class:text-white={destructive}
					class:btn-primary={!destructive}
				>
					{confirmText}
				</button>
			</div>
		</div>
	</div>
{/if}
