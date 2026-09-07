/**
 * "What is happening on screen?" — audio description of a marked video segment,
 * produced by Gemini and spoken by the listener's screen reader.
 *
 * Ecobox never renders video (see `mediaTypes.ts`): a video file plays through the
 * same `<audio>` element as everything else, which is exactly right for a blind
 * listener until something happens that only the picture carries. This service
 * fills that gap. The user marks a start and an end in the player; the server cuts
 * that span out with ffmpeg and sends **the clip itself** to the model.
 *
 * Why Gemini and not Claude: the Claude API takes images only — a `video` content
 * block does not exist, and a `video/mp4` file is rejected by both the image and
 * document blocks ("Supported image formats are JPEG, PNG, GIF, and WebP").
 * Describing a scene from a handful of stills loses exactly what a blind listener
 * most needs — motion, direction, who moved where — so the engine is
 * `generativelanguage.googleapis.com`, which ingests real video.
 *
 * Two consequences shape everything below:
 *
 *  - **We send a clip, not frames.** ffmpeg re-encodes the marked span (rather than
 *    stream-copying it) so the cut lands exactly on the marks, the file stays small
 *    enough to inline, and the model gets a steady 720p-max picture to read signage
 *    from. `videoMetadata.fps` then tells the model how densely to sample it.
 *  - **The clip keeps its audio, and that is a feature.** The model *hears* the
 *    segment, so "never restate what the listener can already hear" stops being a
 *    hope and becomes something it can actually check. It also covers sound the
 *    subtitles never carry — a scream, a car, a song.
 *
 * Nothing here writes into MEDIA_ROOT: the clip goes to a temp directory on local
 * disk (MEDIA_ROOT is an ~83 ms sshfs mount) and is deleted before the call
 * returns, as is any copy uploaded to the Files API.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { GoogleGenAI, ApiError, FileState, MediaResolution, ThinkingLevel } from '@google/genai';
import { env } from '$env/dynamic/private';
import { resolveExistingPath, getRelativePath } from './files';
import { resolveDescribeKey } from './describeKey';
import { isVideoExtension } from '$lib/utils/mediaTypes';
import { MAX_DESCRIBE_SECONDS, type DescribeErrorCode, type DescribeResult } from '$lib/types';

const execFileAsync = promisify(execFile);

/** Re-encoding a bounded span is quick; this is a stuck-process guard. */
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
/** How long we wait on the API before telling the user it timed out. */
const API_TIMEOUT_MS = 3 * 60 * 1000;
/** How long a Files API upload may sit in PROCESSING before we give up. */
const FILE_PROCESSING_TIMEOUT_MS = 90 * 1000;

/**
 * Flash is the right tier here: video understanding is a strength of it, it is
 * cheap enough to press a key for, and someone is waiting on the answer.
 * Overridable because model names churn faster than this file does.
 */
const MODEL = env.GEMINI_DESCRIBE_MODEL?.trim() || 'gemini-3.8-flash';

/** Longest edge of the clip we send. 720p keeps on-screen text legible. */
const CLIP_WIDTH = 720;
/**
 * Above this the clip goes through the Files API instead of being inlined.
 * Base64 inflates by 4/3, so this keeps a request well inside the inline limit.
 */
const INLINE_MAX_BYTES = 12 * 1024 * 1024;

// ---------------------------------------------------------------------------
// Sampling plan (pure)
// ---------------------------------------------------------------------------

/**
 * How densely the model should sample the clip, in frames per second.
 *
 * A short mark is usually a specific action ("what just happened?") and deserves
 * fine sampling; a long one is a scene summary, where a frame every few seconds
 * says the same thing for a fraction of the tokens. Gemini's valid range is
 * (0, 24]; its own default is 1.
 */
export function planVideoFps(duration: number): number {
	if (duration <= 20) return 2;
	if (duration <= 60) return 1;
	if (duration <= 180) return 0.5;
	return 0.25;
}

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

