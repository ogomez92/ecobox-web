<script lang="ts">
	import Icon from '$lib/components/Icon.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { i18n, t, SUPPORTED_LOCALES, LOCALE_NAMES, type LocaleCode } from '$lib/i18n/index.svelte';
	import { goto } from '$app/navigation';

	const seekIntervalOptions = [1, 2, 3, 5, 10, 15, 30];
	const longSeekIntervalOptions = [10, 15, 30, 45, 60, 90, 120];

	// 'system' means: don't pin a locale; use browser detection.
	const languageValue = $derived<'system' | LocaleCode>(
		i18n.isExplicit ? i18n.locale : 'system'
	);

	function setLanguage(value: 'system' | LocaleCode) {
		if (value === 'system') {
			i18n.setLocale(null);
		} else {
			i18n.setLocale(value);
		}
	}
</script>

<div class="min-h-screen bg-gray-50 dark:bg-gray-900">
	<header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 sticky top-0 z-10">
		<div class="max-w-2xl mx-auto flex items-center gap-4">
			<button
				type="button"
				onclick={() => goto('/')}
				class="btn-ghost p-2"
				aria-label={t('common.goBack')}
			>
				<Icon name="chevron-down" size={24} />
			</button>
			<h1 class="text-xl font-bold text-gray-900 dark:text-gray-100">{t('settings.title')}</h1>
		</div>
	</header>

	<main class="max-w-2xl mx-auto p-4 pb-8">
		<!-- Playback Settings -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.playback')}</h2>

			<div class="space-y-4">
				<div class="flex items-center justify-between py-2">
					<div>
						<span id="autoplay-label" class="text-gray-700 dark:text-gray-300">{t('settings.autoplay')}</span>
						<p id="autoplay-desc" class="text-sm text-gray-500 dark:text-gray-400">{t('settings.autoplayDesc')}</p>
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
						{t('settings.seekInterval')}
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
						{t('settings.seekIntervalDesc')}
					</p>
				</div>

				<div>
					<label for="long-seek-interval" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
						{t('settings.longSeekInterval')}
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
						{t('settings.longSeekIntervalDesc')}
					</p>
				</div>
			</div>
		</section>

		<!-- Bookmarks -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.bookmarks')}</h2>

			<div class="flex items-center justify-between py-2">
				<div>
					<span id="bookmark-pause-label" class="text-gray-700 dark:text-gray-300">{t('settings.bookmarkOnPause')}</span>
					<p id="bookmark-pause-desc" class="text-sm text-gray-500 dark:text-gray-400">{t('settings.bookmarkOnPauseDesc')}</p>
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
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.appearance')}</h2>

			<fieldset>
				<legend class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
					{t('settings.theme')}
				</legend>
				<div class="space-y-2">
					{#each [
						{ value: 'system', label: t('settings.themeSystem') },
						{ value: 'light', label: t('settings.themeLight') },
						{ value: 'dark', label: t('settings.themeDark') }
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
					{t('settings.maskTitle')}
				</label>
				<input
					id="mask-title"
					type="text"
					value={settingsStore.maskTitle}
					oninput={(e) => settingsStore.setMaskTitle((e.target as HTMLInputElement).value)}
					placeholder={t('settings.maskTitlePlaceholder')}
					aria-describedby="mask-title-desc"
					class="input"
				/>
				<p id="mask-title-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
					{t('settings.maskTitleDesc')}
				</p>
			</div>
		</section>

		<!-- Language -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.language')}</h2>

			<fieldset>
				<legend class="sr-only">{t('settings.language')}</legend>
				<p id="language-desc" class="text-sm text-gray-500 dark:text-gray-400 mb-3">{t('settings.languageDesc')}</p>
				<div class="space-y-2" aria-describedby="language-desc">
					<label class="flex items-center gap-3 py-2 cursor-pointer">
						<input
							type="radio"
							name="language"
							value="system"
							checked={languageValue === 'system'}
							tabindex={languageValue === 'system' ? 0 : -1}
							onchange={() => setLanguage('system')}
							class="w-4 h-4 text-primary-600"
						/>
						<span class="text-gray-700 dark:text-gray-300">{t('settings.langSystem')}</span>
					</label>
					{#each SUPPORTED_LOCALES as code}
						<label class="flex items-center gap-3 py-2 cursor-pointer">
							<input
								type="radio"
								name="language"
								value={code}
								checked={languageValue === code}
								tabindex={languageValue === code ? 0 : -1}
								onchange={() => setLanguage(code)}
								class="w-4 h-4 text-primary-600"
							/>
							<span class="text-gray-700 dark:text-gray-300">{LOCALE_NAMES[code]}</span>
						</label>
					{/each}
				</div>
			</fieldset>
		</section>

		<!-- Keyboard Shortcuts -->
		<section class="card p-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.shortcuts')}</h2>

			<div class="space-y-2 text-sm">
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbPlayPause')}</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">Space</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbSeek')}</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">←</kbd>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300 ml-1">→</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbSeekUnit')}</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">↑</kbd>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300 ml-1">↓</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbJumpToTime')}</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">J</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbVolume')}</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">I</kbd>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300 ml-1">K</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbMute')}</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">M</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbBookmark')}</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">B</kbd>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbSeekPercent')}</span>
					<span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">1</kbd>
						<span class="text-gray-400 mx-1">-</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">9</kbd>
					</span>
				</div>
				<div class="flex justify-between py-1">
					<span class="text-gray-600 dark:text-gray-400">{t('settings.kbSeekEnd')}</span>
					<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">0</kbd>
				</div>
			</div>
		</section>
	</main>
</div>
