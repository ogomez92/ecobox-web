import type { Settings } from '$lib/types';

const defaultSettings: Settings = {
	seekInterval: 5,
	longSeekInterval: 30,
	createBookmarkOnPause: false,
	audioEffectsEnabled: false,
	radioResumeBehavior: 'ask',
	theme: 'system',
	autoplay: true,
	maskTitle: ''
};

class SettingsStore {
	seekInterval = $state(defaultSettings.seekInterval);
	longSeekInterval = $state(defaultSettings.longSeekInterval);
	createBookmarkOnPause = $state(defaultSettings.createBookmarkOnPause);
	audioEffectsEnabled = $state(defaultSettings.audioEffectsEnabled);
	radioResumeBehavior = $state<'always' | 'never' | 'ask'>(defaultSettings.radioResumeBehavior);
	theme = $state<'light' | 'dark' | 'system'>(defaultSettings.theme);
	autoplay = $state(defaultSettings.autoplay);
	maskTitle = $state(defaultSettings.maskTitle);

	private isLoaded = false;

	async load() {
		if (this.isLoaded) return;

		try {
			const response = await fetch('/api/settings');
			if (response.ok) {
				const settings = await response.json();
				this.apply(settings);
			}
		} catch {
			// Use defaults
		}

		this.isLoaded = true;
	}

	private apply(settings: Partial<Settings>) {
		if (settings.seekInterval !== undefined) this.seekInterval = settings.seekInterval;
		if (settings.longSeekInterval !== undefined) this.longSeekInterval = settings.longSeekInterval;
		if (settings.createBookmarkOnPause !== undefined) this.createBookmarkOnPause = settings.createBookmarkOnPause;
		if (settings.audioEffectsEnabled !== undefined) this.audioEffectsEnabled = settings.audioEffectsEnabled;
		if (settings.radioResumeBehavior !== undefined) this.radioResumeBehavior = settings.radioResumeBehavior;
		if (settings.theme !== undefined) this.theme = settings.theme;
		if (settings.autoplay !== undefined) this.autoplay = settings.autoplay;
		if (settings.maskTitle !== undefined) this.maskTitle = settings.maskTitle;
	}

	async save() {
		const settings: Settings = {
			seekInterval: this.seekInterval,
			longSeekInterval: this.longSeekInterval,
			createBookmarkOnPause: this.createBookmarkOnPause,
			audioEffectsEnabled: this.audioEffectsEnabled,
			radioResumeBehavior: this.radioResumeBehavior,
			theme: this.theme,
			autoplay: this.autoplay,
			maskTitle: this.maskTitle
		};

		try {
			await fetch('/api/settings', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(settings)
			});
		} catch {
			// Ignore save errors
		}
	}

	setSeekInterval(value: number) {
		this.seekInterval = value;
		this.save();
	}

	setLongSeekInterval(value: number) {
		this.longSeekInterval = value;
		this.save();
	}

	setCreateBookmarkOnPause(value: boolean) {
		this.createBookmarkOnPause = value;
		this.save();
	}

	setAudioEffectsEnabled(value: boolean) {
		this.audioEffectsEnabled = value;
		this.save();
	}

	setRadioResumeBehavior(value: 'always' | 'never' | 'ask') {
		this.radioResumeBehavior = value;
		this.save();
	}

	setTheme(value: 'light' | 'dark' | 'system') {
		this.theme = value;
		this.save();
		this.applyTheme();
	}

	setAutoplay(value: boolean) {
		this.autoplay = value;
		this.save();
	}

	setMaskTitle(value: string) {
		this.maskTitle = value;
		this.save();
	}

	applyTheme() {
		if (typeof document === 'undefined') return;

		const isDark = this.theme === 'dark' ||
			(this.theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

		document.documentElement.classList.toggle('dark', isDark);
	}
}

export const settingsStore = new SettingsStore();
