<script lang="ts">
	/**
	 * The Recent tab's list of recently opened media.
	 *
	 * A WAI-ARIA listbox with a roving tabindex — only the active option is
	 * tabbable, so Tab treats the whole list as one stop and Up/Down/Home/End move
	 * within it (the same model as the search results and the bookmark list).
	 *
	 * Every entry is openable, including entries whose file has since been deleted:
	 * the server resolves each one to the nearest surviving ancestor folder, and
	 * such rows are marked "no longer available" both visually and in their
	 * accessible name, followed by where they will open instead.
	 */
	import Icon from './Icon.svelte';
	import { goto } from '$app/navigation';
	import { t } from '$lib/i18n/index.svelte';
	import { formatRelativeTime } from '$lib/utils/format';
	import { recentStore } from '$lib/stores/recent.svelte';
	import type { RecentEntry, RecentKind } from '$lib/types';

	let listElement: HTMLUListElement | null = $state(null);

	const entries = $derived(recentStore.entries);

	// The roving tabindex, kept in range by construction: the list is re-fetched on
	// every tab activation and can come back shorter, and an out-of-range index
	// would leave no option tabbable at all — i.e. a list Tab can't reach.
	let cursor = $state(0);
	const activeIndex = $derived(Math.min(cursor, Math.max(0, entries.length - 1)));

	function iconFor(kind: RecentKind): 'folder' | 'book' | 'radio' | 'audio' {
		if (kind === 'book' || kind === 'daisy' || kind === 'rawbook') return 'book';
		if (kind === 'chaptered' || kind === 'folder') return 'folder';
		if (kind === 'radio') return 'radio';
		return 'audio';
	}

	function kindLabel(entry: RecentEntry): string {
		switch (entry.kind) {
			case 'book':
				return t('fileTypes.book');
			case 'daisy':
				return t('fileTypes.daisyBook');
			case 'chaptered':
				return t('fileTypes.chapteredFolder');
			case 'rawbook':
				return t('fileTypes.rawBook');
			case 'radio':
				return t('radio.label');
			case 'folder':
				return t('fileTypes.folder');
			default: {
				const parts = entry.name.split('.');
				return t('fileTypes.fileExt', {
					ext: parts.length > 1 ? parts.pop()!.toUpperCase() : 'Audio'
				});
			}
		}
	}

	/** Folder the entry lived in, or the home label for a top-level entry. */
	function folderOf(path: string): string {
		const parent = path.split('/').filter(Boolean).slice(0, -1).join('/');
		return parent || t('breadcrumbs.home');
	}

	/** Where a missing entry will open instead. */
	function fallbackLabel(entry: RecentEntry): string {
		return entry.target.path
			? t('recent.opensInstead', { folder: entry.target.name })
			: t('recent.opensHome');
	}

	function optionLabel(entry: RecentEntry): string {
		const parts = [
			entry.name,
			kindLabel(entry),
			t('recent.inFolder', { folder: folderOf(entry.path) }),
			formatRelativeTime(entry.accessedAt)
		];
		if (!entry.exists) {
			parts.push(t('recent.missing'), fallbackLabel(entry));
		}
		return parts.filter(Boolean).join(', ');
	}

	function open(entry: RecentEntry) {
		goto(entry.target.href);
	}

	function focusOption(i: number) {
		listElement?.querySelectorAll<HTMLElement>('[role="option"]')[i]?.focus();
	}

	function moveActive(i: number) {
		if (entries.length === 0) return;
		cursor = Math.max(0, Math.min(i, entries.length - 1));
		focusOption(cursor);
		listElement
			?.querySelectorAll<HTMLElement>('[role="option"]')
			[cursor]?.scrollIntoView({ block: 'nearest' });
	}

	function onOptionKeydown(e: KeyboardEvent, index: number) {
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				moveActive(index + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				moveActive(index - 1);
				break;
			case 'Home':
				e.preventDefault();
				moveActive(0);
				break;
			case 'End':
				e.preventDefault();
				moveActive(entries.length - 1);
				break;
			case 'Enter':
			case ' ':
				e.preventDefault();
				open(entries[index]);
				break;
		}
	}

	/** Focus the list from outside (Ctrl+L). */
	export function focusList() {
		if (entries.length === 0) return false;
		moveActive(activeIndex);
		return true;
	}
