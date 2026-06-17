/** Google Cloud Text-to-Speech adapter. https://cloud.google.com/text-to-speech */
import type { TtsVoice } from '$lib/types';
import { TtsError } from './errors';

const BASE = 'https://texttospeech.googleapis.com/v1';
const TIMEOUT = 30000;

/** Google needs a BCP-47 languageCode; derive it from the voice name (e.g. "en-US-Wavenet-D"). */
function langFromVoice(voiceId: string, fallback: string): string {
	const m = voiceId.match(/^([a-z]{2,3}-[A-Z]{2})/);
	return m ? m[1] : fallback || 'en-US';
}

export async function googleSynthesize(opts: {
	apiKey: string;
	voiceId: string;
	text: string;
	lang: string;
}): Promise<Buffer> {
	if (!opts.apiKey) throw new TtsError(400, 'Google API key not configured');
	if (!opts.voiceId) throw new TtsError(400, 'No Google voice selected');
	let res: Response;
	try {
		res = await fetch(`${BASE}/text:synthesize?key=${encodeURIComponent(opts.apiKey)}`, {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				input: { text: opts.text },
				voice: { languageCode: langFromVoice(opts.voiceId, opts.lang), name: opts.voiceId },
				audioConfig: { audioEncoding: 'MP3' }
			}),
			signal: AbortSignal.timeout(TIMEOUT)
		});
	} catch {
		throw new TtsError(503, 'Google unreachable');
	}
	if (!res.ok) {
		throw new TtsError(res.status === 400 || res.status === 403 ? 401 : 502, `Google error ${res.status}`);
	}
	const data = (await res.json()) as { audioContent?: string };
	if (!data.audioContent) throw new TtsError(502, 'Google returned no audio');
	return Buffer.from(data.audioContent, 'base64');
}

export async function googleVoices(opts: { apiKey: string; lang?: string }): Promise<TtsVoice[]> {
	if (!opts.apiKey) throw new TtsError(400, 'Google API key not configured');
	const url =
		`${BASE}/voices?key=${encodeURIComponent(opts.apiKey)}` +
		(opts.lang ? `&languageCode=${encodeURIComponent(opts.lang)}` : '');
	let res: Response;
	try {
		res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT) });
	} catch {
		throw new TtsError(503, 'Google unreachable');
	}
	if (!res.ok) {
		throw new TtsError(res.status === 400 || res.status === 403 ? 401 : 502, `Google error ${res.status}`);
	}
	const data = (await res.json()) as { voices?: Record<string, unknown>[] };
	return (data.voices ?? []).map((v) => ({
		id: String(v.name),
		name: `${String(v.name)} — ${String(v.ssmlGender ?? '').toLowerCase()}`,
		lang: (v.languageCodes as string[] | undefined)?.[0] || ''
	}));
}
