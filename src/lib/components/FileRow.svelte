<script lang="ts">
	import Icon from './Icon.svelte';
	import ActionsDropdown from './ActionsDropdown.svelte';
	import { formatBytes, formatDate, formatDateAccessible } from '$lib/utils/format';
	import type { FileEntry } from '$lib/types';

	interface Props {
		file: FileEntry;
		focused?: boolean;
		ondelete: () => void;
		onprotect?: () => void;
		isUnlocked?: boolean;
	}

	let { file, focused = false, ondelete, onprotect, isUnlocked = false }: Props = $props();

	let rowEl: HTMLTableRowElement | undefined = $state();

	function getIcon() {
		if (file.isDirectory) {
			if (file.isDaisyBook) return 'book';
			if (file.isChapteredFolder) return 'folder';
			return 'folder';
		}
		if (file.isRadioFile) return 'radio';
		return 'audio';
	}

	function getHref(): string {
		if (file.isDirectory) {
			// DAISY books and chaptered folders go to player, not browser
			if (file.isDaisyBook || file.isChapteredFolder) {
				return `/play/${file.path}`;
			}
			return `/browse/${file.path}`;
		}
		return `/play/${file.path}`;
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
			if (file.isDaisyBook) {
				parts.push('DAISY book folder');
			} else if (file.isChapteredFolder) {
				parts.push('chaptered folder');
			} else {
				parts.push('folder');
			}
		} else if (file.isRadioFile) {
			parts.push('radio station');
		} else {
			parts.push(`${getFileExtension()} file`);
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
		<ActionsDropdown {file} {ondelete} {onprotect} {isUnlocked} />
	</td>
</tr>