</script>

<div class="max-w-4xl mx-auto px-4 py-2">
	<div class="sr-only" role="status" aria-live="polite">
		{#if recentStore.isLoading}
			{t('recent.loading')}
		{:else if recentStore.error}
			{t('recent.error')}
		{:else if recentStore.loaded}
			{entries.length === 0 ? t('recent.empty') : t('recent.count', { n: entries.length })}
		{/if}
	</div>

	{#if recentStore.isLoading && entries.length === 0}
		<div class="flex items-center justify-center py-12">
			<div class="animate-spin rounded-full h-8 w-8 border-b-2 border-primary-500"></div>
			<span class="sr-only">{t('recent.loading')}</span>
		</div>
	{:else if recentStore.error}
		<div class="text-center py-12" role="alert">
			<Icon name="x" size={48} class="mx-auto text-red-500 mb-4" />
			<p class="text-gray-600 dark:text-gray-400">{t('recent.error')}</p>
			<button type="button" onclick={() => recentStore.load()} class="btn-secondary mt-4">
				{t('common.tryAgain')}
			</button>
		</div>
	{:else if entries.length === 0}
		<div class="text-center py-12">
			<Icon name="clock" size={48} class="mx-auto text-gray-400 mb-4" />
			<p class="text-gray-600 dark:text-gray-400">{t('recent.empty')}</p>
			<p class="text-sm text-gray-500 dark:text-gray-500 mt-1">{t('recent.emptyHint')}</p>
		</div>
	{:else}
		<p id="recent-list-hint" class="sr-only">{t('recent.hint')}</p>
		<ul
			bind:this={listElement}
			role="listbox"
			aria-label={t('recent.listLabel')}
			aria-describedby="recent-list-hint"
			class="divide-y divide-gray-100 dark:divide-gray-700"
		>
			{#each entries as entry, i (entry.path)}
				<li
					role="option"
					aria-selected={i === activeIndex}
					aria-label={optionLabel(entry)}
					tabindex={i === activeIndex ? 0 : -1}
					onclick={() => open(entry)}
					onkeydown={(e) => onOptionKeydown(e, i)}
					onfocus={() => (cursor = i)}
					class="flex items-center gap-3 px-2 py-3 rounded-lg cursor-pointer hover:bg-gray-50 dark:hover:bg-gray-750 focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
				>
					<div
						class="flex-shrink-0 w-10 h-10 rounded-lg flex items-center justify-center"
						class:bg-gray-100={entry.exists}
						class:dark:bg-gray-700={entry.exists}
						class:bg-amber-100={!entry.exists}
						class:dark:bg-amber-900={!entry.exists}
					>
						<Icon
							name={iconFor(entry.kind)}
							size={20}
							class={entry.exists
								? 'text-gray-600 dark:text-gray-400'
								: 'text-amber-700 dark:text-amber-300'}
						/>
					</div>
					<span class="min-w-0 flex-1">
						<span
							class="block text-sm font-medium truncate"
							class:text-gray-900={entry.exists}
							class:dark:text-gray-100={entry.exists}
							class:text-gray-500={!entry.exists}
							class:dark:text-gray-400={!entry.exists}
							class:line-through={!entry.exists}
						>
							{entry.name}
						</span>
						<span class="block text-xs text-gray-500 dark:text-gray-400 truncate">
							{#if entry.exists}
								{folderOf(entry.path)}
							{:else}
								{t('recent.missing')} — {fallbackLabel(entry)}
							{/if}
						</span>
					</span>
					<span class="flex-shrink-0 text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
						{formatRelativeTime(entry.accessedAt)}
					</span>
				</li>
			{/each}
		</ul>
	{/if}
</div>
