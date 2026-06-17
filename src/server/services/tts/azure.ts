/**
 * Azure TTS adapter — two modes:
 *  - key mode: Azure Cognitive Services Speech (needs apiKey + region)
 *  - edge mode: keyless Microsoft Edge "read aloud" via msedge-tts. Experimental;
 *    Microsoft filters anti-abuse on datacenter IPs, so this may fail from a VPS.
 */
import type { TtsVoice } from '$lib/types';
import { TtsError } from './errors';
import { MsEdgeTTS, OUTPUT_FORMAT } from 'msedge-tts';
import type { Readable } from 'stream';

const OUTPUT = 'audio-24khz-48kbitrate-mono-mp3';
const TIMEOUT = 30000;

function escapeXml(s: string): string {
	return s
		.replace(/&/g, '&amp;')
		.replace(/</g, '&lt;')
		.replace(/>/g, '&gt;')
		.replace(/"/g, '&quot;')
		.replace(/'/g, '&apos;');
}

// --- Key mode (Azure Cognitive Services Speech) ---

export async function azureSynthesize(opts: {
	apiKey: string;
	region: string;
	voiceId: string;
	text: string;
	lang: string;
}): Promise<ArrayBuffer> {
	if (!opts.apiKey) throw new TtsError(400, 'Azure API key not configured');
	if (!opts.region) throw new TtsError(400, 'Azure region not configured');
	if (!opts.voiceId) throw new TtsError(400, 'No Azure voice selected');
	const ssml =
		`<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xml:lang="${opts.lang || 'en-US'}">` +
		`<voice name="${opts.voiceId}">${escapeXml(opts.text)}</voice></speak>`;
	let res: Response;
	try {
		res = await fetch(`https://${opts.region}.tts.speech.microsoft.com/cognitiveservices/v1`, {
			method: 'POST',
			headers: {
				'Ocp-Apim-Subscription-Key': opts.apiKey,
				'Content-Type': 'application/ssml+xml',
				'X-Microsoft-OutputFormat': OUTPUT
			},
			body: ssml,
			signal: AbortSignal.timeout(TIMEOUT)
		});
	} catch {
		throw new TtsError(503, 'Azure unreachable');
	}
	if (!res.ok) {
		throw new TtsError(res.status === 401 || res.status === 403 ? 401 : 502, `Azure error ${res.status}`);
	}
	return res.arrayBuffer();
}

export async function azureVoices(opts: { apiKey: string; region: string }): Promise<TtsVoice[]> {
	if (!opts.apiKey || !opts.region) throw new TtsError(400, 'Azure key/region not configured');
	let res: Response;
	try {
		res = await fetch(
			`https://${opts.region}.tts.speech.microsoft.com/cognitiveservices/voices/list`,
			{ headers: { 'Ocp-Apim-Subscription-Key': opts.apiKey }, signal: AbortSignal.timeout(TIMEOUT) }
		);
	} catch {
		throw new TtsError(503, 'Azure unreachable');
	}
	if (!res.ok) {
		throw new TtsError(res.status === 401 || res.status === 403 ? 401 : 502, `Azure error ${res.status}`);
	}
	const data = (await res.json()) as Record<string, string>[];
	return (data ?? []).map((v) => ({
		id: v.ShortName,
		name: `${v.LocalName || v.DisplayName || v.ShortName} — ${v.Locale}`,
		lang: v.Locale
	}));
}

// --- Edge mode (keyless) ---

async function collectStream(stream: Readable): Promise<Buffer> {
	const chunks: Buffer[] = [];
	await new Promise<void>((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error('timeout')), TIMEOUT);
		stream.on('data', (c: Buffer) => chunks.push(Buffer.from(c)));
		stream.on('end', () => {
			clearTimeout(timer);
			resolve();
		});
		stream.on('error', (e) => {
			clearTimeout(timer);
			reject(e);
		});
	});
	return Buffer.concat(chunks);
}

export async function edgeSynthesize(opts: { voiceId: string; text: string }): Promise<Buffer> {
	const tts = new MsEdgeTTS();
	try {
		await tts.setMetadata(
			opts.voiceId || 'en-US-AriaNeural',
			OUTPUT_FORMAT.AUDIO_24KHZ_48KBITRATE_MONO_MP3
		);
		const { audioStream } = tts.toStream(opts.text);
		const buf = await collectStream(audioStream);
		if (buf.length === 0) throw new Error('empty');
		return buf;
	} catch {
		throw new TtsError(502, 'Edge TTS failed (the keyless endpoint may be blocked from this server)');
	} finally {
		try {
			tts.close();
		} catch {
			// ignore
		}
	}
}

export async function edgeVoices(): Promise<TtsVoice[]> {
	try {
		const tts = new MsEdgeTTS();
		const voices = await tts.getVoices();
		return voices.map((v) => ({
			id: v.ShortName,
			name: `${v.FriendlyName || v.ShortName} — ${v.Locale}`,
			lang: v.Locale
		}));
	} catch {
		throw new TtsError(502, 'Edge voices unavailable (the keyless endpoint may be blocked from this server)');
	}
}
