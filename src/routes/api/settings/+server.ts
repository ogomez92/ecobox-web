import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import type { Settings } from '$lib/types';

export const GET: RequestHandler = async () => {
	try {
		const rows = await db.select().from(schema.settings);
		const settings: Record<string, string> = {};

		for (const row of rows) {
			settings[row.key] = row.value;
		}

		// Parse settings from stored strings
		const parsed: Partial<Settings> = {};

		if (settings.seekInterval) parsed.seekInterval = parseInt(settings.seekInterval, 10);
		if (settings.longSeekInterval) parsed.longSeekInterval = parseInt(settings.longSeekInterval, 10);
		if (settings.createBookmarkOnPause) parsed.createBookmarkOnPause = settings.createBookmarkOnPause === 'true';
		if (settings.audioEffectsEnabled) parsed.audioEffectsEnabled = settings.audioEffectsEnabled === 'true';
		if (settings.radioResumeBehavior) parsed.radioResumeBehavior = settings.radioResumeBehavior as 'always' | 'never' | 'ask';
		if (settings.theme) parsed.theme = settings.theme as 'light' | 'dark' | 'system';

		return json(parsed);
	} catch (err) {
		console.error('Settings GET error:', err);
		throw error(500, 'Failed to get settings');
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body: Partial<Settings> = await request.json();

		// Convert settings to key-value pairs
		const entries: { key: string; value: string }[] = [];

		if (body.seekInterval !== undefined) {
			entries.push({ key: 'seekInterval', value: String(body.seekInterval) });
		}
		if (body.longSeekInterval !== undefined) {
			entries.push({ key: 'longSeekInterval', value: String(body.longSeekInterval) });
		}
		if (body.createBookmarkOnPause !== undefined) {
			entries.push({ key: 'createBookmarkOnPause', value: String(body.createBookmarkOnPause) });
		}
		if (body.audioEffectsEnabled !== undefined) {
			entries.push({ key: 'audioEffectsEnabled', value: String(body.audioEffectsEnabled) });
		}
		if (body.radioResumeBehavior !== undefined) {
			entries.push({ key: 'radioResumeBehavior', value: body.radioResumeBehavior });
		}
		if (body.theme !== undefined) {
			entries.push({ key: 'theme', value: body.theme });
		}

		// Upsert each setting
		for (const entry of entries) {
			await db
				.insert(schema.settings)
				.values(entry)
				.onConflictDoUpdate({
					target: schema.settings.key,
					set: { value: entry.value }
				});
		}

		return json({ success: true });
	} catch (err) {
		console.error('Settings PUT error:', err);
		throw error(500, 'Failed to save settings');
	}
};
