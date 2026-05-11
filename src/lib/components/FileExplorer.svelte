<script lang="ts">
	import Icon from './Icon.svelte';
	import SearchBar from './SearchBar.svelte';
	import Breadcrumbs from './Breadcrumbs.svelte';
	import FileRow from './FileRow.svelte';
	import StorageFooter from './StorageFooter.svelte';
	import UploadDialog from './UploadDialog.svelte';
	import ActionsMenu from './ActionsMenu.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { filesStore } from '$lib/stores/files.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { goto } from '$app/navigation';
	import type { FileEntry } from '$lib/types';

	interface Props {
		initialPath?: string;
		focusFile?: string;
	}

	let { initialPath = '', focusFile }: Props = $props();

	let showUploadDialog = $state(false);
	let uploadInitialTab = $state<'upload' | 'radio'>('upload');
	let uploadInitialPicker = $state<'file' | 'folder' | null>(null);
	let deleteTarget = $state<FileEntry | null>(null);
	let focusedIndex = $state(-1);
	let hasAppliedFocus = $state(false);
	let liveAnnouncement = $state('');
	let emptyFolderUploadButton: HTMLButtonElement | undefined = $state();
	let actionsMenuOpen = $state(false);

	let typeBuffer = '';
	let lastTypeTime = 0;
	const TYPE_TIMEOUT_MS = 1000;

	function announce(message: string) {
		liveAnnouncement = '';
		// Force the live region to re-fire even if the message repeats
		setTimeout(() => { liveAnnouncement = message; }, 10);
	}

	function findStartingWith(prefix: string, startIdx: number): number {
		const files = filesStore.sortedFiles;
		for (let i = startIdx; i < files.length; i++) {
			if (files[i].name.toLowerCase().startsWith(prefix)) return i;
		}
		return -1;
	}

	function resetTypeBuffer() {
		typeBuffer = '';
		lastTypeTime = 0;
	}

	const isAtRoot = $derived(initialPath === '');
	const parentPath = $derived(() => {
		if (isAtRoot) return null;
		const parts = initialPath.split('/').filter(Boolean);
		parts.pop();
		return parts.join('/');
	});

	$effect(() => {
		filesStore.loadFiles(initialPath);
		filesStore.loadStorage();
		hasAppliedFocus = false;
	});

	// Focus the specified file or first item when files are loaded
	// If folder is empty, focus the upload button
	$effect(() => {
		const files = filesStore.sortedFiles;
		if (!hasAppliedFocus && !filesStore.isLoading) {
			if (files.length > 0) {
				if (focusFile) {
					const index = files.findIndex(f => f.name === focusFile);
					if (index !== -1) {
						focusedIndex = index;
						hasAppliedFocus = true;
					}
				} else {
					// Focus first item by default
					focusedIndex = 0;
					hasAppliedFocus = true;
				}
			} else if (!filesStore.searchQuery && emptyFolderUploadButton) {
				// Folder is empty and no search - focus upload button
				emptyFolderUploadButton.focus();
				hasAppliedFocus = true;
			}
		}
	});

	function handleNavigate(path: string) {
		if (path === '') {
			goto('/');
		} else {
			goto(`/browse/${path}`);
		}
	}

	function goToParent() {
		if (isAtRoot) {
			announce(t('explorer.atRootAnnouncement'));
			return;
		}
		const parts = initialPath.split('/').filter(Boolean);
		const leftFolder = parts[parts.length - 1];
		const parent = parentPath();
		const focusQuery = leftFolder ? `?focus=${encodeURIComponent(leftFolder)}` : '';
		if (parent === '') {
			goto(`/${focusQuery}`);
		} else {
			goto(`/browse/${parent}${focusQuery}`);
		}
	}

	function handleDeleteConfirm() {
		if (deleteTarget) {
			filesStore.deleteFile(deleteTarget.path);
			deleteTarget = null;
		}
	}

	function handleUploadComplete() {
		filesStore.loadFiles(filesStore.currentPath);
		filesStore.loadStorage();
	}

	function openUpload(picker: 'file' | 'folder' | null, tab: 'upload' | 'radio' = 'upload') {
		uploadInitialPicker = picker;
		uploadInitialTab = tab;
		showUploadDialog = true;
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		// Alt+N opens the actions menu. Ignore when inside form fields or modal dialogs.
		if (!(e.altKey && (e.key === 'n' || e.key === 'N'))) return;
		if (e.ctrlKey || e.metaKey || e.shiftKey) return;
		const target = e.target as HTMLElement | null;
		if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
		if (showUploadDialog || deleteTarget) return;
		e.preventDefault();
		actionsMenuOpen = true;
	}

	function getSortIcon(field: 'name' | 'size' | 'modifiedAt'): 'chevron-up' | 'chevron-down' {
		if (filesStore.sortField === field) {
			return filesStore.sortDirection === 'asc' ? 'chevron-up' : 'chevron-down';
		}
		return 'chevron-down';
	}

	function sortStateLabel(field: 'name' | 'size' | 'modifiedAt'): string {
		if (filesStore.sortField !== field) return '';
		return filesStore.sortDirection === 'asc'
			? `, ${t('explorer.sortStateAsc')}`
			: `, ${t('explorer.sortStateDesc')}`;
	}

	function handleTableKeydown(e: KeyboardEvent) {
		const files = filesStore.sortedFiles;
		if (files.length === 0) return;

		// Arrow navigation (no wrap at boundaries) — cancels in-progress letter nav
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			resetTypeBuffer();
			if (focusedIndex < files.length - 1) {
				focusedIndex = focusedIndex + 1;
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			resetTypeBuffer();
			if (focusedIndex > 0) {
				focusedIndex = focusedIndex - 1;
			}
		}

		// Multi-letter type-ahead navigation (mirrors Windows Explorer / Google Docs)
		else if (e.key.length === 1 && /^[\p{L}\p{N}]$/u.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
			handleLetterNav(e.key.toLowerCase());
		}

		// Delete key - open confirmation
		else if (e.key === 'Delete' && focusedIndex >= 0) {
			e.preventDefault();
			resetTypeBuffer();
			deleteTarget = files[focusedIndex];
		}

		// Backspace - go to parent directory
		else if (e.key === 'Backspace') {
			e.preventDefault();
			resetTypeBuffer();
			goToParent();
		}

		// Home - go to first item
		else if (e.key === 'Home') {
			e.preventDefault();
			resetTypeBuffer();
			focusedIndex = 0;
		}

		// End - go to last item
		else if (e.key === 'End') {
			e.preventDefault();
			resetTypeBuffer();
			focusedIndex = files.length - 1;
		}

		// Enter / Escape / anything else: cancel in-progress letter navigation
		else if (e.key === 'Enter' || e.key === 'Escape' || e.key === ' ' || e.key === 'Tab') {
			resetTypeBuffer();
		}
	}

	function handleLetterNav(char: string) {
		const files = filesStore.sortedFiles;
		const now = Date.now();
		if (now - lastTypeTime > TYPE_TIMEOUT_MS) {
			typeBuffer = '';
		}
		lastTypeTime = now;

		if (typeBuffer === '') {
			// Fresh single-letter navigation: cycle from current focus + 1
			let idx = findStartingWith(char, focusedIndex + 1);
			if (idx === -1) idx = findStartingWith(char, 0);
			if (idx !== -1) {
				focusedIndex = idx;
				typeBuffer = char;
			} else {
				announce(t('explorer.noMatchForLetters', { letters: char }));
			}
			return;
		}

		const attempted = typeBuffer + char;

		// If current focus already matches the extended prefix, stay put
		if (focusedIndex >= 0 && files[focusedIndex].name.toLowerCase().startsWith(attempted)) {
			typeBuffer = attempted;
			return;
		}

		// Otherwise jump to first match for the extended prefix
		const idx = findStartingWith(attempted, 0);
		if (idx !== -1) {
			focusedIndex = idx;
			typeBuffer = attempted;
			return;
		}

		// Extended prefix doesn't match anything — fall back to cycling on just the new char
		let fallback = findStartingWith(char, focusedIndex + 1);
		if (fallback === -1) fallback = findStartingWith(char, 0);
		if (fallback !== -1) {
			focusedIndex = fallback;
			typeBuffer = char;
		} else {
			announce(t('explorer.noMatchForLetters', { letters: attempted }));
			typeBuffer = '';
		}
	}
