import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import {
	TTS_AUDIO_SERVICES,
	TTS_KEYLESS_SERVICES,
	DEFAULT_ELEVEN_VOICE_SETTINGS,
	DEFAULT_ELF_VOICE_PARAMS,
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
		// Keyless services (azure-edge, elf) need no key — always "configured".
		configured: TTS_KEYLESS_SERVICES.includes(service) ? true : !!row?.apiKey,
		region: row?.region ?? '',
		model: row?.model ?? '',
		voiceId: row?.voiceId ?? '',
		enabled: !!row?.enabled,
		voiceSettings: {
			stability: row?.stability ?? DEFAULT_ELEVEN_VOICE_SETTINGS.stability,
			similarityBoost: row?.similarityBoost ?? DEFAULT_ELEVEN_VOICE_SETTINGS.similarityBoost,
			style: row?.style ?? DEFAULT_ELEVEN_VOICE_SETTINGS.style,
			useSpeakerBoost: row?.useSpeakerBoost ?? DEFAULT_ELEVEN_VOICE_SETTINGS.useSpeakerBoost
		},
		elfCustomize: !!row?.elfCustomize,
		elfParams: {
			headSize: row?.elfHeadSize ?? DEFAULT_ELF_VOICE_PARAMS.headSize,
			pitch: row?.elfPitch ?? DEFAULT_ELF_VOICE_PARAMS.pitch,
			inflection: row?.elfInflection ?? DEFAULT_ELF_VOICE_PARAMS.inflection,
			roughness: row?.elfRoughness ?? DEFAULT_ELF_VOICE_PARAMS.roughness,
			breathiness: row?.elfBreathiness ?? DEFAULT_ELF_VOICE_PARAMS.breathiness,
			volume: row?.elfVolume ?? DEFAULT_ELF_VOICE_PARAMS.volume
		}
	};
}

/** Clamp a 0–1 setting; returns undefined for non-finite input. */
function clamp01(n: unknown): number | undefined {
	if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
	return Math.max(0, Math.min(1, n));
}

/** Clamp a 0–100 integer voice param; returns undefined for non-finite input. */
function clamp100(n: unknown): number | undefined {
	if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
	return Math.max(0, Math.min(100, Math.round(n)));
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
			elfCustomize?: boolean;
			elfParams?: Partial<{
				headSize: number;
				pitch: number;
				inflection: number;
				roughness: number;
				breathiness: number;
				volume: number;
			}>;
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
			useSpeakerBoost: existing?.useSpeakerBoost ?? null,
			elfCustomize: existing?.elfCustomize ?? null,
			elfHeadSize: existing?.elfHeadSize ?? null,
			elfPitch: existing?.elfPitch ?? null,
			elfInflection: existing?.elfInflection ?? null,
			elfRoughness: existing?.elfRoughness ?? null,
			elfBreathiness: existing?.elfBreathiness ?? null,
			elfVolume: existing?.elfVolume ?? null
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
		if (body.elfCustomize !== undefined) next.elfCustomize = !!body.elfCustomize;
		if (body.elfParams) {
			const p = body.elfParams;
			if (p.headSize !== undefined) next.elfHeadSize = clamp100(p.headSize) ?? next.elfHeadSize;
			if (p.pitch !== undefined) next.elfPitch = clamp100(p.pitch) ?? next.elfPitch;
			if (p.inflection !== undefined) next.elfInflection = clamp100(p.inflection) ?? next.elfInflection;
			if (p.roughness !== undefined) next.elfRoughness = clamp100(p.roughness) ?? next.elfRoughness;
			if (p.breathiness !== undefined)
				next.elfBreathiness = clamp100(p.breathiness) ?? next.elfBreathiness;
			if (p.volume !== undefined) next.elfVolume = clamp100(p.volume) ?? next.elfVolume;
		}

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
					useSpeakerBoost: next.useSpeakerBoost,
					elfCustomize: next.elfCustomize,
					elfHeadSize: next.elfHeadSize,
					elfPitch: next.elfPitch,
					elfInflection: next.elfInflection,
					elfRoughness: next.elfRoughness,
					elfBreathiness: next.elfBreathiness,
					elfVolume: next.elfVolume
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
