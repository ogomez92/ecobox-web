<script lang="ts">
	import Icon from './Icon.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import type { FileEntry } from '$lib/types';

	interface Props {
		file: FileEntry;
		ondelete: () => void;
		onprotect?: () => void;
		onconvert?: () => void;
		/** Book folders only: read the book into an MP3 next to it. */
		onaudiobook?: () => void;
		isUnlocked?: boolean;
	}

	let { file, ondelete, onprotect, onconvert, onaudiobook, isUnlocked = false }: Props = $props();

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

	function handleConvert() {
		onconvert?.();
		isOpen = false;
	}

	function handleAudiobook() {
		isOpen = false;
		onaudiobook?.();
	}

	function handleToggle(e: MouseEvent) {
		e.preventDefault();
		e.stopPropagation();
		isOpen = !isOpen;
	}

	// The menu lives inside a file-table row, and the table has its own key
	// handler (arrows, Home/End, type-ahead, Delete, Backspace). Every key this
	// menu handles must stop propagating, or the table moves focus to the next
	// row the moment the user arrows inside the menu.
	let pendingFocus: 'first' | 'last' = 'first';

	function menuItems(): HTMLButtonElement[] {
		return Array.from(menuEl?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? []);
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && isOpen) {
			e.preventDefault();
			e.stopPropagation();
			isOpen = false;
			buttonEl?.focus();
		} else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
			// Menu-button pattern: arrows open the menu on the first/last item.
			e.preventDefault();
			e.stopPropagation();
			const which = e.key === 'ArrowDown' ? 'first' : 'last';
			if (isOpen) {
				const items = menuItems();
				(which === 'first' ? items[0] : items[items.length - 1])?.focus();
			} else {
				pendingFocus = which;
				isOpen = true;
			}
		}
	}

	function handleMenuKeydown(e: KeyboardEvent) {
		// Nothing typed inside the open menu belongs to the table behind it.
		e.stopPropagation();
		const items = menuItems();
		if (items.length === 0) return;

		const currentIndex = items.indexOf(e.target as HTMLButtonElement);

		if (e.key === 'ArrowDown') {
			e.preventDefault();
			items[(currentIndex + 1) % items.length]?.focus();
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			items[currentIndex <= 0 ? items.length - 1 : currentIndex - 1]?.focus();
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
		} else if (e.key.length === 1 && /^[\p{L}\p{N}]$/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
			// Type-ahead: jump to the next item whose label starts with the letter.
			const ch = e.key.toLocaleLowerCase();
			for (let i = 1; i <= items.length; i++) {
				const item = items[(currentIndex + i) % items.length];
				if (item.textContent?.trim().toLocaleLowerCase().startsWith(ch)) {
					item.focus();
					break;
				}
			}
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
			const items = menuItems();
			(pendingFocus === 'last' ? items[items.length - 1] : items[0])?.focus();
			pendingFocus = 'first';
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
			class="absolute right-0 mt-1 w-48 bg-white dark:bg-gray-800 rounded-lg shadow-lg border border-gray-200 dark:border-gray-700 py-1 z-20"
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
			{#if file.isRawBook || file.isVideoFile}
				<!-- Same callback for both: the parent knows which pipeline the file
				     belongs to (book conversion vs. audio extraction). -->
				<button
					type="button"
					role="menuitem"
					onclick={handleConvert}
					class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
				>
					<Icon name={file.isVideoFile ? 'audio' : 'book'} size={16} />
					{file.isVideoFile ? t('actions.extractAudio') : t('actions.convert')}
				</button>
			{/if}
			{#if file.isBookFolder && onaudiobook}
				<button
					type="button"
					role="menuitem"
					onclick={handleAudiobook}
					class="w-full flex items-center gap-2 px-4 py-2 text-sm text-gray-700 dark:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 transition-colors"
				>
					<Icon name="audio" size={16} />
					{t('actions.convertToAudio')}
				</button>
			{/if}
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
