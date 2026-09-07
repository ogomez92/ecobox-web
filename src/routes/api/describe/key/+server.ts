import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import {
	clearDescribeKey,
	describeKeyStatus,
	looksLikeGeminiKey,
	saveDescribeKey
} from '$server/services/describeKey';

/**
 * The Gemini key for video description. Write-only from the client's side: it can
 * be set, replaced and removed, but never read back — GET answers only whether one
 * exists and whether it came from the environment or the dialog.
 */

/** GET → `{ configured, source }`. The key itself is never serialized. */
export const GET: RequestHandler = async () => {
	try {
		return json(describeKeyStatus());
	} catch (err) {
		console.error('Describe key status error:', err);
		throw error(500, 'Failed to read key status');
	}
};

/** PUT `{ apiKey }` → the new status. A stored key overrides `GEMINI_API_KEY`. */
export const PUT: RequestHandler = async ({ request }) => {
	let body: { apiKey?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
	if (!apiKey) {
		return json({ ok: false, code: 'empty' }, { status: 400 });
	}
	// Catch the common paste errors (a truncated key, another provider's key) here
	// rather than after the user has waited for a whole request to fail.
	if (!looksLikeGeminiKey(apiKey)) {
		return json({ ok: false, code: 'malformed' }, { status: 400 });
	}

	try {
		saveDescribeKey(apiKey);
		return json({ ok: true, ...describeKeyStatus() });
	} catch (err) {
		console.error('Describe key save error:', err);
		throw error(500, 'Failed to save key');
	}
};

/** DELETE → forget the stored key. A `GEMINI_API_KEY` in the env takes over again. */
export const DELETE: RequestHandler = async () => {
	try {
		clearDescribeKey();
		return json({ ok: true, ...describeKeyStatus() });
	} catch (err) {
		console.error('Describe key delete error:', err);
		throw error(500, 'Failed to remove key');
	}
};
