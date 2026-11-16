<script lang="ts">
	/**
	 * "Convert to audio" for a converted book: one modal that walks through
	 *
	 *   checking  → counting characters (and reading the provider quota)
	 *   error     → why it can't run, with a single OK (alertdialog)
	 *   confirm   → what it will cost; whole book vs. from the reading position
	 *   progress  → percentage, characters done / remaining, quota left
	 *
	 * The run itself is on the server, so closing the dialog (Close, Escape) never
	 * stops it — the store keeps following it and the layout announces the result.
	 * Only "Stop converting" stops it. Focus lands on the control the phase is
	 * about, Tab is kept inside the dialog, and the caller restores focus on close.
	 */
	import { onMount, onDestroy, tick } from 'svelte';
	import { t, i18n } from '$lib/i18n/index.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import {
		audiobookExportStore,
		audiobookErrorMessage,
		isActiveState,
		serviceName
	} from '$lib/stores/audiobookExport.svelte';
	import { exceedsQuota } from '$lib/utils/audiobookPlan';
	import type {
		AudiobookErrorCode,
		AudiobookEstimate,
		AudiobookJobStatus,
		TtsService
	} from '$lib/types';

	interface Props {
		/** Media-root-relative path of the `.BOOK` folder. */
		path: string;
		/** Its display name. */
		name: string;
		onclose: () => void;
	}

	let { path, name, onclose }: Props = $props();

	type Phase = 'checking' | 'error' | 'confirm' | 'progress';

	let phase = $state<Phase>('checking');
	let service = $state<TtsService>(settingsStore.ttsService);
	let estimate = $state<AudiobookEstimate | null>(null);
	let errorCode = $state<AudiobookErrorCode | null>(null);
	let errorDetail = $state<string | null>(null);
	let scope = $state<'whole' | 'position'>('whole');
	let starting = $state(false);
	let startError = $state('');
	/** Polite narration inside the dialog (milestones, state changes). */
	let liveMessage = $state('');
	let lastMilestone = -1;

	let dialogEl: HTMLDivElement | null = $state(null);

	const status = $derived<AudiobookJobStatus | null>(audiobookExportStore.statuses[path] ?? null);
	const nf = $derived(new Intl.NumberFormat(i18n.locale));
	const fmt = (n: number) => nf.format(Math.max(0, Math.round(n)));

	const selected = $derived(
		estimate ? (scope === 'position' && estimate.fromPosition ? estimate.fromPosition : estimate.whole) : null
	);
	const selectedOverQuota = $derived(!!selected && exceedsQuota(selected.billableChars, estimate?.quota));
	const percent = $derived(
		status && status.totalChars > 0 ? Math.min(100, Math.floor((status.doneChars / status.totalChars) * 100)) : 0
	);
	const remaining = $derived(status ? Math.max(0, status.totalChars - status.doneChars) : 0);
	const progressText = $derived(
		status
			? t('audiobook.progressValue', { percent, done: fmt(status.doneChars), total: fmt(status.totalChars) })
			: ''
	);

	function say(message: string) {
		liveMessage = '';
		setTimeout(() => (liveMessage = message), 10);
	}

	function fail(code: AudiobookErrorCode, detail: string | null = null) {
		errorCode = code;
		errorDetail = detail;
		phase = 'error';
	}

	async function load() {
		// Web Speech is the browser's own voice: the server has nothing to convert with.
		if (service === 'webspeech') return fail('clientOnly');

		const existing = await audiobookExportStore.refresh(path);
		if (existing && isActiveState(existing.state)) {
			phase = 'progress';
			return;
		}

		try {
			const params = new URLSearchParams({ path, service, rate: String(settingsStore.ttsRate) });
			const res = await fetch(`/api/books/audio/estimate?${params}`);
			const data = await res.json().catch(() => ({ error: 'unknown' }));
			if (!res.ok) return fail(data.error ?? 'unknown', data.detail ?? null);
			estimate = data as AudiobookEstimate;
		} catch {
			return fail('unreachable');
		}

		const est = estimate!;
		const wholeFits = !exceedsQuota(est.whole.billableChars, est.quota);
		const positionFits = !!est.fromPosition && !exceedsQuota(est.fromPosition.billableChars, est.quota);
		if (!wholeFits && !positionFits) return fail('quotaExceeded');
		// Default to the choice that can actually run; otherwise the whole book.
		scope = !wholeFits && positionFits ? 'position' : 'whole';
		phase = 'confirm';
	}

	async function start() {
		if (!estimate || !selected || selectedOverQuota || starting) return;
		starting = true;
		startError = '';
		try {
			const res = await fetch('/api/books/audio', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path,
					service,
					rate: settingsStore.ttsRate,
					fromPosition: scope === 'position'
				})
			});
			const data = await res.json().catch(() => ({ error: 'unknown' }));
			if (!res.ok) {
				// A quota that ran out since the estimate, a busy book, a dead key…
				startError = audiobookErrorMessage(data.error, service, data.detail);
				return;
			}
			audiobookExportStore.update(data.status as AudiobookJobStatus);
			lastMilestone = -1;
			phase = 'progress';
			say(t('audiobook.started', { name }));
		} catch {
			startError = audiobookErrorMessage('unreachable', service);
		} finally {
			starting = false;
		}
	}

	function stop() {
		void audiobookExportStore.cancel(path);
	}

	// Narrate the run: every 10%, and each change of state.
	let lastState: AudiobookJobStatus['state'] | null = null;
	$effect(() => {
		if (phase !== 'progress' || !status) return;
		const state = status.state;
		if (state !== lastState) {
			const previous = lastState;
			lastState = state;
			if (previous !== null || state !== 'running') {
				const message = stateMessage(status);
				if (message) say(message);
			}
			if (!isActiveState(state)) {
				void tick().then(() => okButton?.focus());
			}
			return;
		}
		if (state === 'running') {
			const milestone = Math.floor(percent / 10) * 10;
			if (lastMilestone < 0) lastMilestone = milestone;
			else if (milestone > lastMilestone) {
				lastMilestone = milestone;
				say(t('audiobook.milestone', { percent: milestone, remaining: fmt(remaining) }));
			}
		}
	});

	function stateMessage(s: AudiobookJobStatus): string {
		switch (s.state) {
			case 'queued':
				return t('audiobook.stateQueued');
			case 'running':
				return t('audiobook.stateRunning');
			case 'finishing':
				return t('audiobook.stateFinishing');
			case 'done':
				return t('audiobook.done', { file: fileName(s.outputPath) });
			case 'cancelled':
				return t('audiobook.cancelled');
			case 'failed':
				return audiobookErrorMessage(s.error, s.service, s.detail);
		}
	}

	function fileName(p: string | null): string {
		return p ? p.slice(p.lastIndexOf('/') + 1) : '';
	}

	// --- focus management -------------------------------------------------------

	let okButton: HTMLButtonElement | null = $state(null);
	let firstRadio: HTMLInputElement | null = $state(null);
	let startButton: HTMLButtonElement | null = $state(null);
	let progressHeading: HTMLHeadingElement | null = $state(null);

	$effect(() => {
		// Move focus whenever the phase changes to what that phase is about.
		const p = phase;
		void tick().then(() => {
			if (p === 'error') okButton?.focus();
			else if (p === 'confirm') (firstRadio ?? startButton)?.focus();
			else if (p === 'progress') {
				if (status && !isActiveState(status.state)) okButton?.focus();
				else progressHeading?.focus();
			} else dialogEl?.focus();
		});
	});

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.preventDefault();
			e.stopPropagation();
			onclose();
			return;
		}
		if (e.key === 'Tab' && dialogEl) {
			const focusable = Array.from(
				dialogEl.querySelectorAll<HTMLElement>(
					'button:not([disabled]), input:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])'
				)
			).filter((el) => el.offsetParent !== null || el === document.activeElement);
			if (focusable.length === 0) return;
			const first = focusable[0];
			const last = focusable[focusable.length - 1];
			if (e.shiftKey && (document.activeElement === first || document.activeElement === dialogEl)) {
				e.preventDefault();
				last.focus();
			} else if (!e.shiftKey && document.activeElement === last) {
				e.preventDefault();
				first.focus();
			}
		}
	}

	onMount(() => {
		audiobookExportStore.watching = path;
		void load();
	});

	onDestroy(() => {
		if (audiobookExportStore.watching === path) audiobookExportStore.watching = null;
	});

	const titleId = 'audiobook-dialog-title';
	const descId = 'audiobook-dialog-desc';
	const isAlert = $derived(phase === 'error');
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	bind:this={dialogEl}
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role={isAlert ? 'alertdialog' : 'dialog'}
	aria-modal="true"
	aria-labelledby={titleId}
	aria-describedby={descId}
	aria-busy={phase === 'checking'}
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		tabindex="-1"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6 max-h-[90vh] overflow-y-auto">
		{#if phase === 'checking'}
			<h2 id={titleId} class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
				{t('audiobook.title', { name })}
			</h2>
			<p id={descId} class="text-sm text-gray-600 dark:text-gray-400" role="status">
				{t('audiobook.checking')}
			</p>
			<div class="flex mt-4">
				<button type="button" onclick={onclose} class="btn-secondary flex-1">{t('common.cancel')}</button>
			</div>
		{:else if phase === 'error'}
			<h2 id={titleId} class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
				{t('audiobook.errorTitle')}
			</h2>
			<div id={descId} class="text-sm text-gray-700 dark:text-gray-300 space-y-2 mb-4">
				<p>{audiobookErrorMessage(errorCode, service, errorDetail)}</p>
				{#if errorCode === 'quotaExceeded' && estimate?.quota}
					<p>
						{t('audiobook.quotaDetail', {
							needed: fmt(estimate.fromPosition?.billableChars ?? estimate.whole.billableChars),
							left: fmt(estimate.quota.remaining),
							service: serviceName(service)
						})}
					</p>
				{/if}
			</div>
			<div class="flex gap-3">
				{#if errorCode === 'clientOnly' || errorCode === 'quotaExceeded' || errorCode === 'noVoice' || errorCode === 'badKey' || errorCode === 'misconfigured'}
					<a href="/settings#tts-service" class="btn-secondary flex-1 text-center">{t('audiobook.openSettings')}</a>
				{/if}
				<button bind:this={okButton} type="button" onclick={onclose} class="btn-primary flex-1">
					{t('audiobook.ok')}
				</button>
			</div>
		{:else if phase === 'confirm' && estimate && selected}
			<h2 id={titleId} class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
				{t('audiobook.title', { name })}
			</h2>
			<div id={descId} class="text-sm text-gray-600 dark:text-gray-400 space-y-2 mb-4">
				<p>
					{estimate.voiceName
						? t('audiobook.introVoice', { service: serviceName(service), voice: estimate.voiceName })
						: t('audiobook.intro', { service: serviceName(service) })}
					{#if estimate.rate !== null && estimate.rate !== 1}
						{t('audiobook.atSpeed', { rate: estimate.rate })}
					{/if}
				</p>
				<p>{t('audiobook.keepsBook', { file: selected.fileName })}</p>
			</div>

			{#if estimate.fromPosition}
				<fieldset class="mb-4">
					<legend class="text-sm font-medium text-gray-900 dark:text-gray-100 mb-2">
						{t('audiobook.scopeLegend')}
					</legend>
					<label class="flex items-start gap-2 py-1 text-sm text-gray-700 dark:text-gray-300">
						<input bind:this={firstRadio} type="radio" name="audiobook-scope" value="whole" bind:group={scope} class="mt-1" />
						<span>{t('audiobook.scopeWhole', { chars: fmt(estimate.whole.chars) })}</span>
					</label>
					<label class="flex items-start gap-2 py-1 text-sm text-gray-700 dark:text-gray-300">
						<input type="radio" name="audiobook-scope" value="position" bind:group={scope} class="mt-1" />
						<span>
							{estimate.fromPosition.chapter
								? t('audiobook.scopePositionChapter', {
										percent: estimate.fromPosition.percent,
										chapter: estimate.fromPosition.chapter,
										chars: fmt(estimate.fromPosition.chars)
									})
								: t('audiobook.scopePosition', {
										percent: estimate.fromPosition.percent,
										chars: fmt(estimate.fromPosition.chars)
									})}
						</span>
					</label>
				</fieldset>
			{/if}

			<div class="text-sm text-gray-700 dark:text-gray-300 space-y-2 mb-4" aria-live="polite">
				{#if estimate.billed}
					<p class="font-medium">
						{t('audiobook.charsBilled', { chars: fmt(selected.billableChars), service: serviceName(service) })}
					</p>
				{:else}
					<p class="font-medium">
						{t('audiobook.charsFree', { chars: fmt(selected.billableChars) })}
					</p>
				{/if}
				{#if selected.billableChars < selected.chars}
					<p>{t('audiobook.charsCached', { chars: fmt(selected.chars - selected.billableChars) })}</p>
				{/if}
				{#if estimate.quota}
					{#if selectedOverQuota}
						<p role="alert" class="text-red-600 dark:text-red-400">
							{t('audiobook.overQuotaChoice', {
								left: fmt(estimate.quota.remaining),
								service: serviceName(service)
							})}
						</p>
					{:else}
						<p>
							{t('audiobook.quotaAfter', {
								left: fmt(estimate.quota.remaining),
								after: fmt(estimate.quota.remaining - selected.billableChars),
								service: serviceName(service)
							})}
						</p>
					{/if}
				{/if}
				<p>{t('audiobook.runsInBackground')}</p>
			</div>

			{#if startError}
				<p role="alert" class="text-sm text-red-600 dark:text-red-400 mb-4">{startError}</p>
			{/if}

			<div class="flex gap-3">
				<button type="button" onclick={onclose} class="btn-secondary flex-1">{t('common.cancel')}</button>
				<button
					bind:this={startButton}
					type="button"
					onclick={start}
					disabled={selectedOverQuota || starting}
					aria-disabled={selectedOverQuota || starting}
					class="btn-primary flex-1 disabled:opacity-50"
				>
					{starting ? t('audiobook.starting') : t('audiobook.start')}
				</button>
			</div>
		{:else if phase === 'progress'}
			<h2
				bind:this={progressHeading}
				id={titleId}
				tabindex="-1"
				class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-3 outline-none"
			>
				{t('audiobook.progressTitle', { name })}
			</h2>

			{#if status}
				<div id={descId}>
					<div
						role="progressbar"
						aria-labelledby={titleId}
						aria-valuemin={0}
						aria-valuemax={100}
						aria-valuenow={percent}
						aria-valuetext={progressText}
						class="w-full h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden mb-3"
					>
						<div class="h-full bg-primary-500 transition-all" style="width: {percent}%"></div>
					</div>

					<dl class="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm text-gray-700 dark:text-gray-300 mb-3">
						<dt class="font-medium">{t('audiobook.percentLabel')}</dt>
						<dd>{percent}%</dd>
						<dt class="font-medium">{t('audiobook.doneLabel')}</dt>
						<dd>{t('audiobook.charsOf', { done: fmt(status.doneChars), total: fmt(status.totalChars) })}</dd>
						<dt class="font-medium">{t('audiobook.remainingLabel')}</dt>
						<dd>{fmt(remaining)}</dd>
						{#if status.quotaRemaining !== null}
							<dt class="font-medium">{t('audiobook.quotaLabel', { service: serviceName(status.service) })}</dt>
							<dd>{fmt(status.quotaRemaining)}</dd>
						{/if}
					</dl>

					<p class="text-sm text-gray-600 dark:text-gray-400 mb-4" class:text-red-600={status.state === 'failed'}>
						{stateMessage(status)}
					</p>
				</div>

				<div class="flex gap-3">
					{#if isActiveState(status.state)}
						<button type="button" onclick={stop} class="btn-secondary flex-1">{t('audiobook.stop')}</button>
						<button type="button" onclick={onclose} class="btn-primary flex-1">{t('audiobook.hide')}</button>
					{:else}
						<button bind:this={okButton} type="button" onclick={onclose} class="btn-primary flex-1">
							{t('audiobook.ok')}
						</button>
					{/if}
				</div>
			{:else}
				<p id={descId} class="text-sm text-gray-600 dark:text-gray-400 mb-4">{t('audiobook.lost')}</p>
				<button bind:this={okButton} type="button" onclick={onclose} class="btn-primary w-full">
					{t('audiobook.ok')}
				</button>
			{/if}
		{/if}
		<!-- Always mounted, so the first message after a phase change is heard. -->
		<div class="sr-only" aria-live="polite" aria-atomic="true">{liveMessage}</div>
	</div>
</div>