/** `1:23:45` / `4:05` — the same shape the player shows, so marks read back familiar. */
export function formatTimestamp(seconds: number): string {
	const total = Math.max(0, Math.floor(seconds));
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const s = total % 60;
	const mm = h > 0 ? String(m).padStart(2, '0') : String(m);
	return `${h > 0 ? `${h}:` : ''}${mm}:${String(s).padStart(2, '0')}`;
}

/** UI locale → the language the description should be written in. */
const LANGUAGE_NAMES: Record<string, string> = {
	en: 'English',
	es: 'Spanish',
	fr: 'French',
	de: 'German',
	ru: 'Russian',
	ja: 'Japanese',
	zh: 'Chinese'
};

export function languageName(locale: string | undefined): string {
	const base = (locale ?? '').toLowerCase().split('-')[0];
	return LANGUAGE_NAMES[base] ?? 'English';
}

/**
 * The standing instructions. Three rules carry the feature: describe only what can
 * be *seen*, never restate what the clip's own soundtrack already says (the model
 * can hear it, so this is checkable), and read out on-screen text verbatim — it is
 * invisible to the listener and usually load-bearing.
 */
export function buildSystemPrompt(language: string, hasAudio: boolean): string {
	return [
		'You are writing audio description for a blind or low-vision listener who is playing a video and hearing all of its sound, but cannot see the picture at all.',
		'',
		'You are given one short segment of that video. Write the description that belongs in it.',
		'',
		'Rules:',
		'- Describe only what can be SEEN.',
		hasAudio
			? '- You can hear this clip. So can the listener — every word of dialogue, every sound effect, all the music. Never restate any of it: do not transcribe, quote or paraphrase speech, and do not narrate sounds. Use what you hear only to work out who is speaking and what not to say.'
			: '- This clip carries no audio track, so describe the picture on its own terms.',
		'- Never mention the clip, the video, the camera roll, or that you were shown anything. Write about the scene itself.',
		'- Use the present tense and plain declarative sentences. No preamble, no sign-off, no headings, no bullet points, no markdown, no emoji: the text is read aloud by a screen reader exactly as written.',
		'- Lead with what matters most: who is on screen, what they are doing, and where. Then the setting, appearance, expressions, body language, and above all what CHANGES as the segment runs — movement, gestures, entrances and exits, and who goes where.',
		'- Read out any text that appears on screen — signs, titles, captions burned into the picture, phone and computer screens, credits — quoting it exactly. That information is invisible to the listener and often carries the point of the shot.',
		'- Mention a cut, a camera move or a scene change only when it changes what the listener needs to know.',
		'- Be concrete and neutral. Do not interpret motives, invent names, guess at the plot, or editorialize about quality.',
		'- Say only what you can actually see. If something is unclear, leave it out rather than guessing.',
		'- Match the length to the segment: one or two sentences for a few seconds, at most a short paragraph for a long one. Every sentence must add something visible.',
		`- Write in ${language}.`
	].join('\n');
}

/** The per-request half: where in the film this is, and what to do. */
export function buildUserPrompt(options: {
	fileName: string;
	start: number;
	end: number;
}): string {
	const { fileName, start, end } = options;
	const seconds = Math.max(0, end - start);
	return [
		`This segment is from "${fileName}", running from ${formatTimestamp(start)} to ${formatTimestamp(end)} (${seconds.toFixed(1)} seconds).`,
		'',
		'Describe what is visible in it.'
	].join('\n');
}

// ---------------------------------------------------------------------------
// ffmpeg
// ---------------------------------------------------------------------------

interface ProbeStream {
	codec_type?: string;
}

interface Probe {
	streams?: ProbeStream[];
	format?: { duration?: string };
}

