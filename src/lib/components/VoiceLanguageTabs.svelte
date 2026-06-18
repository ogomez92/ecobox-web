<script lang="ts">
	/**
	 * Accessible voice picker that groups voices by language. Voices are bucketed
	 * by their BCP-47 primary subtag into a WAI-ARIA tablist (one tab per language);
	 * voices with no/unknown language fall into an "Other languages" tab. The active
	 * tab's voices are shown in a labelled <select>. Selecting a voice calls
	 * `onSelect`; switching tabs only filters the list (it never changes the voice).
	 *
	 * Used by Settings for both the device (Web Speech) and server-synthesized
	 * voice lists — any provider whose voices carry a language.
	 */
	import { t, i18n } from '$lib/i18n/index.svelte';

	interface VoiceOption {
		id: string;
		name: string;
		/** BCP-47 where known, '' otherwise. */
		lang: string;
	}

	let {
		voices,
		selectedId,
		onSelect,
		idPrefix,
		selectLabel
	}: {
		voices: VoiceOption[];
		selectedId: string | null;
		onSelect: (id: string) => void;
		/** Unique prefix so multiple instances don't collide on element ids. */
		idPrefix: string;
		/** Accessible label for the per-language voice <select>. */
		selectLabel: string;
	} = $props();

	/** BCP-47 primary subtag (lowercased), or '' for empty/unknown. */
	function primary(lang: string): string {
		return (lang || '').trim() ? lang.split('-')[0].toLowerCase() : '';
	}

	// Localized language-name resolver for the current app locale.
	const displayNames = $derived.by(() => {
		try {
			return new Intl.DisplayNames([i18n.locale], { type: 'language' });
		} catch {
			return null;
		}
	});

	function langLabel(key: string): string {
		if (key === '') return t('settings.ttsLangOther');
		try {
			return displayNames?.of(key) || key.toUpperCase();
		} catch {
			return key.toUpperCase();
		}
	}

	// Group voices by language key, preserving each provider's voice order.
	const groups = $derived.by(() => {
		const map = new Map<string, VoiceOption[]>();
		for (const v of voices) {
			const key = primary(v.lang);
			const list = map.get(key);
			if (list) list.push(v);
			else map.set(key, [v]);
		}
		return map;
	});

	// Named languages first (alphabetical by localized name), "Other" last.
	const orderedKeys = $derived.by(() => {
		const keys = [...groups.keys()];
		const named = keys
			.filter((k) => k !== '')
			.sort((a, b) => langLabel(a).localeCompare(langLabel(b), i18n.locale));
		return keys.includes('') ? [...named, ''] : named;
	});

	// The user's explicit tab choice; falls back to the selected voice's language,
	// then to the first tab. Kept as a derived so there's no effect write-loop.
	let userKey = $state<string | null>(null);
	const activeKey = $derived.by(() => {
		const keys = orderedKeys;
		if (keys.length === 0) return '';
		if (userKey !== null && keys.includes(userKey)) return userKey;
		const sel = voices.find((v) => v.id === selectedId);
		const selKey = sel ? primary(sel.lang) : null;
		return selKey !== null && keys.includes(selKey) ? selKey : keys[0];
	});

	const activeVoices = $derived(groups.get(activeKey) ?? []);

	function tabId(key: string): string {
		return `${idPrefix}-tab-${key || 'other'}`;
	}
	const panelId = $derived(`${idPrefix}-panel`);

	// Roving-tabindex keyboard model for the tablist.
	let tabEls = $state<Record<string, HTMLButtonElement | null>>({});

	function focusTab(key: string) {
		userKey = key;
		tabEls[key]?.focus();
	}

	function onTabKeydown(e: KeyboardEvent, key: string) {
		const keys = orderedKeys;
		const i = keys.indexOf(key);
		if (i < 0) return;
		let next = -1;
		switch (e.key) {
			case 'ArrowRight':
			case 'ArrowDown':
				next = (i + 1) % keys.length;
				break;
			case 'ArrowLeft':
			case 'ArrowUp':
				next = (i - 1 + keys.length) % keys.length;
				break;
			case 'Home':
				next = 0;
				break;
			case 'End':
				next = keys.length - 1;
				break;
			default:
				return;
		}
		e.preventDefault();
		focusTab(keys[next]);
	}

	function onVoiceChange(e: Event) {
		onSelect((e.target as HTMLSelectElement).value);
	}
</script>

<div class="space-y-2">
	<div role="tablist" aria-label={t('settings.ttsLangTabsLabel')} class="flex flex-wrap gap-1">
		{#each orderedKeys as key (key)}
			<button
				type="button"
				role="tab"
				id={tabId(key)}
				bind:this={tabEls[key]}
				aria-selected={key === activeKey}
				aria-controls={panelId}
				tabindex={key === activeKey ? 0 : -1}
				onclick={() => (userKey = key)}
				onkeydown={(e) => onTabKeydown(e, key)}
				class="px-3 py-1.5 text-sm rounded-md border transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500"
				class:bg-primary-500={key === activeKey}
				class:text-white={key === activeKey}
				class:border-primary-500={key === activeKey}
				class:bg-gray-100={key !== activeKey}
				class:dark:bg-gray-700={key !== activeKey}
				class:text-gray-700={key !== activeKey}
				class:dark:text-gray-300={key !== activeKey}
				class:border-gray-300={key !== activeKey}
				class:dark:border-gray-600={key !== activeKey}
			>
				{langLabel(key)}
			</button>
		{/each}
	</div>

	<div role="tabpanel" id={panelId} aria-labelledby={tabId(activeKey)} tabindex="0">
		<select
			value={selectedId}
			onchange={onVoiceChange}
			aria-label={selectLabel}
			class="input"
		>
			{#each activeVoices as v (v.id)}
				<option value={v.id}>{v.name}</option>
			{/each}
		</select>
	</div>
</div>
