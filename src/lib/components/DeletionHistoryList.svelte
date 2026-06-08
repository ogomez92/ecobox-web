<script lang="ts">
	import { onMount } from 'svelte';
	import Icon from './Icon.svelte';
	import { formatDate, formatDateAccessible } from '$lib/utils/format';
	import { t } from '$lib/i18n/index.svelte';

	type DeletionEntry = {
		id: number;
		path: string;
		name: string;
		isDirectory: boolean;
		source: 'user' | 'sync';
		deletedAt: string;
	};

	let deletions = $state<DeletionEntry[]>([]);
	let status = $state<'loading' | 'loaded' | 'error'>('loading');
	// Roving tabindex: exactly one item is in the tab order at a time.
	let focusedIndex = $state(0);
	let itemRefs: Array<HTMLLIElement | null> = $state([]);

	onMount(async () => {
		try {
			const res = await fetch('/api/deletions');
			if (!res.ok) throw new Error('Failed to load deletion history');
			const data = await res.json();
			deletions = data.deletions ?? [];
			status = 'loaded';
		} catch {
			status = 'error';
		}
	});

	function focusItem(idx: number) {
		const clamped = Math.max(0, Math.min(deletions.length - 1, idx));
		focusedIndex = clamped;
		itemRefs[clamped]?.focus();
	}

	function handleListKeydown(e: KeyboardEvent) {
		if (deletions.length === 0) return;
		switch (e.key) {
			case 'ArrowDown':
				e.preventDefault();
				focusItem(focusedIndex + 1);
				break;
			case 'ArrowUp':
				e.preventDefault();
				focusItem(focusedIndex - 1);
				break;
			case 'Home':
				e.preventDefault();
				focusItem(0);
				break;
			case 'End':
				e.preventDefault();
				focusItem(deletions.length - 1);
				break;
		}
	}

	// One coherent label per row; the visible columns are hidden from assistive
	// tech so the option announces as a single line.
	function deletionAria(entry: DeletionEntry): string {
		const date = formatDateAccessible(entry.deletedAt);
		const key = entry.isDirectory ? 'settings.deletionAriaFolder' : 'settings.deletionAriaFile';
		const base = t(key, { name: entry.name, date });
		return entry.source === 'sync' ? `${base}, ${t('settings.deletionViaSync')}` : base;
	}
</script>

{#if status === 'loading'}
	<p class="text-sm text-gray-500 dark:text-gray-400" role="status">{t('settings.deletionHistoryLoading')}</p>
{:else if status === 'error'}
	<p class="text-sm text-red-600 dark:text-red-400" role="alert">{t('settings.deletionHistoryError')}</p>
{:else if deletions.length === 0}
	<p class="text-sm text-gray-500 dark:text-gray-400">{t('settings.deletionHistoryEmpty')}</p>
{:else}
	<p id="deletion-history-hint" class="sr-only">{t('settings.deletionHistoryHint')}</p>
	<ul
		class="divide-y divide-gray-100 dark:divide-gray-700 max-h-96 overflow-y-auto"
		role="listbox"
		aria-label={t('settings.deletionHistoryListLabel')}
		aria-describedby="deletion-history-hint"
		onkeydown={handleListKeydown}
	>
		{#each deletions as entry, index (entry.id)}
			<li
				bind:this={itemRefs[index]}
				role="option"
				aria-selected={focusedIndex === index}
				aria-label={deletionAria(entry)}
				tabindex={focusedIndex === index ? 0 : -1}
				onfocus={() => { focusedIndex = index; }}
				class="flex items-start gap-3 py-2 px-1 rounded-lg cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-primary-500"
			>
				<span class="mt-0.5 shrink-0 text-gray-400 dark:text-gray-500" aria-hidden="true">
					<Icon name={entry.isDirectory ? 'folder' : 'file'} size={18} />
				</span>
				<div class="min-w-0 flex-1" aria-hidden="true">
					<div class="flex items-center gap-2">
						<p class="truncate text-sm text-gray-800 dark:text-gray-200">{entry.name}</p>
						{#if entry.source === 'sync'}
							<span class="shrink-0 rounded-full bg-gray-100 dark:bg-gray-700 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-gray-500 dark:text-gray-400">
								{t('settings.deletionViaSync')}
							</span>
						{/if}
					</div>
					<p class="truncate text-xs text-gray-500 dark:text-gray-400">{entry.path}</p>
				</div>
				<p class="shrink-0 whitespace-nowrap text-xs text-gray-500 dark:text-gray-400" aria-hidden="true">
					{formatDate(entry.deletedAt)}
				</p>
			</li>
		{/each}
	</ul>
{/if}
