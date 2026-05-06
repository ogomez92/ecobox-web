<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import type { FileEntry } from '$lib/types';

	interface Props {
		file: FileEntry;
		ondelete: () => void;
		onprotect?: () => void;
		isUnlocked?: boolean;
	}

	let { file, ondelete, onprotect, isUnlocked = false }: Props = $props();

	let isOpen = $state(false);
	let buttonEl: HTMLButtonElement | undefined = $state();
	let menuEl: HTMLDivElement | undefined = $state();

	function handleDownload() {
		const url = file.isDirectory
			? `/api/download/zip?path=${encodeURIComponent(file.path)}`
			: `/api/download?path=${encodeURIComponent(file.path)}`;
		window.location.href = url;
		isOpen = false;
	}

	function handleDelete() {
		ondelete();
		isOpen = false;
	}

	function handleProtect() {
		onprotect?.();
		isOpen = false;
	}

	function handleToggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		isOpen = !isOpen;
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			isOpen = false;
			buttonEl?.focus();
		} else if (e.key === 'ArrowDown' && isOpen && menuEl) {
			e.preventDefault();
			const firstItem = menuEl.querySelector<HTMLButtonElement>('[role="menuitem"]');
			firstItem?.focus();
		} else if (e.key === 'ArrowUp' && isOpen && menuEl) {
			e.preventDefault();
			const items = menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
			items[items.length - 1]?.focus();
		}
	}

	function handleMenuKeydown(e: KeyboardEvent) {
		const items = menuEl?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
		if (!items) return;

		const currentIndex = Array.from(items).indexOf(e.target as HTMLButtonElement);

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			const nextIndex = (currentIndex + 1) % items.length;
			items[nextIndex]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			const prevIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
			items[prevIndex]?.focus();
		} else if (e.key === 'Escape') {
			e.preventDefault();
			isOpen = false;
			buttonEl?.focus();
		} else if (e.key === 'Tab') {
			isOpen = false;
		}
	}

	function handleClickOutside(e: MouseEvent) {
		const target = e.target as Node;
		if (buttonEl && !buttonEl.contains(target) && menuEl && !menuEl.contains(target)) {
			isOpen = false;
		}
	}

	$effect(() => {
		if (isOpen) {
			document.addEventListener('click', handleClickOutside);
			return () => document.removeEventListener('click', handleClickOutside);
		}
	});

	$effect(() => {
		if (isOpen && menuEl) {
			const firstItem = menuEl.querySelector<HTMLButtonElement>('[role="menuitem"]');
			firstItem?.focus();
		}
	});
</script>

<div class="relative">
	<button
		bind:this={buttonEl}
		type="button"
		onclick={handleToggle}
		onkeydown={handleKeydown}
		class="p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-700 rounded-lg transition-colors"
		aria-haspopup="menu"
		aria-expanded={isOpen}
		aria-label={t('actions.forFile', { name: file.name })}
	>
		<Icon name="more-vertical" size={20} />
	</button>

	{#if isOpen}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			bind:this={menuEl}
			role="menu"
			tabindex="-1"
			class="absolute right-0 mt-1 w-40 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20"
			onkeydown={handleMenuKeydown}
		>
			<button
				type="button"
				role="menuitem"
				onclick={handleDownload}
				class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
			>
				<Icon name="download" size={16} />
				{t('actions.download')}
			</button>
			{#if isUnlocked}
				<button
					type="button"
					role="menuitem"
					onclick={handleProtect}
					class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
				>
					<Icon name={file.isProtected ? 'lock-open' : 'lock'} size={16} />
					{file.isProtected ? t('actions.unprotect') : t('actions.protect')}
				</button>
			{/if}
			<button
				type="button"
				role="menuitem"
				onclick={handleDelete}
				class="w-full flex items-center gap-2 px-4 py-2 text-sm text-red-600 dark:text-red-400 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
			>
				<Icon name="trash" size={16} />
				{t('common.delete')}
			</button>
		</div>
	{/if}
</div>
