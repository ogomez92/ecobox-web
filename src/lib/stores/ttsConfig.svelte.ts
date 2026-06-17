/**
 * Client view of per-service TTS config (selected voice, model, region, and
 * whether a key is configured). The API key itself NEVER lives here — the server
 * returns only a `configured` boolean. Setters persist via PUT /api/tts/config.
 */
import {
	TTS_AUDIO_SERVICES,
	DEFAULT_ELEVEN_MODEL,
	DEFAULT_ELEVEN_VOICE_SETTINGS,
	type TtsAudioService,
	type TtsCredentialConfig,
	type ElevenVoiceSettings
} from '$lib/types';

function blank(service: TtsAudioService): TtsCredentialConfig {
	return {
		service,
		configured: service === 'azure-edge',
		region: '',
		model: service === 'elevenlabs' ? DEFAULT_ELEVEN_MODEL : '',
		voiceId: '',
		enabled: false,
		voiceSettings: { ...DEFAULT_ELEVEN_VOICE_SETTINGS }
	};
}

class TtsConfigStore {
	configs = $state<TtsCredentialConfig[]>(TTS_AUDIO_SERVICES.map(blank));

	private isLoaded = false;

	async load() {
		if (this.isLoaded) return;
		try {
			const res = await fetch('/api/tts/config');
			if (res.ok) {
				const data = (await res.json()) as TtsCredentialConfig[];
				this.configs = TTS_AUDIO_SERVICES.map((s) => data.find((d) => d.service === s) ?? blank(s));
			}
		} catch {
			// Use blanks.
		}
		this.isLoaded = true;
	}

	get(service: TtsAudioService): TtsCredentialConfig {
		return this.configs.find((c) => c.service === service) ?? blank(service);
	}

	private replace(updated: TtsCredentialConfig) {
		this.configs = this.configs.map((c) => (c.service === updated.service ? updated : c));
	}

	private async put(service: TtsAudioService, patch: Record<string, unknown>) {
		try {
			const res = await fetch('/api/tts/config', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ service, ...patch })
			});
			if (res.ok) this.replace((await res.json()) as TtsCredentialConfig);
		} catch {
			// Ignore save errors.
		}
	}

	setApiKey(service: TtsAudioService, apiKey: string) {
		return this.put(service, { apiKey });
	}

	removeKey(service: TtsAudioService) {
		return this.put(service, { removeKey: true });
	}

	setRegion(service: TtsAudioService, region: string) {
		return this.put(service, { region });
	}

	setModel(service: TtsAudioService, model: string) {
		return this.put(service, { model });
	}

	setVoiceId(service: TtsAudioService, voiceId: string) {
		return this.put(service, { voiceId });
	}

	setEnabled(service: TtsAudioService, enabled: boolean) {
		return this.put(service, { enabled });
	}

	/** Patch one or more ElevenLabs voice_settings knobs (optimistic local update). */
	setVoiceSettings(service: TtsAudioService, patch: Partial<ElevenVoiceSettings>) {
		const current = this.get(service);
		this.replace({ ...current, voiceSettings: { ...current.voiceSettings, ...patch } });
		return this.put(service, patch);
	}
}

export const ttsConfigStore = new TtsConfigStore();
