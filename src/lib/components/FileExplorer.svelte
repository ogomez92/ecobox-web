<script lang="ts">
	import { tick } from 'svelte';
	import Icon from './Icon.svelte';
	import Breadcrumbs from './Breadcrumbs.svelte';
	import FileRow from './FileRow.svelte';
	import StorageFooter from './StorageFooter.svelte';
	import UploadDialog from './UploadDialog.svelte';
	import ActionsMenu from './ActionsMenu.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import NewFolderDialog from './NewFolderDialog.svelte';
	import SearchDialog from './SearchDialog.svelte';
	import RecentList from './RecentList.svelte';
	import { filesStore } from '$lib/stores/files.svelte';
	import { recentStore } from '$lib/stores/recent.svelte';
	import { t } from '$lib/i18n/index.svelte';
	import { goto } from '$app/navigation';
	import type { FileEntry } from '$lib/types';

	interface Props {
		initialPath?: string;
		focusFile?: string;
	}

	let { initialPath = '', focusFile }: Props = $props();

	/**
	 * The two views of the library, as a WAI-ARIA tablist: the folder browser and
	 * the recently-opened list. Files is always the tab on load — a fresh page is
	 * never dropped into Recent, however the user left it — and Alt+1 / Alt+2 jump
	 * straight to a tab from anywhere on the page.
	 *
	 * Activation follows focus (arrow keys select as they move), which is the APG
	 * default for cheap panels; both panels stay mounted and the inactive one is
	 * `hidden`, so switching back to Files doesn't re-run its focus-the-first-row
	 * effect and yank focus off the tab.
	 */
	const TABS = ['files', 'recent'] as const;
	type TabId = (typeof TABS)[number];
	let activeTab = $state<TabId>('files');
	let tabRefs = $state<Record<TabId, HTMLButtonElement | null>>({ files: null, recent: null });
	let recentListRef: RecentList | null = $state(null);

	let showUploadDialog = $state(false);
	let uploadInitialTab = $state<'upload' | 'radio'>('upload');
	let uploadInitialPicker = $state<'file' | 'folder' | null>(null);
	let deleteTarget = $state<FileEntry | null>(null);
	let focusedIndex = $state(-1);
	let hasAppliedFocus = $state(false);
	let liveAnnouncement = $state('');
	let emptyFolderUploadButton: HTMLButtonElement | undefined = $state();
	let rowRefs = $state<(FileRow | null)[]>([]);
	let actionsMenuOpen = $state(false);
	// Set when the upload dialog closes so focus returns to the list once the
	// post-upload reload settles (the dialog steals focus while open).
	let focusListWhenReady = $state(false);
	let showSearchDialog = $state(false);
	let showNewFolderDialog = $state(false);
	let searchButtonRef: HTMLButtonElement | undefined = $state();
	// Element that had focus when the search dialog opened, so closing it (Escape,
	// the X, the backdrop) puts the user back exactly where they were.
	let searchReturnFocus: HTMLElement | null = null;

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
			} else if (emptyFolderUploadButton) {
				// Folder is empty and no search - focus upload button
				emptyFolderUploadButton.focus();
				hasAppliedFocus = true;
			}
		}
	});

	// After the upload dialog closes, return focus to the file list. Deferred via
	// a flag because the post-upload reload is async — wait until files settle.
	$effect(() => {
		if (!focusListWhenReady || filesStore.isLoading) return;
		if (filesStore.sortedFiles.length > 0) {
			focusList();
		} else {
			emptyFolderUploadButton?.focus();
		}
		focusListWhenReady = false;
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

	async function handleConvert(file: FileEntry) {
		announce(t('upload.converting', { name: file.name }));
		try {
			const res = await fetch('/api/books/convert', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: file.path })
			});
			const data = res.ok ? await res.json() : { status: 'failed' };
			if (data.status === 'verified') {
				announce(t('upload.convertVerified', { name: file.name }));
			} else if (data.status === 'unverified') {
				announce(t('upload.convertUnverified', { name: file.name }));
			} else {
				// Surface the server's specific cause (pandoc missing, too large, etc.) when present.
				const base = t('upload.convertFailed', { name: file.name });
				announce(data.reason ? `${base} — ${data.reason}` : base);
			}
		} catch {
			announce(t('upload.convertFailed', { name: file.name }));
		}
		filesStore.loadFiles(filesStore.currentPath);
		filesStore.loadStorage();
	}

	function openUpload(picker: 'file' | 'folder' | null, tab: 'upload' | 'radio' = 'upload') {
		uploadInitialPicker = picker;
		uploadInitialTab = tab;
		showUploadDialog = true;
	}

	function openSearch() {
		if (showSearchDialog) return;
		const active = document.activeElement;
		searchReturnFocus = active instanceof HTMLElement ? active : null;
		showSearchDialog = true;
	}

	function closeSearch(options?: { restoreFocus?: boolean }) {
		showSearchDialog = false;
		// Restore focus to the opener when it's still on the page; otherwise fall
		// back to the search button so focus is never left on <body>. Skipped when
		// the dialog closed because a result is being opened — that page owns focus.
		const target = searchReturnFocus?.isConnected ? searchReturnFocus : searchButtonRef;
		searchReturnFocus = null;
		if (options?.restoreFocus === false) return;
		tick().then(() => target?.focus());
	}

	function openNewFolder() {
		if (showNewFolderDialog) return;
		showNewFolderDialog = true;
	}

	/**
	 * Cancelling drops focus into the list rather than back on the actions button:
	 * the user came here to work on the folder's contents, so that is where they
	 * continue. Only an empty list falls back to the button, so focus is never
	 * stranded on <body>.
	 */
	function closeNewFolder() {
		showNewFolderDialog = false;
		tick().then(() => {
			if (!focusList()) emptyFolderUploadButton?.focus();
		});
	}

	/**
	 * A folder was created in the browsed directory: reload the listing and put
	 * focus on the new row, so a keyboard user lands on what they just made (and
	 * can press Enter to go straight into it). The Files tab is selected first —
	 * the actions menu is reachable from the Recent tab too, and the new folder
	 * only exists in the browser.
	 */
	async function handleFolderCreated(name: string) {
		showNewFolderDialog = false;
		announce(t('newFolder.created', { name }));
		activeTab = 'files';
		await filesStore.loadFiles(filesStore.currentPath);
		filesStore.loadStorage();
		await tick();
		const index = filesStore.sortedFiles.findIndex((f) => f.name === name);
		if (index === -1) {
			focusList();
			return;
		}
		focusedIndex = index;
		await tick();
		rowRefs[index]?.focus();
	}

	/**
	 * Switch tabs. The recent list is re-fetched on every activation because it
	 * changes behind the user's back — playing a file reorders it, and deleting one
	 * changes where an entry points.
	 *
	 * Where focus lands depends on how the tab was chosen. Moving *within* the
	 * tablist keeps focus on the tab (`focusTab`) — the standard pattern, so the
	 * tabs stay navigable. The Alt+1 / Alt+2 shortcuts instead drop straight into
	 * the panel's list (`focusList`), since that is where the user is going; the
	 * tabs are still one Shift+Tab away.
	 */
	async function selectTab(tab: TabId, options: { focusTab?: boolean; focusList?: boolean } = {}) {
		activeTab = tab;
		// Kept as a promise: on the first Alt+2 the list is still being fetched, and
		// focus has to wait for the rows to exist before it can land on one.
		const loading = tab === 'recent' ? recentStore.load() : Promise.resolve();

		if (options.focusTab) {
			await tick();
			tabRefs[tab]?.focus();
			return;
		}
		if (!options.focusList) return;

		await loading;
		await tick();
		// The user may have switched away again while the list was loading.
		if (activeTab !== tab) return;
		// An empty list has nothing to focus — fall back to the tab so focus is
		// never left stranded on <body> (the old panel is `hidden` by now).
		if (!focusList()) tabRefs[tab]?.focus();
	}

	function onTabKeydown(e: KeyboardEvent, tab: TabId) {
		const index = TABS.indexOf(tab);
		let next = -1;
		switch (e.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				next = (index + 1) % TABS.length;
				break;
			case 'ArrowLeft':
			case 'ArrowUp':
				next = (index - 1 + TABS.length) % TABS.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = TABS.length - 1;
				break;
			default:
				return;
		}
		e.preventDefault();
		selectTab(TABS[next], { focusTab: true });
	}

	/** Focus the active panel's list. Returns false when it had nothing to focus. */
	function focusList(): boolean {
		if (activeTab === 'recent') {
			return recentListRef?.focusList() ?? false;
		}
		const files = filesStore.sortedFiles;
		if (files.length === 0) return false;
		const target = focusedIndex >= 0 && focusedIndex < files.length ? focusedIndex : 0;
		focusedIndex = target;
		// Force focus even when focusedIndex is unchanged (e.g. coming from the
		// search dialog), so the `focused` $effect alone can't be relied upon.
		rowRefs[target]?.focus();
		return true;
	}

	function handleGlobalKeydown(e: KeyboardEvent) {
		const target = e.target as HTMLElement | null;
		const inField = !!target?.closest('input, textarea, select, [contenteditable="true"]');

		// Ctrl+F (Cmd+F on Mac) opens the recursive search dialog, replacing the
		// browser's own find bar. Like Ctrl+L it deliberately skips the field guard,
		// so it works no matter what currently has focus.
		if ((e.ctrlKey || e.metaKey) && (e.key === 'f' || e.key === 'F') && !e.shiftKey && !e.altKey) {
			if (showUploadDialog || deleteTarget || showSearchDialog || showNewFolderDialog) return;
			e.preventDefault();
			openSearch();
			return;
		}

		// Everything below is inert while a modal dialog owns the screen.
		if (showSearchDialog || showNewFolderDialog) return;

		// Ctrl+L moves focus to the file list, no matter what currently has focus
		// — so it intentionally skips the field guard.
		if (e.ctrlKey && (e.key === 'l' || e.key === 'L') && !e.metaKey && !e.shiftKey && !e.altKey) {
			if (showUploadDialog || deleteTarget) return;
			e.preventDefault();
			focusList();
			return;
		}

		// Ctrl+, opens the app settings page (no player open in this context).
		if (e.ctrlKey && e.key === ',' && !e.metaKey && !e.shiftKey && !e.altKey) {
			if (inField) return;
			if (showUploadDialog || deleteTarget) return;
			e.preventDefault();
			goto('/settings');
			return;
		}

		if (!e.altKey || e.ctrlKey || e.metaKey || e.shiftKey) return;
		if (inField) return;
		if (showUploadDialog || deleteTarget) return;

		// Alt+1 / Alt+2 jump to a tab from anywhere on the page and land focus *in*
		// that tab's list, ready to arrow through (Shift+Tab reaches the tabs from
		// there). Matched on `code` as well as `key`, because Alt+digit emits a
		// symbol rather than a digit on several keyboard layouts (and on the keypad).
		const digit =
			e.key === '1' || e.code === 'Digit1' || e.code === 'Numpad1'
				? 1
				: e.key === '2' || e.code === 'Digit2' || e.code === 'Numpad2'
					? 2
					: 0;
		if (digit) {
			e.preventDefault();
			selectTab(digit === 1 ? 'files' : 'recent', { focusList: true });
			return;
		}

		// Alt+N opens the actions menu.
		if (e.key !== 'n' && e.key !== 'N') return;
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

		// Multi-letter type-ahead navigation (mirrors Windows Explorer / Google Docs).
		// Space is allowed mid-word so names like "los espadachines" are reachable,
		// but a leading space (empty buffer) is left to the cancel branch below.
		else if (
			e.key.length === 1 &&
			!e.ctrlKey &&
			!e.metaKey &&
			!e.altKey &&
			(/^[\p{L}\p{N}]$/u.test(e.key) || (e.key === ' ' && typeBuffer !== ''))
		) {
			if (e.key === ' ') e.preventDefault(); // don't scroll the page mid-typeahead
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
					<button
						bind:this={searchButtonRef}
						type="button"
						onclick={openSearch}
						class="btn-ghost"
						aria-label={t('search.openAria')}
						aria-haspopup="dialog"
					>
						<Icon name="search" size={20} />
					</button>
					<ActionsMenu
						bind:isOpen={actionsMenuOpen}
						onuploadfiles={() => openUpload('file')}
						onuploadfolder={() => openUpload('folder')}
						onaddradio={() => openUpload(null, 'radio')}
						onnewfolder={openNewFolder}
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

			<div role="tablist" aria-label={t('tabs.label')} class="flex gap-1">
				{#each TABS as tab (tab)}
					<button
						bind:this={tabRefs[tab]}
						type="button"
						role="tab"
						id="explorer-tab-{tab}"
						aria-selected={activeTab === tab}
						aria-controls="explorer-panel-{tab}"
						aria-label={tab === 'files' ? t('tabs.filesAria') : t('tabs.recentAria')}
						tabindex={activeTab === tab ? 0 : -1}
						onclick={() => selectTab(tab)}
						onkeydown={(e) => onTabKeydown(e, tab)}
						class="flex items-center gap-1.5 px-4 py-2 text-sm font-medium rounded-t-lg border-b-2 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
						class:border-primary-500={activeTab === tab}
						class:text-primary-600={activeTab === tab}
						class:dark:text-primary-400={activeTab === tab}
						class:border-transparent={activeTab !== tab}
						class:text-gray-500={activeTab !== tab}
						class:dark:text-gray-400={activeTab !== tab}
						class:hover:text-gray-700={activeTab !== tab}
						class:dark:hover:text-gray-200={activeTab !== tab}
					>
						<Icon name={tab === 'files' ? 'folder' : 'clock'} size={16} />
						{tab === 'files' ? t('tabs.files') : t('tabs.recent')}
					</button>
				{/each}
			</div>

			{#if activeTab === 'files'}
				<div class="py-3">
					<Breadcrumbs
						items={filesStore.breadcrumbs}
						onnavigate={handleNavigate}
					/>
				</div>
			{:else}
				<div class="pb-3"></div>
			{/if}
		</div>
	</header>

	<main class="flex-1 overflow-y-auto pb-20">
		<div
			id="explorer-panel-files"
			role="tabpanel"
			aria-labelledby="explorer-tab-files"
			hidden={activeTab !== 'files'}
			class="max-w-4xl mx-auto"
		>
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
						{t('explorer.empty')}
					</p>
					<button
						bind:this={emptyFolderUploadButton}
						type="button"
						onclick={() => openUpload('file')}
						class="btn-primary mt-4"
					>
						<Icon name="upload" size={20} class="mr-2" />
						{t('explorer.uploadFiles')}
					</button>
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
								bind:this={rowRefs[index]}
								{file}
								focused={focusedIndex === index}
								ondelete={() => deleteTarget = file}
								onprotect={() => filesStore.toggleProtection(file.path)}
								onconvert={() => handleConvert(file)}
								isUnlocked={filesStore.unlocked}
							/>
						{/each}
					</tbody>
				</table>
			{/if}
		</div>

		<div
			id="explorer-panel-recent"
			role="tabpanel"
			aria-labelledby="explorer-tab-recent"
			hidden={activeTab !== 'recent'}
		>
			<RecentList bind:this={recentListRef} />
		</div>
	</main>

	<StorageFooter storage={filesStore.storage} />

	<UploadDialog
		isOpen={showUploadDialog}
		currentPath={filesStore.currentPath}
		initialTab={uploadInitialTab}
		initialPicker={uploadInitialPicker}
		onclose={() => {
			showUploadDialog = false;
			focusListWhenReady = true;
		}}
		oncomplete={handleUploadComplete}
	/>

	{#if showSearchDialog}
		<SearchDialog currentPath={filesStore.currentPath} onclose={closeSearch} />
	{/if}

	{#if showNewFolderDialog}
		<NewFolderDialog
			currentPath={filesStore.currentPath}
			oncreated={handleFolderCreated}
			onclose={closeNewFolder}
		/>
	{/if}

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
