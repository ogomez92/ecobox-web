<script lang="ts">
	import { onMount, onDestroy, tick } from 'svelte';
	import Icon from '$lib/components/Icon.svelte';
	import DeletionHistoryList from '$lib/components/DeletionHistoryList.svelte';
	import VoiceLanguageTabs from '$lib/components/VoiceLanguageTabs.svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { ttsConfigStore } from '$lib/stores/ttsConfig.svelte';
	import { speakPreview, stopPreview } from '$lib/services/tts/preview';
	import { i18n, t, SUPPORTED_LOCALES, LOCALE_NAMES, type LocaleCode } from '$lib/i18n/index.svelte';
	import { formatBytes } from '$lib/utils/format';
	import {
		ELEVEN_MODELS,
		ELEVEN_LANG_CODE_MODELS,
		type TtsService,
		type TtsAudioService,
		type TtsVoice,
		type ElfVoiceParams
	} from '$lib/types';
	import { goto, afterNavigate } from '$app/navigation';

	const seekIntervalOptions = [1, 2, 3, 5, 10, 15, 30];
	const longSeekIntervalOptions = [10, 15, 30, 45, 60, 90, 120];

	// Move focus to the back button on open so focus isn't stranded on whatever
	// triggered the navigation (e.g. the Ctrl+, shortcut or the header gear).
	// Exception: when arriving from the reader's "Change voice" button
	// (/settings#tts-service), focus the provider selector instead.
	let backButtonRef: HTMLButtonElement | null = $state(null);
	onMount(() => {
		tick().then(() => {
			if (typeof window !== 'undefined' && window.location.hash === '#tts-service') {
				const svc = document.getElementById('tts-service');
				if (svc) {
					svc.scrollIntoView({ block: 'center' });
					svc.focus();
					return;
				}
			}
			backButtonRef?.focus();
		});
	});

	// Where leaving settings goes. Settings is opened from several places (the file
	// browser header / Ctrl+comma, the reader's "Change voice" button), and landing
	// back on the home screen from the middle of a book is disorienting — so record
	// the page we came from and return there. `afterNavigate` gives us that only for
	// a client-side navigation; a direct load or refresh of /settings has no `from`,
	// and falls back to home.
	let returnTo = $state('/');
	let capturedReturn = false;
	afterNavigate((nav) => {
		if (capturedReturn) return;
		capturedReturn = true;
		const from = nav.from?.url;
		if (from && from.pathname !== '/settings') {
			returnTo = from.pathname + from.search;
		}
	});

	/** Leave settings the same way the header back button does. */
	function goBack() {
		goto(returnTo);
	}

	// Escape returns to wherever settings was opened from, so users don't have to
	// reach for the back link. It fires from anywhere on the page *including* form
	// controls: settings is almost entirely selects, sliders and text fields, so a
	// field guard (as the file browser uses) made Escape look broken — it did
	// nothing for the great majority of focus positions, and in particular right
	// after arriving from the reader, which lands focus on the provider <select>.
	// Native Escape handling inside an open <select> popup happens before the event
	// reaches the window, so that still works.
	function handleWindowKeydown(e: KeyboardEvent) {
		if (e.key !== 'Escape' || e.defaultPrevented) return;
		e.preventDefault();
		goBack();
	}

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

	// Reading (TTS): rate is a global setting; voice is device-local (localStorage),
	// because the Web Speech voice list differs per browser/device.
	const TTS_VOICE_KEY = 'ecobox-tts-voice';
	let ttsVoices = $state<SpeechSynthesisVoice[]>([]);
	let ttsVoiceURI = $state<string | null>(null);

	onMount(() => {
		settingsStore.load();
		if (typeof window === 'undefined' || !('speechSynthesis' in window)) return;
		const synth = window.speechSynthesis;
		const load = () => {
			ttsVoices = synth.getVoices();
			try {
				const saved = localStorage.getItem(TTS_VOICE_KEY);
				if (saved) ttsVoiceURI = saved;
			} catch {
				// ignore
			}
			if (!ttsVoiceURI && ttsVoices.length > 0) {
				ttsVoiceURI = (ttsVoices.find((v) => v.default) ?? ttsVoices[0]).voiceURI;
			}
		};
		load();
		synth.addEventListener('voiceschanged', load);
		return () => synth.removeEventListener('voiceschanged', load);
	});

	function setTtsVoice(uri: string) {
		ttsVoiceURI = uri;
		try {
			localStorage.setItem(TTS_VOICE_KEY, uri);
		} catch {
			// ignore
		}
	}

	// --- Voices & AI services (server-synthesized providers) ---
	let ttsServiceVoices = $state<TtsVoice[]>([]);
	let voicesLoading = $state(false);
	let apiKeyInput = $state('');
	let testing = $state(false);
	let testResult = $state<{ ok: boolean; message: string } | null>(null);
	let cacheBytes = $state(0);
	let clearingCache = $state(false);
	let cleaningDb = $state(false);
	let dbCleanupTotal = $state<number | null>(null);
	let dbCleanupAnnouncement = $state('');

	// --- Piper (local neural engine): user-imported voice models ---
	let piperModels = $state<
		{ stem: string; label: string; lang: string; speakers: number; bytes: number }[]
	>([]);
	let importingVoice = $state(false);
	let importError = $state('');
	let importAnnouncement = $state('');

	const audioService = $derived(
		settingsStore.ttsService !== 'webspeech' ? (settingsStore.ttsService as TtsAudioService) : null
	);
	const currentTtsConfig = $derived(audioService ? ttsConfigStore.get(audioService) : null);

	// Normalized voice lists for the language-tab picker ({ id, name, lang }).
	const webSpeechVoiceOptions = $derived(
		ttsVoices.map((v) => ({ id: v.voiceURI, name: `${v.name} (${v.lang})`, lang: v.lang }))
	);
	const serviceVoiceOptions = $derived(
		ttsServiceVoices.map((v) => ({ id: v.id, name: v.name, lang: v.lang }))
	);

	// ELF (local engine) voice-parameter sliders — each 0..100, overriding the
	// selected voice preset's built-in knob when "Customize voice" is on.
	const elfParamFields = [
		{ key: 'headSize', label: 'settings.ttsElfHeadSize' },
		{ key: 'pitch', label: 'settings.ttsElfPitch' },
		{ key: 'inflection', label: 'settings.ttsElfInflection' },
		{ key: 'roughness', label: 'settings.ttsElfRoughness' },
		{ key: 'breathiness', label: 'settings.ttsElfBreathiness' },
		{ key: 'volume', label: 'settings.ttsElfVolume' }
	] as const;

	function setElfParam(key: keyof ElfVoiceParams, value: number) {
		const patch: Partial<ElfVoiceParams> = {};
		patch[key] = value;
		ttsConfigStore.setElfParams('elf', patch);
	}

	// Voice preview ("Test voice"): speak a fixed sample at the chosen voice + the
	// global speed. Server-synthesized services play through this hidden <audio>.
	let previewAudioEl = $state<HTMLAudioElement | null>(null);

	function previewDeviceVoice() {
		if (!ttsVoiceURI) return;
		speakPreview({
			service: 'webspeech',
			voiceId: ttsVoiceURI,
			rate: settingsStore.ttsRate,
			lang: i18n.locale,
			sampleText: t('reader.voicePreviewSample')
		});
	}

	function previewServiceVoice() {
		if (!audioService || !currentTtsConfig?.voiceId) return;
		speakPreview({
			service: audioService,
			voiceId: currentTtsConfig.voiceId,
			rate: settingsStore.ttsRate,
			lang: i18n.locale,
			sampleText: t('reader.voicePreviewSample'),
			audioEl: previewAudioEl
		});
	}

	onDestroy(() => stopPreview());

	onMount(() => {
		ttsConfigStore.load();
		loadCacheSize();
		if (settingsStore.ttsService !== 'webspeech') {
			loadServiceVoices(settingsStore.ttsService as TtsAudioService);
		}
		if (settingsStore.ttsService === 'piper') loadPiperModels();
	});

	async function loadCacheSize() {
		try {
			const res = await fetch('/api/tts/cache');
			if (res.ok) cacheBytes = (await res.json()).bytes ?? 0;
		} catch {
			// ignore
		}
	}

	async function loadServiceVoices(service: TtsAudioService) {
		voicesLoading = true;
		ttsServiceVoices = [];
		try {
			const res = await fetch(`/api/tts/voices?service=${encodeURIComponent(service)}`);
			if (res.ok) ttsServiceVoices = await res.json();
		} catch {
			// ignore
		}
		voicesLoading = false;
	}

	function onTtsServiceChange(value: TtsService) {
		settingsStore.setTtsService(value);
		testResult = null;
		apiKeyInput = '';
		importError = '';
		ttsServiceVoices = [];
		if (value !== 'webspeech') loadServiceVoices(value as TtsAudioService);
		if (value === 'piper') loadPiperModels();
	}

	async function loadPiperModels() {
		try {
			const res = await fetch('/api/tts/piper/voices');
			if (res.ok) piperModels = await res.json();
		} catch {
			// ignore — list stays as-is
		}
	}

	/** Upload a Piper voice (the .onnx model + its .onnx.json config, picked together). */
	async function importPiperVoices(fileList: FileList | null) {
		importError = '';
		if (!fileList || fileList.length === 0) return;
		const files = Array.from(fileList);
		const hasOnnx = files.some((f) => f.name.endsWith('.onnx'));
		const hasJson = files.some((f) => f.name.endsWith('.json'));
		if (!hasOnnx || !hasJson) {
			importError = t('settings.ttsPiperImportNeedBoth');
			return;
		}
		const form = new FormData();
		for (const f of files) form.append('files', f);
		importingVoice = true;
		importAnnouncement = t('settings.ttsPiperImporting');
		try {
			const res = await fetch('/api/tts/piper/voices', { method: 'POST', body: form });
			const data = await res.json().catch(() => ({}));
			if (res.ok) {
				importAnnouncement = t('settings.ttsPiperImported');
				await loadPiperModels();
				loadServiceVoices('piper');
			} else {
				importError = data?.error || t('settings.ttsPiperImportError');
				importAnnouncement = importError;
			}
		} catch {
			importError = t('settings.ttsPiperImportError');
			importAnnouncement = importError;
		}
		importingVoice = false;
	}

	async function removePiperVoice(stem: string) {
		try {
			const res = await fetch(`/api/tts/piper/voices?stem=${encodeURIComponent(stem)}`, {
				method: 'DELETE'
			});
			if (res.ok) {
				await loadPiperModels();
				loadServiceVoices('piper');
			}
		} catch {
			// ignore
		}
	}

	function saveApiKey() {
		if (!audioService || !apiKeyInput.trim()) return;
		ttsConfigStore.setApiKey(audioService, apiKeyInput.trim());
		apiKeyInput = '';
		// Voices need a valid key — reload shortly after the save round-trips.
		const svc = audioService;
		setTimeout(() => loadServiceVoices(svc), 300);
	}

	function removeApiKey() {
		if (!audioService) return;
		ttsConfigStore.removeKey(audioService);
		ttsServiceVoices = [];
		testResult = null;
	}

	async function testTtsService() {
		if (!audioService) return;
		const svc = audioService;
		testing = true;
		testResult = null;
		try {
			const res = await fetch('/api/tts/validate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ service: svc })
			});
			testResult = await res.json();
			if (testResult?.ok) loadServiceVoices(svc);
		} catch {
			testResult = { ok: false, message: 'error' };
		}
		testing = false;
	}

	async function clearTtsCache() {
		clearingCache = true;
		try {
			const res = await fetch('/api/tts/cache', { method: 'DELETE' });
			if (res.ok) cacheBytes = (await res.json()).bytes ?? 0;
		} catch {
			// ignore
		}
		clearingCache = false;
	}

	async function cleanupDatabase() {
		cleaningDb = true;
		dbCleanupTotal = null;
		// Announce each step through the live region (in-progress → result).
		dbCleanupAnnouncement = t('settings.dbCleanupRunning');
		try {
			const res = await fetch('/api/db/cleanup', { method: 'POST' });
			if (res.ok) {
				const total: number = (await res.json()).total ?? 0;
				dbCleanupTotal = total;
				dbCleanupAnnouncement =
					total === 0
						? t('settings.dbCleanupNone')
						: t('settings.dbCleanupResult', { n: total });
			} else {
				dbCleanupAnnouncement = t('settings.dbCleanupError');
			}
		} catch {
			dbCleanupAnnouncement = t('settings.dbCleanupError');
		}
		cleaningDb = false;
	}
