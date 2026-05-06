<script lang="ts">
	import { formatDuration, formatDurationAccessible } from '$lib/utils/format';
	import { t } from '$lib/i18n/index.svelte';

	interface Props {
		currentTime: number;
		duration: number;
		onseek: (time: number) => void;
	}

	let { currentTime, duration, onseek }: Props = $props();

	let isDragging = $state(false);
	let sliderElement: HTMLDivElement | null = $state(null);

	const progress = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);

	function getTimeFromEvent(e: MouseEvent | TouchEvent): number {
		if (!sliderElement || duration <= 0) return 0;

		const rect = sliderElement.getBoundingClientRect();
		const clientX = 'touches' in e ? e.touches[0].clientX : e.clientX;
		const percent = Math.max(0, Math.min(100, ((clientX - rect.left) / rect.width) * 100));
		return (percent / 100) * duration;
	}

	function handleMouseDown(e: MouseEvent) {
		isDragging = true;
		onseek(getTimeFromEvent(e));
		window.addEventListener('mousemove', handleMouseMove);
		window.addEventListener('mouseup', handleMouseUp);
	}

	function handleMouseMove(e: MouseEvent) {
		if (isDragging) {
			onseek(getTimeFromEvent(e));
		}
	}

	function handleMouseUp() {
		isDragging = false;
		window.removeEventListener('mousemove', handleMouseMove);
		window.removeEventListener('mouseup', handleMouseUp);
	}

	function handleTouchStart(e: TouchEvent) {
		isDragging = true;
		onseek(getTimeFromEvent(e));
	}

	function handleTouchMove(e: TouchEvent) {
		if (isDragging) {
			onseek(getTimeFromEvent(e));
		}
	}

	function handleTouchEnd() {
		isDragging = false;
	}

	function handleKeyDown(e: KeyboardEvent) {
		const step = e.shiftKey ? 30 : 5;
		if (e.key === 'ArrowLeft') {
			onseek(Math.max(0, currentTime - step));
			e.preventDefault();
		} else if (e.key === 'ArrowRight') {
			onseek(Math.min(duration, currentTime + step));
			e.preventDefault();
		} else if (e.key === 'Home') {
			onseek(0);
			e.preventDefault();
		} else if (e.key === 'End') {
			onseek(duration);
			e.preventDefault();
		}
	}
</script>

<div class="space-y-2">
	<div
		bind:this={sliderElement}
		class="relative h-10 flex items-center cursor-pointer touch-manipulation"
		role="slider"
		tabindex="0"
		aria-label={t('seekbar.aria')}
		aria-valuemin={0}
		aria-valuemax={Math.round(duration)}
		aria-valuenow={Math.round(currentTime)}
		aria-valuetext={t('seekbar.valueText', { current: formatDurationAccessible(currentTime), total: formatDurationAccessible(duration) })}
		onmousedown={handleMouseDown}
		ontouchstart={handleTouchStart}
		ontouchmove={handleTouchMove}
		ontouchend={handleTouchEnd}
		onkeydown={handleKeyDown}
	>
		<div class="absolute inset-x-0 h-2 bg-gray-200 dark:bg-gray-700 rounded-full">
			<div
				class="h-full bg-primary-500 rounded-full transition-all"
				class:transition-none={isDragging}
				style="width: {progress}%"
			></div>
		</div>
		<div
			class="absolute w-5 h-5 bg-white dark:bg-gray-200 rounded-full shadow-md border-2 border-primary-500 transition-all"
			class:transition-none={isDragging}
			class:scale-125={isDragging}
			style="left: calc({progress}% - 10px)"
		></div>
	</div>

	<div class="flex justify-between text-sm text-gray-600 dark:text-gray-400" aria-hidden="true">
		<span>{formatDuration(currentTime)}</span>
		<span>-{formatDuration(duration - currentTime)}</span>
	</div>
</div>