</script>

<svelte:window onkeydown={handleGlobalKeydown} />

<div class="flex flex-col h-screen">
	<!-- Live region for announcements -->
	<div class="sr-only" aria-live="assertive" aria-atomic="true">
		{liveAnnouncement}
	</div>

	<header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 pt-safe-top sticky top-0 z-10">
		<div class="max-w-4xl mx-auto">
			<div class="flex items-center justify-between py-3">
				<a href="/" class="text-xl font-bold text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400">
					<Icon name="home" size={20} class="inline-block mr-1 align-text-bottom" />
					{t('app.title')}
				</a>
				<div class="flex items-center gap-2">
					<ActionsMenu
						bind:isOpen={actionsMenuOpen}
						onuploadfiles={() => openUpload('file')}
						onuploadfolder={() => openUpload('folder')}
						onaddradio={() => openUpload(null, 'radio')}
					/>
					<a
						href="/settings"
						class="btn-ghost"
						aria-label={t('common.settings')}
					>
						<Icon name="settings" size={20} />
					</a>
				</div>
			</div>

			<div class="pb-3 space-y-3">
				<SearchBar
					value={filesStore.searchQuery}
					onchange={(value) => filesStore.setSearch(value)}
				/>
				<Breadcrumbs
					items={filesStore.breadcrumbs}
					onnavigate={handleNavigate}
				/>
			</div>
		</div>
	</header>

	<main class="flex-1 overflow-y-auto pb-20" aria-label={t('explorer.fileList')}>
		<div class="max-w-4xl mx-auto">
			{#if filesStore.isLoading}
				<div class="flex items-center justify-center py-12" aria-live="polite">
					<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
					<span class="sr-only">{t('explorer.loading')}</span>
				</div>
			{:else if filesStore.error}
				<div class="text-center py-12" role="alert">
					<Icon name="x" size={48} class="mx-auto text-red-500 mb-4" />
					<p class="text-gray-600 dark:text-gray-400">{filesStore.error}</p>
					<button
						type="button"
						onclick={() => filesStore.loadFiles(filesStore.currentPath)}
						class="btn-secondary mt-4"
					>
						{t('common.tryAgain')}
					</button>
				</div>
			{:else if filesStore.sortedFiles.length === 0}
				<div class="text-center py-12">
					<Icon name="folder" size={48} class="mx-auto text-gray-400 mb-4" />
					<p class="text-gray-600 dark:text-gray-400">
						{filesStore.searchQuery ? t('explorer.noMatches') : t('explorer.empty')}
					</p>
					{#if !filesStore.searchQuery}
						<button
							bind:this={emptyFolderUploadButton}
							type="button"
							onclick={() => openUpload('file')}
							class="btn-primary mt-4"
						>
							<Icon name="upload" size={20} class="mr-2" />
							{t('explorer.uploadFiles')}
						</button>
					{/if}
				</div>
			{:else}
				<!-- Parent directory link for mobile -->
				{#if !isAtRoot}
					<a
						href={parentPath() === '' ? '/' : `/browse/${parentPath()}`}
						class="flex items-center gap-2 px-4 py-3 text-primary-600 dark:text-primary-400 hover:bg-gray-50 dark:hover:bg-gray-750 border-b border-gray-200 dark:border-gray-700 sm:hidden"
					>
						<Icon name="chevron-up" size={20} />
						<span>{t('explorer.parentDirectory')}</span>
					</a>
				{:else}
					<div class="flex items-center gap-2 px-4 py-3 text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700 sm:hidden" aria-disabled="true">
						<Icon name="chevron-up" size={20} />
						<span>{t('explorer.atRootDirectory')}</span>
					</div>
				{/if}

				<table class="w-full" role="grid" aria-label={t('explorer.fileList')}>
					<thead class="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
						<tr>
							<th class="text-left py-2 px-4">
								<button
									type="button"
									onclick={() => filesStore.setSort('name')}
									class="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
									aria-label={`${t('explorer.sortByName')}${sortStateLabel('name')}`}
								>
									{t('explorer.colName')}
									{#if filesStore.sortField === 'name'}
										<Icon name={getSortIcon('name')} size={14} />
									{/if}
								</button>
							</th>
							<th class="text-left py-2 px-4 hidden sm:table-cell">
								<button
									type="button"
									onclick={() => filesStore.setSort('size')}
									class="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
									aria-label={`${t('explorer.sortBySize')}${sortStateLabel('size')}`}
								>
									{t('explorer.colSize')}
									{#if filesStore.sortField === 'size'}
										<Icon name={getSortIcon('size')} size={14} />
									{/if}
								</button>
							</th>
							<th class="text-left py-2 px-4 hidden sm:table-cell">
								<button
									type="button"
									onclick={() => filesStore.setSort('modifiedAt')}
									class="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
									aria-label={`${t('explorer.sortByDate')}${sortStateLabel('modifiedAt')}`}
								>
									{t('explorer.colDate')}
									{#if filesStore.sortField === 'modifiedAt'}
										<Icon name={getSortIcon('modifiedAt')} size={14} />
									{/if}
								</button>
							</th>
							<th class="py-2 px-4">
								<span class="sr-only">{t('explorer.colActions')}</span>
							</th>
						</tr>
					</thead>
					<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
					<tbody onkeydown={handleTableKeydown}>
						{#each filesStore.sortedFiles as file, index (file.path)}
							<FileRow
								{file}
								focused={focusedIndex === index}
								ondelete={() => deleteTarget = file}
								onprotect={() => filesStore.toggleProtection(file.path)}
								isUnlocked={filesStore.unlocked}
							/>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>
	</main>

	<StorageFooter storage={filesStore.storage} />

	<UploadDialog
		isOpen={showUploadDialog}
		currentPath={filesStore.currentPath}
		initialTab={uploadInitialTab}
		initialPicker={uploadInitialPicker}
		onclose={() => showUploadDialog = false}
		oncomplete={handleUploadComplete}
	/>

	<ConfirmDialog
		isOpen={deleteTarget !== null}
		title={deleteTarget?.isDirectory ? t('dialog.deleteFolder') : t('dialog.deleteFile')}
		message={t('dialog.deleteConfirm', { name: deleteTarget?.name ?? '' })}
		confirmText={t('common.delete')}
		destructive={true}
		onconfirm={handleDeleteConfirm}
		oncancel={() => deleteTarget = null}
	/>
</div>

<style>
	.pt-safe-top {
		padding-top: max(0.75rem, env(safe-area-inset-top));
	}
</style>
