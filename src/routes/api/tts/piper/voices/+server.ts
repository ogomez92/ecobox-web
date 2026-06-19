import { json } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { TtsError } from '$server/services/tts';
import {
	listPiperModels,
	savePiperVoice,
	deletePiperVoice,
	isValidStem
} from '$server/services/tts/piper';

// Piper voice models are large (medium ~60MB, high ~120MB). Allow a generous body
// so the .onnx + .onnx.json pair uploads in one multipart request.
export const config = {
	body: { maxSize: 1024 * 1024 * 1024 } // 1 GB
};

/** GET → imported model list (one row per model) for the manage/import UI. */
export const GET: RequestHandler = async () => {
	try {
		return json(await listPiperModels());
	} catch {
		return json({ error: 'Failed to list voices' }, { status: 500 });
	}
};

/**
 * POST (multipart) → import one voice. The form must carry the `.onnx` model and
 * its `.onnx.json` config (field name `files`). Stored under PIPER_VOICES_DIR; the
 * voice then appears in /api/tts/voices?service=piper automatically.
 */
export const POST: RequestHandler = async ({ request }) => {
	let form: FormData;
	try {
		form = await request.formData();
	} catch {
		return json({ error: 'Invalid upload' }, { status: 400 });
	}

	const files = form.getAll('files').filter((f): f is File => f instanceof File);
	const onnx = files.find((f) => f.name.endsWith('.onnx'));
	const cfg = files.find((f) => f.name.endsWith('.json'));
	if (!onnx || !cfg) {
		return json(
			{ error: 'Select both the .onnx model and its .onnx.json config file' },
			{ status: 400 }
		);
	}

	const stem = onnx.name.slice(0, -'.onnx'.length);
	if (!isValidStem(stem)) {
		return json({ error: 'Voice file name has unsupported characters' }, { status: 400 });
	}

	const cfgBuf = Buffer.from(await cfg.arrayBuffer());
	try {
		const parsed = JSON.parse(cfgBuf.toString('utf8'));
		if (typeof parsed !== 'object' || parsed === null) throw new Error('not an object');
	} catch {
		return json({ error: 'The config file is not valid Piper JSON' }, { status: 400 });
	}

	const onnxBuf = Buffer.from(await onnx.arrayBuffer());
	if (onnxBuf.length < 1024) {
		return json({ error: 'The .onnx model file looks empty' }, { status: 400 });
	}

	try {
		await savePiperVoice(stem, onnxBuf, cfgBuf);
	} catch (e) {
		const status = e instanceof TtsError ? e.status : 500;
		return json({ error: e instanceof Error ? e.message : 'Failed to save voice' }, { status });
	}
	return json({ ok: true, stem });
};

/** DELETE ?stem= → remove an imported voice (model + config). */
export const DELETE: RequestHandler = async ({ url }) => {
	const stem = url.searchParams.get('stem') ?? '';
	if (!isValidStem(stem)) {
		return json({ error: 'Invalid voice name' }, { status: 400 });
	}
	try {
		await deletePiperVoice(stem);
	} catch (e) {
		const status = e instanceof TtsError ? e.status : 500;
		return json({ error: e instanceof Error ? e.message : 'Failed to delete voice' }, { status });
	}
	return json({ ok: true });
};
