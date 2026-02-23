<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { goto } from '$app/navigation';

	const seekIntervalOptions = [1, 2, 3, 5, 10, 15, 30];
	const longSeekIntervalOptions = [10, 15, 30, 45, 60, 90, 120];
</script>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900">
	<header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 sticky top-0 z-10">
		<div class="max-w-2xl mx-auto flex items-center gap-4">
			<button
				type="button"
				onclick={() => goto('/')}
				class="btn-ghost p-2"
				aria-label="Go back"
			>
				<Icon name="chevron-down" size={24} />
			</button>
			<h1 class="text-xl font-bold text-gray-900 dark:text-gray-100">Settings</h1>
		</div>
	</header>

	<main class="max-w-2xl mx-auto p-4 pb-8">
		<!-- Playback Settings -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Playback</h2>

			<div class="space-y-4">
				<div class="flex items-center justify-between py-2">
					<div>
						<span id="autoplay-label" class="text-gray-700 dark:text-gray-300">Autoplay</span>
						<p id="autoplay-desc" class="text-sm text-gray-500 dark:text-gray-400">Start playing automatically when opening a file</p>
					</div>
					<button
						type="button"
						onclick={() => settingsStore.setAutoplay(!settingsStore.autoplay)}
						class="relative w-12 h-6 rounded-full transition-colors"
						class:bg-primary-500={settingsStore.autoplay}
						class:bg-gray-300={!settingsStore.autoplay}
						class:dark:bg-gray-600={!settingsStore.autoplay}
						role="switch"
						aria-checked={settingsStore.autoplay}
						aria-labelledby="autoplay-label"
						aria-describedby="autoplay-desc"
					>
						<span
							class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
							class:translate-x-0.5={!settingsStore.autoplay}
							class:translate-x-6={settingsStore.autoplay}
						></span>
					</button>
				</div>

				<div>
					<label for="seek-interval" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
						Seek Interval (seconds)
					</label>
					<select
						id="seek-interval"
						value={settingsStore.seekInterval}
						onchange={(e) => settingsStore.setSeekInterval(parseInt((e.target as HTMLSelectElement).value, 10))}
						aria-describedby="seek-interval-desc"
						class="input"
					>
						{#each seekIntervalOptions as option}
							<option value={option}>{option}s</option>
						{/each}
					</select>
					<p id="seek-interval-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
						Used for skip buttons and arrow key shortcuts
					</p>
				</div>

				<div>
					<label for="long-seek-interval" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
						Long Seek Interval (seconds)
					</label>
					<select
						id="long-seek-interval"
						value={settingsStore.longSeekInterval}
						onchange={(e) => settingsStore.setLongSeekInterval(parseInt((e.target as HTMLSelectElement).value, 10))}
						aria-describedby="long-seek-interval-desc"
						class="input"
					>
						{#each longSeekIntervalOptions as option}
							<option value={option}>{option}s</option>
						{/each}
					</select>
					<p id="long-seek-interval-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
						Used for outer skip buttons
					</p>
				</div>
			</div>
		</section>

		<!-- Bookmarks -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Bookmarks</h2>

			<div class="flex items-center justify-between py-2">
				<div>
					<span id="bookmark-pause-label" class="text-gray-700 dark:text-gray-300">Create bookmark on pause</span>
					<p id="bookmark-pause-desc" class="text-sm text-gray-500 dark:text-gray-400">Add a named bookmark each time you pause (separate from saved position)</p>
				</div>
				<button
					type="button"
					onclick={() => settingsStore.setCreateBookmarkOnPause(!settingsStore.createBookmarkOnPause)}
					class="relative w-12 h-6 rounded-full transition-colors"
					class:bg-primary-500={settingsStore.createBookmarkOnPause}
					class:bg-gray-300={!settingsStore.createBookmarkOnPause}
					class:dark:bg-gray-600={!settingsStore.createBookmarkOnPause}
					role="switch"
					aria-checked={settingsStore.createBookmarkOnPause}
					aria-labelledby="bookmark-pause-label"
					aria-describedby="bookmark-pause-desc"
				>
					<span
						class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
						class:translate-x-0.5={!settingsStore.createBookmarkOnPause}
						class:translate-x-6={settingsStore.createBookmarkOnPause}
					></span>
				</button>
			</div>
		</section>

		<!-- Appearance -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Appearance</h2>

			<fieldset>
				<legend class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
					Theme
				</legend>
				<div class="space-y-2">
					{#each [
						{ value: 'system', label: 'System' },
						{ value: 'light', label: 'Light' },
						{ value: 'dark', label: 'Dark' }
					] as option}
						<label class="flex items-center gap-3 py-2 cursor-pointer">
							<input
								type="radio"
								name="theme"
								value={option.value}
								checked={settingsStore.theme === option.value}
								tabindex={settingsStore.theme === option.value ? 0 : -1}
								onchange={() => settingsStore.setTheme(option.value as 'light' | 'dark' | 'system')}
								class="w-4 h-4 text-primary-600"
							/>
							<span class="text-gray-700 dark:text-gray-300">{option.label}</span>
						</label>
					{/each}
				</div>
			</fieldset>

			<div class="mt-4">
				<label for="mask-title" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
					Mask Title
				</label>
				<input
					id="mask-title"
					type="text"
					value={settingsStore.maskTitle}
					oninput={(e) => settingsStore.setMaskTitle((e.target as HTMLInputElement).value)}
					placeholder="Leave empty to show &quot;Ecobox&quot;"
					aria-describedby="mask-title-desc"
					class="input"
				/>
				<p id="mask-title-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
					Replace the browser tab title with custom text to hide what you're listening to
				</p>
			</div>
		</section>

		<!-- Keyboard Shortcuts -->
		<section class="card p-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">Keyboard Shortcuts</h2>

			<div class="space-y-2 text-sm">
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Play/Pause</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">Space</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Seek backward/forward</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">←</kbd>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300 ml-1">→</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Change seek unit</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">↑</kbd>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300 ml-1">↓</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Jump to time</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">J</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Volume up/down</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">I</kbd>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300 ml-1">K</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Mute toggle</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">M</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Add bookmark</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">B</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Seek to percentage</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">1</kbd>
						<span class="text-gray-400 mx-1">-</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">9</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">Seek to end</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">0</kbd>
				</div>
			</div>
		</section>
	</main>
</div>