</script>

<svelte:window onkeydown={handleWindowKeydown} />

<div class="min-h-screen bg-gray-50 dark:bg-gray-900">
	<!-- Shared sink for server-synthesized voice previews (Test voice). -->
	<audio bind:this={previewAudioEl} preload="auto" class="hidden"></audio>

	<header class="bg-white dark:bg-gray-800 border-b border-gray-200 dark:border-gray-700 px-4 py-3 sticky top-0 z-10">
		<div class="max-w-2xl mx-auto flex items-center gap-4">
			<button
				bind:this={backButtonRef}
				type="button"
				onclick={goBack}
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
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.playback')}</legend>

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

				<div class="flex items-center justify-between py-2">
					<div>
						<span id="winamp-shortcuts-label" class="text-gray-700 dark:text-gray-300">{t('settings.winampShortcuts')}</span>
						<p id="winamp-shortcuts-desc" class="text-sm text-gray-500 dark:text-gray-400">{t('settings.winampShortcutsDesc')}</p>
					</div>
					<button
						type="button"
						onclick={() => settingsStore.setWinampShortcuts(!settingsStore.winampShortcuts)}
						class="relative w-12 h-6 rounded-full transition-colors"
						class:bg-primary-500={settingsStore.winampShortcuts}
						class:bg-gray-300={!settingsStore.winampShortcuts}
						class:dark:bg-gray-600={!settingsStore.winampShortcuts}
						role="switch"
						aria-checked={settingsStore.winampShortcuts}
						aria-labelledby="winamp-shortcuts-label"
						aria-describedby="winamp-shortcuts-desc"
					>
						<span
							class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
							class:translate-x-0.5={!settingsStore.winampShortcuts}
							class:translate-x-6={settingsStore.winampShortcuts}
						></span>
					</button>
				</div>

				<div class="flex items-center justify-between py-2">
					<div>
						<span id="auto-advance-label" class="text-gray-700 dark:text-gray-300">{t('settings.autoAdvance')}</span>
						<p id="auto-advance-desc" class="text-sm text-gray-500 dark:text-gray-400">{t('settings.autoAdvanceDesc')}</p>
					</div>
					<button
						type="button"
						onclick={() => settingsStore.setAutoAdvanceTracks(!settingsStore.autoAdvanceTracks)}
						class="relative w-12 h-6 rounded-full transition-colors"
						class:bg-primary-500={settingsStore.autoAdvanceTracks}
						class:bg-gray-300={!settingsStore.autoAdvanceTracks}
						class:dark:bg-gray-600={!settingsStore.autoAdvanceTracks}
						role="switch"
						aria-checked={settingsStore.autoAdvanceTracks}
						aria-labelledby="auto-advance-label"
						aria-describedby="auto-advance-desc"
					>
						<span
							class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
							class:translate-x-0.5={!settingsStore.autoAdvanceTracks}
							class:translate-x-6={settingsStore.autoAdvanceTracks}
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
		</fieldset>

		<!-- Bookmarks -->
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.bookmarks')}</legend>

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
		</fieldset>

		<!-- Appearance -->
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.appearance')}</legend>

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
		</fieldset>

		<!-- Casting -->
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.casting')}</legend>

			<div>
				<label for="sonicroom-url" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
					{t('settings.sonicroomUrl')}
				</label>
				<input
					id="sonicroom-url"
					type="url"
					inputmode="url"
					value={settingsStore.sonicroomUrl}
					oninput={(e) => settingsStore.setSonicroomUrl((e.target as HTMLInputElement).value)}
					placeholder={t('settings.sonicroomUrlPlaceholder')}
					aria-describedby="sonicroom-url-desc"
					class="input"
				/>
				<p id="sonicroom-url-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
					{t('settings.sonicroomUrlDesc')}
				</p>
			</div>
		</fieldset>

		<!-- Reading (text-to-speech) -->
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.reading')}</legend>

			<div class="space-y-4">
				<div>
					<label for="tts-rate" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
						{t('settings.ttsRate')}: {settingsStore.ttsRate.toFixed(1)}x
					</label>
					<input
						id="tts-rate"
						type="range"
						min="0.5"
						max="5"
						step="0.1"
						value={settingsStore.ttsRate}
						oninput={(e) => settingsStore.setTtsRate(parseFloat((e.target as HTMLInputElement).value))}
						aria-describedby="tts-rate-desc"
						aria-valuetext={`${settingsStore.ttsRate.toFixed(1)}x`}
						class="w-full"
					/>
					<p id="tts-rate-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
						{t('settings.ttsRateDesc')}
					</p>
				</div>

			</div>
		</fieldset>

		<!-- Voices & AI services -->
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.ttsServices')}</legend>

			<div class="space-y-4">
				<div>
					<label for="tts-service" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
						{t('settings.ttsService')}
					</label>
					<select
						id="tts-service"
						value={settingsStore.ttsService}
						onchange={(e) => onTtsServiceChange((e.target as HTMLSelectElement).value as TtsService)}
						aria-describedby="tts-service-desc"
						class="input"
					>
						<option value="webspeech">{t('settings.ttsSvcWebSpeech')}</option>
						<option value="elevenlabs">{t('settings.ttsSvcElevenLabs')}</option>
						<option value="azure">{t('settings.ttsSvcAzure')}</option>
						<option value="azure-edge">{t('settings.ttsSvcAzureEdge')}</option>
						<option value="google">{t('settings.ttsSvcGoogle')}</option>
						<option value="elf">{t('settings.ttsSvcElf')}</option>
						<option value="piper">{t('settings.ttsSvcPiper')}</option>
					</select>
					<p id="tts-service-desc" class="mt-1 text-sm text-gray-500 dark:text-gray-400">
						{t('settings.ttsServiceDesc')}
					</p>
				</div>

				{#if audioService}
					{#if audioService === 'azure-edge'}
						<p class="text-sm text-amber-600 dark:text-amber-400">{t('settings.ttsEdgeNote')}</p>
					{:else if audioService === 'elf'}
						<p class="text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsElfNote')}</p>
					{:else if audioService === 'piper'}
						<p class="text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsPiperNote')}</p>
					{:else}
						<div>
							<label for="tts-api-key" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsApiKey')}
							</label>
							<div class="flex gap-2">
								<input
									id="tts-api-key"
									type="password"
									autocomplete="off"
									bind:value={apiKeyInput}
									placeholder={currentTtsConfig?.configured ? t('settings.ttsKeySaved') : ''}
									class="input flex-1"
								/>
								<button type="button" class="btn-secondary" onclick={saveApiKey} disabled={!apiKeyInput.trim()}>
									{t('common.save')}
								</button>
							</div>
							{#if currentTtsConfig?.configured}
								<button
									type="button"
									class="mt-2 text-sm text-red-600 dark:text-red-400 hover:underline"
									onclick={removeApiKey}
								>
									{t('settings.ttsRemoveKey')}
								</button>
							{/if}
						</div>
					{/if}

					{#if audioService === 'elevenlabs'}
						<div>
							<label for="tts-model" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsModel')}
							</label>
							<select
								id="tts-model"
								value={currentTtsConfig?.model || 'eleven_multilingual_v2'}
								onchange={(e) => ttsConfigStore.setModel('elevenlabs', (e.target as HTMLSelectElement).value)}
								class="input"
							>
								{#each ELEVEN_MODELS as m}
									<option value={m}>{m}</option>
								{/each}
							</select>
							{#if !ELEVEN_LANG_CODE_MODELS.includes(currentTtsConfig?.model || 'eleven_multilingual_v2')}
								<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
									{t('settings.ttsLangCodeHint')}
								</p>
							{/if}
						</div>

						<!-- ElevenLabs voice_settings: stability / similarity / style / speaker boost -->
						<div>
							<label for="tts-stability" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsStability')}: {(currentTtsConfig?.voiceSettings.stability ?? 0.5).toFixed(2)}
							</label>
							<input
								id="tts-stability"
								type="range"
								min="0"
								max="1"
								step="0.05"
								value={currentTtsConfig?.voiceSettings.stability ?? 0.5}
								oninput={(e) =>
									ttsConfigStore.setVoiceSettings('elevenlabs', {
										stability: parseFloat((e.target as HTMLInputElement).value)
									})}
								class="w-full"
							/>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsStabilityDesc')}</p>
						</div>

						<div>
							<label for="tts-similarity" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsSimilarity')}: {(currentTtsConfig?.voiceSettings.similarityBoost ?? 0.75).toFixed(2)}
							</label>
							<input
								id="tts-similarity"
								type="range"
								min="0"
								max="1"
								step="0.05"
								value={currentTtsConfig?.voiceSettings.similarityBoost ?? 0.75}
								oninput={(e) =>
									ttsConfigStore.setVoiceSettings('elevenlabs', {
										similarityBoost: parseFloat((e.target as HTMLInputElement).value)
									})}
								class="w-full"
							/>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsSimilarityDesc')}</p>
						</div>

						<div>
							<label for="tts-style" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsStyle')}: {(currentTtsConfig?.voiceSettings.style ?? 0).toFixed(2)}
							</label>
							<input
								id="tts-style"
								type="range"
								min="0"
								max="1"
								step="0.05"
								value={currentTtsConfig?.voiceSettings.style ?? 0}
								oninput={(e) =>
									ttsConfigStore.setVoiceSettings('elevenlabs', {
										style: parseFloat((e.target as HTMLInputElement).value)
									})}
								class="w-full"
							/>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsStyleDesc')}</p>
						</div>

						<div class="flex items-center justify-between py-2">
							<div>
								<span id="tts-speaker-boost-label" class="text-gray-700 dark:text-gray-300">
									{t('settings.ttsSpeakerBoost')}
								</span>
								<p id="tts-speaker-boost-desc" class="text-sm text-gray-500 dark:text-gray-400">
									{t('settings.ttsSpeakerBoostDesc')}
								</p>
							</div>
							<button
								type="button"
								onclick={() =>
									ttsConfigStore.setVoiceSettings('elevenlabs', {
										useSpeakerBoost: !(currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true)
									})}
								class="relative w-12 h-6 rounded-full transition-colors shrink-0"
								class:bg-primary-500={currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true}
								class:bg-gray-300={!(currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true)}
								class:dark:bg-gray-600={!(currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true)}
								role="switch"
								aria-checked={currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true}
								aria-labelledby="tts-speaker-boost-label"
								aria-describedby="tts-speaker-boost-desc"
							>
								<span
									class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
									class:translate-x-0.5={!(currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true)}
									class:translate-x-6={currentTtsConfig?.voiceSettings.useSpeakerBoost ?? true}
								></span>
							</button>
						</div>
					{/if}

					{#if audioService === 'elf'}
						<!-- ELF voice parameters: a customize switch + per-knob sliders. -->
						<div class="flex items-center justify-between py-2">
							<div>
								<span id="tts-elf-customize-label" class="text-gray-700 dark:text-gray-300">
									{t('settings.ttsElfCustomize')}
								</span>
								<p id="tts-elf-customize-desc" class="text-sm text-gray-500 dark:text-gray-400">
									{t('settings.ttsElfCustomizeDesc')}
								</p>
							</div>
							<button
								type="button"
								onclick={() => ttsConfigStore.setElfCustomize('elf', !currentTtsConfig?.elfCustomize)}
								class="relative w-12 h-6 rounded-full transition-colors shrink-0"
								class:bg-primary-500={currentTtsConfig?.elfCustomize}
								class:bg-gray-300={!currentTtsConfig?.elfCustomize}
								class:dark:bg-gray-600={!currentTtsConfig?.elfCustomize}
								role="switch"
								aria-checked={currentTtsConfig?.elfCustomize ?? false}
								aria-labelledby="tts-elf-customize-label"
								aria-describedby="tts-elf-customize-desc"
							>
								<span
									class="absolute top-0.5 w-5 h-5 bg-white rounded-full shadow transition-transform"
									class:translate-x-0.5={!currentTtsConfig?.elfCustomize}
									class:translate-x-6={currentTtsConfig?.elfCustomize}
								></span>
							</button>
						</div>

						{#if currentTtsConfig?.elfCustomize}
							{#each elfParamFields as field (field.key)}
								<div>
									<label
										for={`tts-elf-${field.key}`}
										class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2"
									>
										{t(field.label)}: {currentTtsConfig?.elfParams[field.key] ?? 0}
									</label>
									<input
										id={`tts-elf-${field.key}`}
										type="range"
										min="0"
										max="100"
										step="1"
										value={currentTtsConfig?.elfParams[field.key] ?? 0}
										oninput={(e) =>
											setElfParam(field.key, parseInt((e.target as HTMLInputElement).value, 10))}
										aria-valuetext={`${currentTtsConfig?.elfParams[field.key] ?? 0}`}
										class="w-full"
									/>
								</div>
							{/each}
						{/if}
					{/if}

					{#if audioService === 'piper'}
						<!-- Piper voice management: import a model/config pair, list & remove imports. -->
						<div>
							<p class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsVoice')}
							</p>
							<label
								class="btn-secondary inline-flex items-center gap-2 cursor-pointer"
								class:opacity-50={importingVoice}
							>
								<Icon name="upload" size={16} />
								{importingVoice ? t('settings.ttsPiperImporting') : t('settings.ttsPiperImport')}
								<input
									type="file"
									multiple
									accept=".onnx,.json,application/json,application/octet-stream"
									class="sr-only"
									disabled={importingVoice}
									onchange={(e) => {
										const el = e.currentTarget as HTMLInputElement;
										importPiperVoices(el.files).finally(() => (el.value = ''));
									}}
								/>
							</label>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsPiperImportHint')}</p>
							{#if importError}
								<p class="mt-1 text-sm text-red-600 dark:text-red-400">{importError}</p>
							{/if}
							<p class="sr-only" role="status" aria-live="polite">{importAnnouncement}</p>

							{#if piperModels.length > 0}
								<ul class="mt-3 space-y-2">
									{#each piperModels as m (m.stem)}
										<li class="flex items-center justify-between gap-2 text-sm">
											<span class="min-w-0 text-gray-700 dark:text-gray-300">
												<span class="truncate">{m.label}</span>
												<span class="text-gray-500 dark:text-gray-400">
													({m.lang || '—'}{m.speakers > 1 ? `, ${m.speakers} voices` : ''}, {formatBytes(m.bytes)})
												</span>
											</span>
											<button
												type="button"
												class="shrink-0 text-red-600 dark:text-red-400 hover:underline inline-flex items-center gap-1"
												onclick={() => removePiperVoice(m.stem)}
												aria-label={`${t('settings.ttsPiperDelete')}: ${m.label}`}
											>
												<Icon name="trash" size={14} />
												{t('settings.ttsPiperDelete')}
											</button>
										</li>
									{/each}
								</ul>
							{:else}
								<p class="mt-2 text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsPiperNoVoices')}</p>
							{/if}
						</div>
					{/if}

					{#if audioService === 'azure'}
						<div>
							<label for="tts-region" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsRegion')}
							</label>
							<input
								id="tts-region"
								type="text"
								value={currentTtsConfig?.region || ''}
								oninput={(e) => ttsConfigStore.setRegion('azure', (e.target as HTMLInputElement).value)}
								placeholder={t('settings.ttsRegionPlaceholder')}
								class="input"
							/>
						</div>
					{/if}

					<div>
						<p class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
							{t('settings.ttsVoice')}
						</p>
						{#if voicesLoading}
							<p class="text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsLoadingVoices')}</p>
						{:else if serviceVoiceOptions.length > 0}
							<VoiceLanguageTabs
								voices={serviceVoiceOptions}
								selectedId={currentTtsConfig?.voiceId ?? null}
								onSelect={(id) => {
									if (audioService) ttsConfigStore.setVoiceId(audioService, id);
								}}
								idPrefix="tts-svc-voice"
								selectLabel={t('settings.ttsVoice')}
							/>
							<button
								type="button"
								class="btn-secondary mt-2 flex items-center gap-2"
								onclick={previewServiceVoice}
								disabled={!currentTtsConfig?.voiceId}
							>
								<Icon name="play" size={16} />
								{t('reader.testVoice')}
							</button>
						{:else}
							<p class="text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsNoVoices')}</p>
						{/if}
					</div>

					<div>
						<button type="button" class="btn-secondary" onclick={testTtsService} disabled={testing}>
							{testing ? t('settings.ttsTesting') : t('settings.ttsTest')}
						</button>
						{#if testResult}
							<p
								class="mt-2 text-sm"
								class:text-green-600={testResult.ok}
								class:text-red-600={!testResult.ok}
								role="status"
								aria-live="polite"
							>
								{testResult.ok ? t('settings.ttsTestOk') : t('settings.ttsTestFailed', { error: testResult.message })}
							</p>
						{/if}
					</div>
				{:else}
					<!-- Web Speech (device): the voice list is device-local, so it's chosen here. -->
					{#if webSpeechVoiceOptions.length > 0}
						<div>
							<p class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
								{t('settings.ttsVoice')}
							</p>
							<VoiceLanguageTabs
								voices={webSpeechVoiceOptions}
								selectedId={ttsVoiceURI}
								onSelect={(id) => setTtsVoice(id)}
								idPrefix="tts-device-voice"
								selectLabel={t('settings.ttsVoice')}
							/>
							<button
								type="button"
								class="btn-secondary mt-2 flex items-center gap-2"
								onclick={previewDeviceVoice}
							>
								<Icon name="play" size={16} />
								{t('reader.testVoice')}
							</button>
							<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">
								{t('settings.ttsVoiceDesc')}
							</p>
						</div>
					{/if}
				{/if}

				<!-- Audio cache (disk) -->
				<div class="pt-2 border-t border-gray-200 dark:border-gray-700">
					<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.ttsCache')}</h3>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('settings.ttsCacheDesc')}</p>
					<p class="mt-2 text-sm text-gray-700 dark:text-gray-300" aria-live="polite">
						{t('settings.ttsCacheSize', { size: formatBytes(cacheBytes) })}
					</p>
					<button
						type="button"
						class="btn-secondary mt-2"
						onclick={clearTtsCache}
						disabled={clearingCache || cacheBytes === 0}
					>
						{clearingCache ? t('settings.ttsCacheClearing') : t('settings.ttsClearCache')}
					</button>
				</div>

				<!-- Database cleanup (orphaned records for deleted media) -->
				<div class="pt-2 border-t border-gray-200 dark:border-gray-700">
					<h3 class="text-sm font-medium text-gray-700 dark:text-gray-300">{t('settings.dbCleanup')}</h3>
					<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">{t('settings.dbCleanupDesc')}</p>
					{#if dbCleanupTotal !== null}
						<p class="mt-2 text-sm text-gray-700 dark:text-gray-300">
							{dbCleanupTotal === 0
								? t('settings.dbCleanupNone')
								: t('settings.dbCleanupResult', { n: dbCleanupTotal })}
						</p>
					{/if}
					<button
						type="button"
						class="btn-secondary mt-2"
						onclick={cleanupDatabase}
						disabled={cleaningDb}
						aria-busy={cleaningDb}
					>
						{cleaningDb ? t('settings.dbCleanupRunning') : t('settings.dbCleanupBtn')}
					</button>
					<!-- Persistent live region: announces in-progress → result/error as the text swaps. -->
					<div class="sr-only" role="status" aria-live="polite" aria-atomic="true">
						{dbCleanupAnnouncement}
					</div>
				</div>
			</div>
		</fieldset>

		<!-- Language -->
		<fieldset class="card p-4 mb-4 min-w-0">
			<legend class="block text-lg font-semibold text-gray-900 dark:text-gray-100 mb-4">{t('settings.language')}</legend>

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

		<!-- Deletion History -->
		<section class="card p-4 mb-4">
			<h2 class="text-lg font-semibold text-gray-900 dark:text-gray-100 mb-1">{t('settings.deletionHistory')}</h2>
			<p class="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('settings.deletionHistoryDesc')}</p>

			<DeletionHistoryList />
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

				{#if settingsStore.winampShortcuts}
					<p class="pt-3 mt-2 border-t border-gray-200 dark:border-gray-700 text-xs font-medium text-gray-500 dark:text-gray-400">
						{t('settings.winampShortcuts')}
					</p>
					<div class="flex justify-between py-1">
						<span class="text-gray-600 dark:text-gray-400">{t('settings.kbWinampPlay')}</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">X</kbd>
					</div>
					<div class="flex justify-between py-1">
						<span class="text-gray-600 dark:text-gray-400">{t('settings.kbPlayPause')}</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">C</kbd>
					</div>
					<div class="flex justify-between py-1">
						<span class="text-gray-600 dark:text-gray-400">{t('settings.kbWinampStop')}</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">V</kbd>
					</div>
					<div class="flex justify-between py-1">
						<span class="text-gray-600 dark:text-gray-400">{t('settings.kbWinampNext')}</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">B</kbd>
					</div>
					<div class="flex justify-between py-1">
						<span class="text-gray-600 dark:text-gray-400">{t('settings.kbWinampPrev')}</span>
						<kbd class="px-2 py-1 bg-gray-100 dark:bg-gray-700 rounded text-gray-700 dark:text-gray-300">Z</kbd>
					</div>
				{/if}
			</div>
		</section>
	</main>
</div>
