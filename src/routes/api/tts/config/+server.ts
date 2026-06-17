import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import {
	TTS_AUDIO_SERVICES,
	DEFAULT_ELEVEN_VOICE_SETTINGS,
	type TtsAudioService,
	type TtsCredentialConfig
} from '$lib/types';
import { getAllCredentialRows, getCredentialRow } from '$server/services/tts/credentials';
import type { TtsCredential } from '$server/db/schema';

function isAudioService(s: string): s is TtsAudioService {
	return (TTS_AUDIO_SERVICES as string[]).includes(s);
}

/** Build the sanitized (key-free) client view of one credential row. */
function toConfig(service: TtsAudioService, row: TtsCredential | null | undefined): TtsCredentialConfig {
	return {
		service,
		// azure-edge needs no key — treat it as always "configured".
		configured: service === 'azure-edge' ? true : !!row?.apiKey,
		region: row?.region ?? '',
		model: row?.model ?? '',
		voiceId: row?.voiceId ?? '',
		enabled: !!row?.enabled,
		voiceSettings: {
			stability: row?.stability ?? DEFAULT_ELEVEN_VOICE_SETTINGS.stability,
			similarityBoost: row?.similarityBoost ?? DEFAULT_ELEVEN_VOICE_SETTINGS.similarityBoost,
			style: row?.style ?? DEFAULT_ELEVEN_VOICE_SETTINGS.style,
			useSpeakerBoost: row?.useSpeakerBoost ?? DEFAULT_ELEVEN_VOICE_SETTINGS.useSpeakerBoost
		}
	};
}

/** Clamp a 0–1 setting; returns undefined for non-finite input. */
function clamp01(n: unknown): number | undefined {
	if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
	return Math.max(0, Math.min(1, n));
}

/** GET → sanitized per-service config. The API key is NEVER returned. */
export const GET: RequestHandler = async () => {
	try {
		const rows = await getAllCredentialRows();
		const byService = new Map(rows.map((r) => [r.service, r]));
		const configs: TtsCredentialConfig[] = TTS_AUDIO_SERVICES.map((service) =>
			toConfig(service, byService.get(service))
		);
		return json(configs);
	} catch (err) {
		console.error('TTS config GET error:', err);
		throw error(500, 'Failed to load TTS config');
	}
};

/**
 * PUT → upsert one service's config. Write-only key handling:
 *  - `removeKey: true` clears the stored key
 *  - a non-empty `apiKey` string replaces it
 *  - an empty/absent `apiKey` leaves the stored key untouched
 */
export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = (await request.json()) as {
			service?: string;
			apiKey?: string;
			removeKey?: boolean;
			region?: string;
			model?: string;
			voiceId?: string;
			enabled?: boolean;
			stability?: number;
			similarityBoost?: number;
			style?: number;
			useSpeakerBoost?: boolean;
		};
		const service = body.service;
		if (!service || !isAudioService(service)) throw error(400, 'Invalid service');

		const existing = await getCredentialRow(service);
		const next = {
			service,
			apiKey: existing?.apiKey ?? null,
			region: existing?.region ?? null,
			model: existing?.model ?? null,
			voiceId: existing?.voiceId ?? null,
			enabled: existing?.enabled ?? false,
			stability: existing?.stability ?? null,
			similarityBoost: existing?.similarityBoost ?? null,
			style: existing?.style ?? null,
			useSpeakerBoost: existing?.useSpeakerBoost ?? null
		};

		if (body.removeKey) next.apiKey = null;
		else if (typeof body.apiKey === 'string' && body.apiKey.trim()) next.apiKey = body.apiKey.trim();
		if (body.region !== undefined) next.region = body.region.trim();
		if (body.model !== undefined) next.model = body.model.trim();
		if (body.voiceId !== undefined) next.voiceId = body.voiceId.trim();
		if (body.enabled !== undefined) next.enabled = !!body.enabled;
		if (body.stability !== undefined) next.stability = clamp01(body.stability) ?? next.stability;
		if (body.similarityBoost !== undefined)
			next.similarityBoost = clamp01(body.similarityBoost) ?? next.similarityBoost;
		if (body.style !== undefined) next.style = clamp01(body.style) ?? next.style;
		if (body.useSpeakerBoost !== undefined) next.useSpeakerBoost = !!body.useSpeakerBoost;

		await db
			.insert(schema.ttsCredentials)
			.values(next)
			.onConflictDoUpdate({
				target: schema.ttsCredentials.service,
				set: {
					apiKey: next.apiKey,
					region: next.region,
					model: next.model,
					voiceId: next.voiceId,
					enabled: next.enabled,
					stability: next.stability,
					similarityBoost: next.similarityBoost,
					style: next.style,
					useSpeakerBoost: next.useSpeakerBoost
				}
			});

		// Return the sanitized view (no key) for this service.
		return json(toConfig(service, await getCredentialRow(service)));
	} catch (err) {
		if (err && typeof err === 'object' && 'status' in err) throw err;
		console.error('TTS config PUT error:', err);
		throw error(500, 'Failed to save TTS config');
	}
};
