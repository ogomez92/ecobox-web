<script lang="ts">
	import { untrack } from 'svelte';
	import { t } from '$lib/i18n/index.svelte';
	import type { BookInfo } from '$lib/types';

	interface Props {
		bookPath: string;
		info: BookInfo;
		onclose: () => void;
		onsaved: (info: BookInfo) => void;
	}

	let { bookPath, info, onclose, onsaved }: Props = $props();

	// Seed the edit field from the initial language; later prop updates (after a
	// save) must not clobber what the user is typing, so capture it untracked.
	let localeInput = $state(untrack(() => info.locale));
	let saving = $state(false);
	let saveError = $state('');
	let saved = $state(false);
	let inputElement: HTMLInputElement | null = $state(null);

	const dirty = $derived(localeInput.trim() !== info.locale && localeInput.trim().length > 0);

	// The book facts render as a roving-tabindex listbox of read-only rows (mirroring
	// FindInBook) so keyboard/screen-reader users can arrow through each stat. Only
	// the active row is tabbable; Up/Down step, Home/End jump to the first/last.
	let listElement: HTMLUListElement | null = $state(null);
	let activeIndex = $state(0);

	const facts = $derived([
		{ label: t('reader.infoTitle'), value: info.title || '—' },
		{ label: t('reader.infoWords'), value: info.mdWords.toLocaleString() },
		{ label: t('reader.infoCharacters'), value: info.mdChars.toLocaleString() },
		{ label: t('reader.infoChapters'), value: info.chapters.toLocaleString() },
		{ label: t('reader.infoSentences'), value: info.totalChunks.toLocaleString() },
		{ label: t('reader.infoVerified'), value: info.verified ? t('reader.infoYes') : t('reader.infoNo') },
		{ label: t('reader.infoConverted'), value: formatDate(info.convertedAt) }
	]);

	function focusOption(i: number) {
		listElement?.querySelectorAll<HTMLElement>('[role="option"]')[i]?.focus();
	}

	// Move the roving focus, clamped to the list bounds.
	function moveActive(i: number) {
		activeIndex = Math.max(0, Math.min(i, facts.length - 1));
		focusOption(activeIndex);
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
				moveActive(facts.length - 1);
				break;
		}
	}

	function sourceLabel(): string {
		switch (info.localeSource) {
			case 'detected':
				return t('reader.infoLangDetected');
			case 'default':
				return t('reader.infoLangDefault');
			case 'manual':
				return t('reader.infoLangManual');
			default:
				return t('reader.infoLangUnknown');
		}
	}

	function formatDate(iso: string): string {
		if (!iso) return '—';
		const d = new Date(iso);
		return isNaN(d.getTime()) ? iso : d.toLocaleDateString();
	}

	async function save() {
		const locale = localeInput.trim();
		if (!locale || saving) return;
		saving = true;
		saveError = '';
		saved = false;
		try {
			const res = await fetch('/api/books/info', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: bookPath, locale })
			});
			if (!res.ok) throw new Error(String(res.status));
			const updated = (await res.json()) as BookInfo;
			saved = true;
			onsaved(updated);
		} catch {
			saveError = t('reader.infoSaveError');
		} finally {
			saving = false;
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		}
	}

	$effect(() => {
		// Land focus on the facts list when the dialog opens (e.g. via Ctrl+I) so it's
		// immediately arrow-navigable; the language editor is a Tab away.
		if (listElement) untrack(() => focusOption(0));
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="bookinfo-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div
		class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6 max-h-[85vh] overflow-y-auto"
	>
		<h2 id="bookinfo-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
			{t('reader.bookInfo')}
		</h2>

		<ul
			bind:this={listElement}
			role="listbox"
			aria-label={t('reader.bookInfo')}
			aria-readonly="true"
			class="space-y-1 text-sm"
		>
			{#each facts as fact, i (fact.label)}
				<li
					role="option"
					aria-selected={i === activeIndex}
					aria-label={`${fact.label}: ${fact.value}`}
					tabindex={i === activeIndex ? 0 : -1}
					onkeydown={(e) => onOptionKeydown(e, i)}
					class="flex justify-between gap-4 p-2 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 dark:focus:ring-blue-400 aria-selected:bg-gray-100 dark:aria-selected:bg-gray-700"
				>
					<span class="text-gray-500 dark:text-gray-400">{fact.label}</span>
					<span class="text-right font-medium text-gray-900 dark:text-gray-100 break-words">{fact.value}</span>
				</li>
			{/each}
		</ul>

		<!-- Editable language -->
		<div class="mt-5 pt-4 border-t border-gray-200 dark:border-gray-700">
			<label for="bookinfo-lang" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
				{t('reader.infoLanguage')}
			</label>
			<div class="flex gap-2">
				<input
					bind:this={inputElement}
					id="bookinfo-lang"
					type="text"
					bind:value={localeInput}
					class="input flex-1"
					autocomplete="off"
					spellcheck="false"
					aria-describedby="bookinfo-lang-help"
					placeholder="en"
				/>
				<button type="button" class="btn-primary" onclick={save} disabled={!dirty || saving}>
					{saving ? t('reader.infoSaving') : t('reader.infoSave')}
				</button>
			</div>
			<p id="bookinfo-lang-help" class="mt-1 text-xs text-gray-500 dark:text-gray-400">
				{sourceLabel()} · {t('reader.infoLangHelp')}
			</p>
			<div class="sr-only" role="status" aria-live="polite">
				{#if saved}{t('reader.infoSaved')}{/if}
			</div>
			{#if saved}
				<p class="mt-1 text-xs text-green-600 dark:text-green-400">{t('reader.infoSaved')}</p>
			{/if}
			{#if saveError}
				<p class="mt-1 text-xs text-red-600 dark:text-red-400" role="alert">{saveError}</p>
			{/if}
		</div>

		<div class="mt-5 flex justify-end">
			<button type="button" class="btn-secondary" onclick={onclose}>{t('common.close')}</button>
		</div>
	</div>
</div>
