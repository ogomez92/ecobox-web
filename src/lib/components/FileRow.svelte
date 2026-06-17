<script lang="ts">
	import Icon from './Icon.svelte';
	import ActionsDropdown from './ActionsDropdown.svelte';
	import { formatBytes, formatDate, formatDateAccessible } from '$lib/utils/format';
	import { t } from '$lib/i18n/index.svelte';
	import type { FileEntry } from '$lib/types';

	interface Props {
		file: FileEntry;
		focused?: boolean;
		ondelete: () => void;
		onprotect?: () => void;
		onconvert?: () => void;
		isUnlocked?: boolean;
	}

	let { file, focused = false, ondelete, onprotect, onconvert, isUnlocked = false }: Props = $props();

	let rowEl: HTMLTableRowElement | undefined = $state();

	function getIcon() {
		if (file.isDirectory) {
			if (file.isBookFolder) return 'book';
			if (file.isDaisyBook) return 'book';
			return 'folder';
		}
		if (file.isRawBook) return 'book';
		if (file.isRadioFile) return 'radio';
		return 'audio';
	}

	function getHref(): string {
		if (file.isDirectory) {
			// Book folders go to the reader; DAISY/chaptered folders go to the player.
			if (file.isBookFolder) return `/read/${file.path}`;
			if (file.isDaisyBook || file.isChapteredFolder) {
				return `/play/${file.path}`;
			}
			return `/browse/${file.path}`;
		}
		// A raw book file isn't playable until converted — the click triggers convert.
		if (file.isRawBook) return '#';
		return `/play/${file.path}`;
	}

	function handlePrimaryClick(e: MouseEvent) {
		if (file.isRawBook) {
			e.preventDefault();
			onconvert?.();
		}
	}

	function getFileExtension(): string {
		const parts = file.name.split('.');
		if (parts.length > 1) {
			return parts[parts.length - 1].toUpperCase();
		}
		return 'Audio';
	}

	function getAriaLabel(): string {
		const parts: string[] = [file.name];

		if (file.isDirectory) {
			if (file.isBookFolder) {
				parts.push(t('fileTypes.book'));
			} else if (file.isDaisyBook) {
				parts.push(t('fileTypes.daisyBook'));
			} else if (file.isChapteredFolder) {
				parts.push(t('fileTypes.chapteredFolder'));
			} else {
				parts.push(t('fileTypes.folder'));
			}
		} else if (file.isRawBook) {
			parts.push(t('fileTypes.rawBook'));
		} else if (file.isRadioFile) {
			parts.push(t('radio.label'));
		} else {
			parts.push(t('fileTypes.fileExt', { ext: getFileExtension() }));
		}

		parts.push(formatBytes(file.size));
		parts.push(formatDateAccessible(file.modifiedAt));

		return parts.join(', ');
	}

	$effect(() => {
		if (focused && rowEl) {
			const link = rowEl.querySelector('a');
			link?.focus();
		}
	});

	export function getRowElement(): HTMLTableRowElement | undefined {
		return rowEl;
	}

	export function focus() {
		rowEl?.querySelector('a')?.focus();
	}
</script>

<tr
	bind:this={rowEl}
	class="hover:bg-gray-50 dark:hover:bg-gray-750 transition-colors"
	class:ring-2={focused}
	class:ring-inset={focused}
	class:ring-primary-500={focused}
>
	<td class="py-2 px-4">
		<a
			href={getHref()}
			onclick={handlePrimaryClick}
			aria-label={getAriaLabel()}
			class="flex items-center gap-3 text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400"
		>
			<div
				class="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
				class:bg-primary-100={file.isDirectory}
				class:dark:bg-primary-900={file.isDirectory}
				class:bg-gray-100={!file.isDirectory}
				class:dark:bg-gray-700={!file.isDirectory}
			>
				<Icon
					name={getIcon()}
					size={20}
					class={file.isDirectory ? 'text-primary-600 dark:text-primary-400' : 'text-gray-600 dark:text-gray-400'}
				/>
			</div>
			<span class="font-medium truncate">{file.name}</span>
		</a>
	</td>
	<td class="py-2 px-4 text-sm text-gray-500 dark:text-gray-400 hidden sm:table-cell">
		{formatBytes(file.size)}
	</td>
	<td class="py-2 px-4 text-sm text-gray-500 dark:text-gray-400 hidden sm:table-cell">
		<span aria-label={formatDateAccessible(file.modifiedAt)}>
			{formatDate(file.modifiedAt)}
		</span>
	</td>
	<td class="py-2 px-4 text-right">
		<ActionsDropdown {file} {ondelete} {onprotect} {onconvert} {isUnlocked} />
	</td>
</tr>
