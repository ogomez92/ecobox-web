<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		isOpen?: boolean;
		onuploadfiles: () => void;
		onuploadfolder: () => void;
		onaddradio?: () => void;
	}

	let {
		isOpen = $bindable(false),
		onuploadfiles,
		onuploadfolder,
		onaddradio
	}: Props = $props();

	let buttonEl: HTMLButtonElement | undefined = $state();
	let menuEl: HTMLDivElement | undefined = $state();

	function handleToggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		isOpen = !isOpen;
	}

	function close() {
		isOpen = false;
	}

	function selectUploadFiles() {
		close();
		onuploadfiles();
	}

	function selectUploadFolder() {
		close();
		onuploadfolder();
	}

	function selectAddRadio() {
		close();
		onaddradio?.();
	}

	function handleButtonKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			isOpen = false;
		} else if ((e.key === 'ArrowDown' || e.key === 'Enter' || e.key === ' ') && !isOpen) {
			e.preventDefault();
			isOpen = true;
		} else if (e.key === 'ArrowDown' && isOpen && menuEl) {
			e.preventDefault();
			menuEl.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		} else if (e.key === 'ArrowUp' && isOpen && menuEl) {
			e.preventDefault();
			const items = menuEl.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
			items[items.length - 1]?.focus();
		}
	}

	function handleMenuKeydown(e: KeyboardEvent) {
		const items = menuEl?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]');
		if (!items || items.length === 0) return;

		const currentIndex = Array.from(items).indexOf(e.target as HTMLButtonElement);

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			const nextIndex = (currentIndex + 1) % items.length;
			items[nextIndex]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			const prevIndex = currentIndex <= 0 ? items.length - 1 : currentIndex - 1;
			items[prevIndex]?.focus();
		} else if (e.key === 'Home') {
			e.preventDefault();
			items[0]?.focus();
		} else if (e.key === 'End') {
			e.preventDefault();
			items[items.length - 1]?.focus();
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
			menuEl.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
		}
	});
</script>

<div class="relative">
	<button
		bind:this={buttonEl}
		type="button"
		onclick={handleToggle}
		onkeydown={handleButtonKeydown}
		class="btn-primary"
		aria-haspopup="menu"
		aria-expanded={isOpen}
		aria-label={t('actions.menuAria')}
	>
		<Icon name="upload" size={20} />
		<span class="ml-2 hidden sm:inline">{t('actions.label')}</span>
		<Icon name="chevron-down" size={16} class="ml-1" />
	</button>

	{#if isOpen}
		<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
		<div
			bind:this={menuEl}
			role="menu"
			tabindex="-1"
			aria-label={t('actions.label')}
			class="absolute right-0 mt-1 w-56 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-30"
			onkeydown={handleMenuKeydown}
		>
			<button
				type="button"
				role="menuitem"
				onclick={selectUploadFiles}
				class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none transition-colors"
			>
				<Icon name="file" size={16} />
				{t('actions.uploadFiles')}
			</button>
			<button
				type="button"
				role="menuitem"
				onclick={selectUploadFolder}
				class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none transition-colors"
			>
				<Icon name="folder" size={16} />
				{t('actions.uploadFolder')}
			</button>
			{#if onaddradio}
				<button
					type="button"
					role="menuitem"
					onclick={selectAddRadio}
					class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 focus:bg-gray-100 dark:focus:bg-gray-700 focus:outline-none transition-colors"
				>
					<Icon name="radio" size={16} />
					{t('actions.addRadio')}
				</button>
			{/if}
		</div>
	{/if}
</div>
