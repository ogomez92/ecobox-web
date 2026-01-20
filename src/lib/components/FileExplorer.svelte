<script lang="ts">
	import Icon from './Icon.svelte';
	import SearchBar from './SearchBar.svelte';
	import Breadcrumbs from './Breadcrumbs.svelte';
	import FileRow from './FileRow.svelte';
	import StorageFooter from './StorageFooter.svelte';
	import UploadDialog from './UploadDialog.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { filesStore } from '$lib/stores/files.svelte';
	import { goto } from '$app/navigation';
	import type { FileEntry } from '$lib/types';

	interface Props {
		initialPath?: string;
		focusFile?: string;
	}

	let { initialPath = '', focusFile }: Props = $props();

	let showUploadDialog = $state(false);
	let deleteTarget = $state<FileEntry | null>(null);
	let focusedIndex = $state(-1);
	let hasAppliedFocus = $state(false);
	let atRootAnnouncement = $state('');
	let emptyFolderUploadButton: HTMLButtonElement | undefined = $state();

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
			atRootAnnouncement = 'Already at root directory';
			setTimeout(() => atRootAnnouncement = '', 1000);
			return;
		}
		const parent = parentPath();
		if (parent === '') {
			goto('/');
		} else {
			goto(`/browse/${parent}`);
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

	function getSortIcon(field: 'name' | 'size' | 'modifiedAt'): 'chevron-up' | 'chevron-down' {
		if (filesStore.sortField === field) {
			return filesStore.sortDirection === 'asc' ? 'chevron-up' : 'chevron-down';
		}
		return 'chevron-down';
	}

	function handleTableKeydown(e: KeyboardEvent) {
		const files = filesStore.sortedFiles;
		if (files.length === 0) return;

		// Arrow navigation
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			if (focusedIndex < files.length - 1) {
				focusedIndex = focusedIndex + 1;
			} else {
				focusedIndex = 0;
			}
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			if (focusedIndex <= 0) {
				focusedIndex = files.length - 1;
			} else {
				focusedIndex = focusedIndex - 1;
			}
		}

		// Letter/number navigation - find next match starting with key
		else if (/^[a-z0-9]$/i.test(e.key)) {
			const char = e.key.toLowerCase();
			const startIndex = focusedIndex + 1;

			// Search from current position to end
			let found = files.findIndex((f, i) =>
				i >= startIndex && f.name.toLowerCase().startsWith(char)
			);

			// Wrap around to beginning
			if (found === -1) {
				found = files.findIndex(f => f.name.toLowerCase().startsWith(char));
			}

			if (found !== -1) {
				focusedIndex = found;
			}
		}

		// Delete key - open confirmation
		else if (e.key === 'Delete' && focusedIndex >= 0) {
			e.preventDefault();
			deleteTarget = files[focusedIndex];
		}

		// Backspace - go to parent directory
		else if (e.key === 'Backspace') {
			e.preventDefault();
			goToParent();
		}

		// Home - go to first item
		else if (e.key === 'Home') {
			e.preventDefault();
			focusedIndex = 0;
		}

		// End - go to last item
		else if (e.key === 'End') {
			e.preventDefault();
			focusedIndex = files.length - 1;
		}
	}
</script>

<div class="flex flex-col h-screen">
	<!-- Live region for announcements -->
	<div class="sr-only" aria-live="assertive" aria-atomic="true">
		{atRootAnnouncement}
	</div>

	<header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 pt-safe-top sticky top-0 z-10">
		<div class="max-w-4xl mx-auto">
			<div class="flex items-center justify-between py-3">
				<a href="/" class="text-xl font-bold text-gray-900 dark:text-gray-100 hover:text-primary-600 dark:hover:text-primary-400">
					<Icon name="home" size={20} class="inline-block mr-1 align-text-bottom" />
					Ecobox
				</a>
				<div class="flex items-center gap-2">
					<button
						type="button"
						onclick={() => showUploadDialog = true}
						class="btn-primary"
						aria-label="Upload files"
					>
						<Icon name="upload" size={20} />
						<span class="ml-2 hidden sm:inline">Upload</span>
					</button>
					<a
						href="/settings"
						class="btn-ghost"
						aria-label="Settings"
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

	<main class="flex-1 overflow-y-auto pb-20" aria-label="File list">
		<div class="max-w-4xl mx-auto">
			{#if filesStore.isLoading}
				<div class="flex items-center justify-center py-12" aria-live="polite">
					<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
					<span class="sr-only">Loading files...</span>
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
						Try Again
					</button>
				</div>
			{:else if filesStore.sortedFiles.length === 0}
				<div class="text-center py-12">
					<Icon name="folder" size={48} class="mx-auto text-gray-400 mb-4" />
					<p class="text-gray-600 dark:text-gray-400">
						{filesStore.searchQuery ? 'No matching files found' : 'This folder is empty'}
					</p>
					{#if !filesStore.searchQuery}
						<button
							bind:this={emptyFolderUploadButton}
							type="button"
							onclick={() => showUploadDialog = true}
							class="btn-primary mt-4"
						>
							<Icon name="upload" size={20} class="mr-2" />
							Upload Files
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
						<span>Parent directory</span>
					</a>
				{:else}
					<div class="flex items-center gap-2 px-4 py-3 text-gray-400 dark:text-gray-500 border-b border-gray-200 dark:border-gray-700 sm:hidden" aria-disabled="true">
						<Icon name="chevron-up" size={20} />
						<span>At root directory</span>
					</div>
				{/if}

				<table class="w-full" role="grid" aria-label="File list">
					<thead class="sticky top-0 bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700">
						<tr>
							<th class="text-left py-2 px-4">
								<button
									type="button"
									onclick={() => filesStore.setSort('name')}
									class="flex items-center gap-1 text-sm font-medium text-gray-700 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100"
									aria-label="Sort by name{filesStore.sortField === 'name' ? `, currently ${filesStore.sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}"
								>
									Name
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
									aria-label="Sort by size{filesStore.sortField === 'size' ? `, currently ${filesStore.sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}"
								>
									Size
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
									aria-label="Sort by date{filesStore.sortField === 'modifiedAt' ? `, currently ${filesStore.sortDirection === 'asc' ? 'ascending' : 'descending'}` : ''}"
								>
									Date
									{#if filesStore.sortField === 'modifiedAt'}
										<Icon name={getSortIcon('modifiedAt')} size={14} />
									{/if}
								</button>
							</th>
							<th class="py-2 px-4">
								<span class="sr-only">Actions</span>
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
		onclose={() => showUploadDialog = false}
		oncomplete={handleUploadComplete}
	/>

	<ConfirmDialog
		isOpen={deleteTarget !== null}
		title="Delete {deleteTarget?.isDirectory ? 'Folder' : 'File'}"
		message="Are you sure you want to delete '{deleteTarget?.name}'? This action cannot be undone."
		confirmText="Delete"
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
