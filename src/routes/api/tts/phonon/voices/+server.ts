import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { TtsError } from '$server/services/tts';
import {
	listPhononCustomVoices,
	savePhononVoice,
	deletePhononVoice,
	isValidStem,
	isPhononLang,
	looksLikeSafetensors
} from '$server/services/tts/phonon';

// A Phonon voice embedding is tiny (~256 KB: one 1×512×125 float32 tensor); 16 MB is
// generous headroom while still refusing an accidental model upload.
export const config = {
	body: { maxSize: 16 * 1024 * 1024 }
};

/** GET → uploaded voices for the manage UI. Catalog voices come from /api/tts/voices. */
export const GET: RequestHandler = async () => {
	try {
		return json(await listPhononCustomVoices());
	} catch {
		return json({ error: 'Failed to list voices' }, { status: 500 });
	}
};

/**
 * POST (multipart) → upload one voice: `file` (.safetensors voice embedding, e.g. a
 * clone exported from Gradium), `name` (display name) and `lang` (en/fr/de/es/pt —
 * which model speaks it). Playback only; nothing is cloned here.
 */
export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'Invalid upload' }, { status: 400 });
	}
	const file = form.get('file');
	if (!(file instanceof File) || !file.name.toLowerCase().endsWith('.safetensors')) {
		return json({ error: 'Choose a Phonon voice file (.safetensors)' }, { status: 400 });
	}
	const lang = String(form.get('lang') ?? 'en');
	if (!isPhononLang(lang)) return json({ error: 'Unsupported language' }, { status: 400 });

	const base = file.name.slice(0, -'.safetensors'.length);
	const stem = base.replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+/, '') || 'voice';
	if (!isValidStem(stem)) return json({ error: 'Voice file name has unsupported characters' }, { status: 400 });
	const name = String(form.get('name') ?? '').trim().slice(0, 80) || base;

	const buf = Buffer.from(await file.arrayBuffer());
	if (!looksLikeSafetensors(buf)) {
		return json({ error: 'That file is not a valid .safetensors voice' }, { status: 400 });
	}
	try {
		await savePhononVoice(stem, buf, { name, lang });
	} catch (e) {
		const status = e instanceof TtsError ? e.status : 500;
		return json({ error: e instanceof Error ? e.message : 'Failed to save voice' }, { status });
	}
	return json({ ok: true, stem, id: `custom:${stem}` });
};

/** DELETE ?stem= → remove an uploaded voice. */
export const DELETE: RequestHandler = async ({ url }) => {
	const stem = url.searchParams.get('stem') ?? '';
	if (!isValidStem(stem)) return json({ error: 'Invalid voice name' }, { status: 400 });
	try {
		await deletePhononVoice(stem);
	} catch (e) {
		const status = e instanceof TtsError ? e.status : 500;
		return json({ error: e instanceof Error ? e.message : 'Failed to delete voice' }, { status });
	}
	return json({ ok: true });
};
