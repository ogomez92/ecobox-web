<script lang="ts">
	import { formatDuration } from '$lib/utils/format';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		duration: number;
		currentTime: number;
		onseek: (time: number) => void;
		onclose: () => void;
	}

	let { duration, currentTime, onseek, onclose }: Props = $props();

	let inputValue = $state('');
	let inputElement: HTMLInputElement | null = $state(null);
	let error = $state<string | null>(null);

	// Parse time input (supports formats like: 1:23:45, 1:23, 123, 1h23m45s)
	function parseTimeInput(input: string): number | null {
		const trimmed = input.trim();
		if (!trimmed) return null;

		// Try HH:MM:SS or MM:SS format
		const colonParts = trimmed.split(':').map(p => parseFloat(p.trim()));
		if (colonParts.length === 3 && colonParts.every(p => !isNaN(p))) {
			return colonParts[0] * 3600 + colonParts[1] * 60 + colonParts[2];
		}
		if (colonParts.length === 2 && colonParts.every(p => !isNaN(p))) {
			return colonParts[0] * 60 + colonParts[1];
		}

		// Try h/m/s format (1h23m45s)
		const hmsMatch = trimmed.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/i);
		if (hmsMatch) {
			const hours = parseInt(hmsMatch[1] || '0', 10);
			const minutes = parseInt(hmsMatch[2] || '0', 10);
			const seconds = parseInt(hmsMatch[3] || '0', 10);
			if (!isNaN(hours) && !isNaN(minutes) && !isNaN(seconds)) {
				return hours * 3600 + minutes * 60 + seconds;
			}
		}

		// Try plain number (seconds)
		const plainSeconds = parseFloat(trimmed);
		if (!isNaN(plainSeconds)) {
			return plainSeconds;
		}

		return null;
	}

	function handleSubmit(e: Event) {
		e.preventDefault();
		const time = parseTimeInput(inputValue);

		if (time === null) {
			error = t('goto.invalid');
			return;
		}

		if (time < 0 || time > duration) {
			error = t('goto.outOfRange', { duration: formatDuration(duration) });
			return;
		}

		onseek(time);
		onclose();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape') {
			onclose();
		}
	}

	$effect(() => {
		// Focus input when dialog opens
		inputElement?.focus();
	});
</script>

<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
<div
	class="fixed inset-0 z-50 flex items-center justify-center p-4"
	role="dialog"
	aria-modal="true"
	aria-labelledby="goto-time-title"
	onkeydown={handleKeydown}
	tabindex="-1"
>
	<button
		type="button"
		class="absolute inset-0 bg-black/50"
		onclick={onclose}
		aria-label={t('common.closeDialog')}
	></button>

	<div class="relative bg-white dark:bg-gray-800 rounded-xl shadow-xl w-full max-w-sm p-6">
		<h2 id="goto-time-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">
			{t('goto.title')}
		</h2>

		<form onsubmit={handleSubmit}>
			<div class="mb-4">
				<label for="time-input" class="block text-sm text-gray-600 dark:text-gray-400 mb-2">
					{t('goto.label')}
				</label>
				<input
					bind:this={inputElement}
					id="time-input"
					type="text"
					bind:value={inputValue}
					placeholder={formatDuration(currentTime)}
					class="input w-full text-center text-xl font-mono"
					autocomplete="off"
				/>
				{#if error}
					<p class="mt-2 text-sm text-red-600 dark:text-red-400" role="alert">{error}</p>
				{/if}
			</div>

			<p class="text-sm text-gray-500 dark:text-gray-400 mb-4">
				{t('goto.duration', { time: formatDuration(duration) })}
			</p>

			<div class="flex gap-3">
				<button
					type="button"
					onclick={onclose}
					class="btn-secondary flex-1"
				>
					{t('common.cancel')}
				</button>
				<button
					type="submit"
					class="btn-primary flex-1"
				>
					{t('goto.go')}
				</button>
			</div>
		</form>
	</div>
</div>