async function ffprobe(absPath: string): Promise<Probe | null> {
	try {
		const { stdout } = await execFileAsync(
			'ffprobe',
			['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
			{ maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }
		);
		return JSON.parse(stdout) as Probe;
	} catch (err) {
		console.error('ffprobe failed for describe:', err);
		return null;
	}
}

/** A failure that already knows which `DescribeErrorCode` the client should see. */
class DescribeError extends Error {
	constructor(
		readonly code: DescribeErrorCode,
		readonly detail?: string
	) {
		super(detail ?? code);
	}
}

/**
 * Cut the marked span out as a self-contained mp4.
 *
 * `-ss` sits *before* `-i` so ffmpeg seeks instead of decoding from the top of the
 * file — the difference between a second and minutes on a long film — and `-t`
 * bounds the work to the segment. The video is re-encoded rather than
 * stream-copied: a copy can only cut on a keyframe, which drifts the marks by
 * seconds, and re-encoding is what bounds the size we have to ship. Audio comes
 * along (`0:a:0?`, optional so silent videos still work) because the model
 * listening to the segment is how it knows what not to repeat.
 */
async function cutClip(
	absPath: string,
	start: number,
	duration: number,
	outPath: string
): Promise<void> {
	const args = [
		'-nostdin',
		'-v',
		'error',
		'-y',
		'-ss',
		start.toFixed(3),
		'-i',
		absPath,
		'-t',
		duration.toFixed(3),
		'-map',
		'0:v:0',
		'-map',
		'0:a:0?',
		'-sn',
		'-dn',
		// Never upscale a small source (the quotes are ffmpeg's own filter escaping —
		// there is no shell here).
		'-vf',
		`scale='min(${CLIP_WIDTH},iw)':-2`,
		'-c:v',
		'libx264',
		'-preset',
		'veryfast',
		'-crf',
		'30',
		'-pix_fmt',
		'yuv420p',
		'-c:a',
		'aac',
		'-b:a',
		'64k',
		'-ac',
		'1',
		'-movflags',
		'+faststart',
		outPath
	];

	try {
		await execFileAsync('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
	} catch (err) {
		const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
		console.error('ffmpeg clip extraction failed:', err);
		if (e.code === 'ENOENT') throw new DescribeError('ffmpegMissing');
		if (e.killed) throw new DescribeError('timeout');
		const firstLine = (e.stderr || e.message || '').split('\n').find((l) => l.trim())?.trim();
		throw new DescribeError('ffmpegFailed', firstLine);
	}
}

// ---------------------------------------------------------------------------
// Gemini
// ---------------------------------------------------------------------------

/** Map an SDK/transport failure onto the code the client knows how to explain. */
function classifyApiError(err: unknown): DescribeError {
	if (err instanceof ApiError) {
		const message = concise(err.message);
		switch (err.status) {
			case 400:
				// An unusable key comes back as a 400 API_KEY_INVALID, not a 401.
				return /api.?key/i.test(err.message)
					? new DescribeError('badKey', message)
					: new DescribeError('upstream', message);
			case 401:
			case 403:
				return new DescribeError('badKey', message);
			case 404:
				return new DescribeError('badModel', message);
			case 429:
				// Two very different situations share this status: a rate limit you wait
				// out, and an account with nothing left to spend. Only the message tells
				// them apart, and sending someone to "try again shortly" when they need
				// to top up wastes their afternoon.
				return /credit|billing|quota|exhaust/i.test(err.message)
					? new DescribeError('quota', message)
					: new DescribeError('rateLimited', message);
			default:
				return err.status >= 500
					? new DescribeError('upstream', message)
					: new DescribeError('upstream', message);
		}
	}
	const message = err instanceof Error ? err.message : String(err);
	if (/abort|timeout|ETIMEDOUT/i.test(message)) return new DescribeError('timeout', concise(message));
	if (/fetch failed|ENOTFOUND|ECONNREFUSED|EAI_AGAIN|network/i.test(message)) {
		return new DescribeError('network', concise(message));
	}
	return new DescribeError('server', concise(message));
}

/**
 * A short, readable cause for the UI. Provider errors arrive as a whole JSON body
 * or a long prose sentence, which is noise next to a translated message.
 */
function concise(message: string): string {
	const match = message.match(/"message"\s*:\s*"((?:[^"\\]|\\.)*)"/);
	const text = (match ? match[1].replace(/\\"/g, '"') : message).trim();
	return text.length > 200 ? `${text.slice(0, 197)}…` : text;
}

/**
 * Hand the clip to the model, inline when it is small enough and through the Files
 * API when it is not. Inline is one round trip; an upload is three (upload, wait
 * for PROCESSING to finish, generate), which is worth avoiding when we can.
 */
async function describeClip(options: {
	apiKey: string;
	clipPath: string;
	sizeBytes: number;
	fps: number;
	system: string;
	prompt: string;
}): Promise<string> {
	const { apiKey, clipPath, sizeBytes, fps, system, prompt } = options;
	const ai = new GoogleGenAI({ apiKey });

	let videoPart: { inlineData?: { mimeType: string; data: string }; fileData?: { mimeType: string; fileUri: string }; videoMetadata: { fps: number } };
	let uploadedName: string | undefined;

	if (sizeBytes <= INLINE_MAX_BYTES) {
		const data = await fs.readFile(clipPath);
		videoPart = {
			inlineData: { mimeType: 'video/mp4', data: data.toString('base64') },
			videoMetadata: { fps }
		};
	} else {
		let uploaded;
		try {
			uploaded = await ai.files.upload({ file: clipPath, config: { mimeType: 'video/mp4' } });
		} catch (err) {
			throw classifyApiError(err);
		}
		if (!uploaded.name) throw new DescribeError('uploadFailed', 'the upload returned no file name');
		uploadedName = uploaded.name;

		// An uploaded video is transcoded before it can be referenced; polling is the
		// only signal that it is ready.
		const deadline = Date.now() + FILE_PROCESSING_TIMEOUT_MS;
		let file = uploaded;
		while (file.state === FileState.PROCESSING && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 1000));
			try {
				file = await ai.files.get({ name: uploadedName });
			} catch (err) {
				throw classifyApiError(err);
			}
		}
		if (file.state !== FileState.ACTIVE || !file.uri) {
			await ai.files.delete({ name: uploadedName }).catch(() => {});
			throw new DescribeError(
				file.state === FileState.PROCESSING ? 'timeout' : 'uploadFailed',
				file.error?.message
			);
		}
		videoPart = {
			fileData: { mimeType: file.mimeType ?? 'video/mp4', fileUri: file.uri },
			videoMetadata: { fps }
		};
	}

	try {
		const response = await ai.models.generateContent({
			model: MODEL,
			contents: [{ role: 'user', parts: [videoPart, { text: prompt }] }],
			config: {
				systemInstruction: system,
				maxOutputTokens: 1500,
				// Reading a street sign or a phone screen is the whole point of some
				// descriptions, and that only survives at full media resolution.
				mediaResolution: MediaResolution.MEDIA_RESOLUTION_HIGH,
				// Seeing and describing is perception, not deliberation — and someone is
				// waiting on the answer.
				thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
				httpOptions: { timeout: API_TIMEOUT_MS }
			}
		});

		const blocked = response.promptFeedback?.blockReason;
		const finish = response.candidates?.[0]?.finishReason;
		const text = (response.text ?? '').trim();

		if (!text) {
			if (blocked) throw new DescribeError('refusal', String(blocked));
			if (finish && finish !== 'STOP' && finish !== 'MAX_TOKENS') {
				throw new DescribeError('refusal', String(finish));
			}
			throw new DescribeError('empty');
		}
		return text;
	} catch (err) {
		if (err instanceof DescribeError) throw err;
		throw classifyApiError(err);
	} finally {
		// The upload exists only for this one call; it would otherwise linger for
		// two days on the user's account.
		if (uploadedName) await ai.files.delete({ name: uploadedName }).catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

export interface DescribeOptions {
	/** Media-root-relative path of the video. */
	path: string;
	/** Segment marks, in seconds from the start of the file. */
	start: number;
	end: number;
	/** UI locale, so the description comes back in the language the user reads. */
	language?: string;
}

/**
 * Describe one marked segment. Every failure is a `DescribeResult` with a code the
 * client can localize — the only thing that escapes is a path traversal, which the
 * route turns into a 403 exactly as the other file-touching endpoints do.
 */
export async function describeVideoSegment(options: DescribeOptions): Promise<DescribeResult> {
	const { start, end, language } = options;

	// --- Marks -------------------------------------------------------------
	if (!Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start) {
		return { ok: false, code: 'badRange' };
	}
	const duration = end - start;
	if (duration > MAX_DESCRIBE_SECONDS) {
		return { ok: false, code: 'tooLong' };
	}

	// --- The file ----------------------------------------------------------
	// Canonicalize first: clients send NFC, accented names are often stored NFD,
	// and ffmpeg matches bytes exactly.
	let absPath: string;
	let relPath: string;
	try {
		absPath = resolveExistingPath(options.path);
		relPath = getRelativePath(absPath);
	} catch (err) {
		if (String((err as Error)?.message ?? '').includes('traversal')) throw err;
		return { ok: false, code: 'notFound' };
	}

	if (!isVideoExtension(relPath)) {
		return { ok: false, code: 'notVideo' };
	}

	try {
		if (!(await fs.stat(absPath)).isFile()) return { ok: false, code: 'notFound' };
	} catch {
		return { ok: false, code: 'notFound' };
	}

	// --- The key, before any expensive work --------------------------------
	const apiKey = resolveDescribeKey();
	if (!apiKey) return { ok: false, code: 'noKey' };

	const probe = await ffprobe(absPath);
	if (!probe) {
		return { ok: false, code: 'ffmpegFailed', detail: 'ffprobe could not read the video' };
	}
	const streams = probe.streams ?? [];
	if (!streams.some((s) => s.codec_type === 'video')) {
		return { ok: false, code: 'noVideoStream' };
	}
	const hasAudio = streams.some((s) => s.codec_type === 'audio');
	const fileDuration = Number(probe.format?.duration);
	if (Number.isFinite(fileDuration) && fileDuration > 0 && start >= fileDuration) {
		return { ok: false, code: 'badRange' };
	}

	// --- Cut ---------------------------------------------------------------
	// Local disk: MEDIA_ROOT is a remote mount where creating a file costs ~0.5 s.
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecobox-describe-'));
	const clipPath = path.join(tempDir, 'segment.mp4');
	try {
		try {
			await cutClip(absPath, start, duration, clipPath);
		} catch (err) {
			if (err instanceof DescribeError) return { ok: false, code: err.code, detail: err.detail };
			throw err;
		}

		let sizeBytes = 0;
		try {
			sizeBytes = (await fs.stat(clipPath)).size;
		} catch {
			sizeBytes = 0;
		}
		// ffmpeg exits 0 having written nothing when the marks land past the end of
		// the file — there is no picture there to describe.
		if (sizeBytes === 0) {
			return { ok: false, code: 'emptyClip' };
		}

		// --- Ask ---------------------------------------------------------------
		const fps = planVideoFps(duration);
		try {
			const description = await describeClip({
				apiKey,
				clipPath,
				sizeBytes,
				fps,
				system: buildSystemPrompt(languageName(language), hasAudio),
				prompt: buildUserPrompt({
					fileName: path.basename(relPath, path.extname(relPath)),
					start,
					end
				})
			});
			return {
				ok: true,
				description,
				start,
				end,
				model: MODEL,
				fps,
				clipBytes: sizeBytes,
				hasAudio
			};
		} catch (err) {
			if (err instanceof DescribeError) return { ok: false, code: err.code, detail: err.detail };
			console.error('Video description failed:', err);
			return { ok: false, code: 'server' };
		}
	} finally {
		// The clip was never the point — it exists only for the length of one call.
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
