/**
 * Per-service TTS credentials, read from the `tts_credentials` table with an
 * environment-variable fallback (so a deploy can seed keys without the UI).
 * The API key is only ever read here on the server — never serialized to the client.
 */
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';
import type { TtsAudioService, ElevenVoiceSettings } from '$lib/types';
import { DEFAULT_ELEVEN_VOICE_SETTINGS } from '$lib/types';

export interface ResolvedCredential {
	service: TtsAudioService;
	/** May be '' for azure-edge (no key needed) or when unconfigured. */
	apiKey: string;
	region: string;
	model: string;
	voiceId: string;
	enabled: boolean;
	/** ElevenLabs voice_settings, falling back to the documented defaults. */
	voiceSettings: ElevenVoiceSettings;
}

function envKey(service: TtsAudioService): string {
	switch (service) {
		case 'elevenlabs':
			return env.ELEVENLABS_API_KEY ?? '';
		case 'azure':
			return env.AZURE_SPEECH_KEY ?? '';
		case 'google':
			return env.GOOGLE_TTS_API_KEY ?? '';
		default:
			return '';
	}
}

export async function getCredentialRow(service: TtsAudioService) {
	const rows = await db
		.select()
		.from(schema.ttsCredentials)
		.where(eq(schema.ttsCredentials.service, service));
	return rows[0] ?? null;
}

export async function getAllCredentialRows() {
	return db.select().from(schema.ttsCredentials);
}

export async function resolveCredential(service: TtsAudioService): Promise<ResolvedCredential> {
	const row = await getCredentialRow(service);
	const apiKey = (row?.apiKey || envKey(service) || '').trim();
	const region = (row?.region || (service === 'azure' ? env.AZURE_SPEECH_REGION ?? '' : '') || '').trim();
	return {
		service,
		apiKey,
		region,
		model: (row?.model || '').trim(),
		voiceId: (row?.voiceId || '').trim(),
		enabled: !!row?.enabled,
		voiceSettings: {
			stability: row?.stability ?? DEFAULT_ELEVEN_VOICE_SETTINGS.stability,
			similarityBoost: row?.similarityBoost ?? DEFAULT_ELEVEN_VOICE_SETTINGS.similarityBoost,
			style: row?.style ?? DEFAULT_ELEVEN_VOICE_SETTINGS.style,
			useSpeakerBoost: row?.useSpeakerBoost ?? DEFAULT_ELEVEN_VOICE_SETTINGS.useSpeakerBoost
		}
	};
}
