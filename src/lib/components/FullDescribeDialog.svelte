<script lang="ts">
	/**
	 * Confirms describing the whole video before the server starts on it.
	 *
	 * A whole film is hundreds of model calls that run for a good while and cost
	 * real API credit, so it never starts on a single keypress: the dialog says how
	 * big the job is (chunks, frames, running time), or how much of a paused run is
	 * left, and waits for a Start. Focus lands on that button — it is the one
	 * reason the dialog is open — and the caller restores focus when it closes.
	 */
	import { t } from '$lib/i18n/index.svelte';
	import { formatDuration } from '$lib/utils/format';
	import { FULL_DESCRIBE_CHUNK_SECONDS, type FullDescribeEstimate } from '$lib/types';

	interface Props {
		/** Length of the video in seconds (0 when not yet known). */
		duration: number;
		/** A paused or failed run to pick up, when there is one. */
		doneChunks: number;
		totalChunks: number;
		/** The cost estimate: undefined while it is being fetched, null when unavailable. */
		estimate: FullDescribeEstimate | null | undefined;
		onstart: () => void;
		onclose: () => void;
	}

	let { duration, doneChunks, totalChunks, estimate, onstart, onclose }: Props = $props();

	/** `1.2M` / `840k` / `312` — tokens are only ever read as an order of magnitude. */
	function compact(n: number): string {
		if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
		if (n >= 10_000) return `${Math.round(n / 1000)}k`;
		if (n >= 1_000) return `${(n / 1000).toFixed(1)}k`;
		return String(Math.round(n));
	}

	const resuming = $derived(totalChunks > 0 && doneChunks > 0 && doneChunks < totalChunks);

	/** For a resumed run, only the chunks left are still to pay for. */
	const share = $derived(
		resuming && totalChunks > 0 ? (totalChunks - doneChunks) / totalChunks : 1
	);
	const estimateText = $derived.by(() => {
		if (estimate === undefined) return t('describeAll.estimating');
		if (estimate === null) return t('describeAll.estimateUnavailable');
		const input = compact(estimate.inputTokens * share);
		const output = compact(estimate.outputTokens * share);
		if (estimate.usd === null) {
			return t('describeAll.estimateTokens', { input, output, model: estimate.model });
		}
		const usd = estimate.usd * share;
		const amount = usd < 0.1 ? usd.toFixed(3) : usd < 10 ? usd.toFixed(2) : usd.toFixed(1);
		return t('describeAll.estimate', { usd: amount, input, output, model: estimate.model });
	});

	let startButton: HTMLButtonElement | null = $state(null);
	const chunks = $derived(
		totalChunks > 0 ? totalChunks : Math.max(1, Math.ceil(duration / FULL_DESCRIBE_CHUNK_SECONDS))
	);
	const frames = $derived(Math.max(1, Math.ceil(duration)));

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			e.stopPropagation();
			onclose();
		}
	}

	$effect(() => {
		startButton?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="full-describe-title"
	aria-describedby="full-describe-intro"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-md p-6">
		<h2 id="full-describe-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-2">
			{t('describeAll.title')}
		</h2>

		<div id="full-describe-intro" class="text-sm text-gray-600 dark:text-gray-400 mb-4 space-y-2">
			<p>
				{resuming
					? t('describeAll.resumeIntro', { done: doneChunks, total: totalChunks })
					: t('describeAll.intro', {
							duration: formatDuration(duration),
							chunks,
							seconds: FULL_DESCRIBE_CHUNK_SECONDS,
							frames
						})}
			</p>
			<p>{t('describeAll.howItPlays')}</p>
			<p aria-live="polite">{estimateText}</p>
			<p>{t('describeAll.balanceNote')}</p>
		</div>

		<div class="flex gap-3">
			<button type="button" onclick={onclose} class="btn-secondary flex-1">
				{t('common.cancel')}
			</button>
			<button bind:this={startButton} type="button" onclick={onstart} class="btn-primary flex-1">
				{resuming ? t('describeAll.resume') : t('describeAll.start')}
			</button>
		</div>
	</div>
</div>
