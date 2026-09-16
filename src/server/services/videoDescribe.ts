/**
 * "What is happening on screen?" — audio description of a marked video segment,
 * produced by Claude from sampled frames and spoken by the listener's screen reader.
 *
 * Ecobox never renders video (see `mediaTypes.ts`): a video file plays through the
 * same `<audio>` element as everything else, which is exactly right for a blind
 * listener until something happens that only the picture carries. This service
 * fills that gap. The user marks a start and an end in the player; the server pulls
 * a run of still frames out of that span with ffmpeg and hands them to the model
 * in order, each labelled with its timestamp.
 *
 * Why frames and not the clip: the Claude API takes images only — there is no
 * `video` content block — and a sequence of labelled stills turns out to be all a
 * description needs. Who is where, what changes, and above all on-screen text all
 * survive; only motion *between* two samples is inferred rather than seen, which is
 * why short marks are sampled every second. The earlier Gemini implementation sent
 * a real clip and was much slower for it: ingesting video dominated the wait,
 * whereas a frame set is answered in a few seconds.
 *
 * Two rules shape the sampling:
 *
 *  - **One frame per second, up to `MAX_DESCRIBE_FRAMES`.** A frame every second is
 *    dense enough to follow an action; beyond the cap the interval stretches so the
 *    whole segment still fits in one request, and the result says so (`sampled`)
 *    so the player can warn that brief moments may have fallen between samples.
 *    Marking a whole film is therefore allowed — it costs the same 50 frames — it is
 *    just a coarser summary.
 *  - **Long spans seek per frame instead of decoding straight through.** ffmpeg's
 *    `fps` filter has to decode every frame it skips, which is ~8 s for 50 minutes
 *    of 720p; fifty independent `-ss` seeks take ~1.5 s however long the span is.
 *
 * Nothing here writes into MEDIA_ROOT: frames go to a temp directory on local disk
 * and are deleted before the call returns.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { env } from '$env/dynamic/private';
import { resolveExistingPath, getRelativePath } from './files';
import { resolveDescribeKey } from './describeKey';
import { getSubtitles } from './subtitles';
import { isVideoExtension } from '$lib/utils/mediaTypes';
import {
	MAX_DESCRIBE_FRAMES,
	type DescribeErrorCode,
	type DescribeResult,
	type SubtitleCue
} from '$lib/types';

const execFileAsync = promisify(execFile);

/** Frame extraction is quick; this is a stuck-process guard. */
const FFMPEG_TIMEOUT_MS = 5 * 60 * 1000;
/** How long we wait on the API before telling the user it timed out. */
const API_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Overridable because model names churn faster than this file does; a wrong name
 * surfaces as `badModel` (a 404), not a mystery failure.
 */
const MODEL = env.CLAUDE_DESCRIBE_MODEL?.trim() || 'claude-opus-5';

/**
 * A description is a sentence to a short paragraph; this is generous headroom, not
 * a target. The request streams, so a large value costs nothing.
 */
const MAX_OUTPUT_TOKENS = 2048;

/**
 * Longest edge of each frame. On-screen text is the one thing a listener cannot
 * get any other way, and it stays legible at this width; the model sees images at
 * up to 2576 px, so nothing is thrown away server-side.
 */
const FRAME_WIDTH = 1280;

/** JPEG quality for ffmpeg's mjpeg encoder (2 = best, 31 = worst). */
const FRAME_QUALITY = '4';

/** How many per-frame seeks run at once on the sparse path. */
const SEEK_POOL = 4;

/**
 * Subtitle text handed to the model as context is capped so a chatty scene cannot
 * crowd out the frames. Cues past the cap are simply dropped.
 */
const MAX_SUBTITLE_CHARS = 4000;

// ---------------------------------------------------------------------------
// Sampling plan (pure)
// ---------------------------------------------------------------------------

export interface FramePlan {
	/** How many frames to extract. */
	count: number;
	/** Seconds between consecutive frames. */
	interval: number;
	/**
	 * True when the segment was longer than the cap allows at one frame per second,
	 * so the interval had to stretch. The player warns the user in that case.
	 */
	sampled: boolean;
}

/**
 * One frame per second, capped at `MAX_DESCRIBE_FRAMES`.
 *
 * Up to the cap the plan is simply "every second" (a 10.4 s mark yields eleven
 * frames, at 0 … 10 s). Past it, the same number of frames is spread evenly over
 * the whole segment, so a five-minute mark is one frame every six seconds and a
 * whole film is still fifty frames — coarser, never refused.
 */
export function planFrames(duration: number): FramePlan {
	if (!(duration > 0)) return { count: 1, interval: 1, sampled: false };
	if (duration <= MAX_DESCRIBE_FRAMES) {
		return { count: Math.max(1, Math.ceil(duration)), interval: 1, sampled: false };
	}
	return { count: MAX_DESCRIBE_FRAMES, interval: duration / MAX_DESCRIBE_FRAMES, sampled: true };
}

/** The timestamps (seconds into the file) a plan samples, starting at `start`. */
export function frameTimes(start: number, plan: FramePlan): number[] {
	return Array.from({ length: plan.count }, (_, i) => start + i * plan.interval);
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
 * be *seen*, never restate what the listener already hears, and read out on-screen
 * text verbatim — it is invisible to the listener and usually load-bearing.
 *
 * The model cannot hear the segment, so "what the listener hears" reaches it only
 * as subtitles, when the file has a sidecar track (`hasSubtitles`). The closing
 * line about XML tags is there because thinking is switched off for this call, and
 * a model with no thinking channel occasionally leaks one into its answer.
 */
export function buildSystemPrompt(language: string, hasSubtitles: boolean): string {
	return [
		'You are writing audio description for a blind or low-vision listener who is playing a video and hearing all of its sound, but cannot see the picture at all.',
		'',
		'You are given still frames sampled in order from one short segment of that video, each labelled with the time it was taken. Treat them as one continuous scene and write the description that belongs in it.',
		'',
		'Rules:',
		'- Describe only what can be SEEN.',
		'- The listener hears every word of dialogue, every sound effect, all the music. Never restate any of it: do not transcribe, quote or paraphrase speech, and do not narrate sounds.',
		hasSubtitles
			? '- The subtitles for the segment are included for context only. They are exactly what the listener already hears: use them to work out who is speaking and what not to say, and never repeat or summarize them.'
			: '- No subtitles are available for this segment, so identify speakers only by what is visible.',
		'- Never mention frames, images, sampling, the clip, the video, or that you were shown anything. Write about the scene itself.',
		'- Use the present tense and plain declarative sentences. No preamble, no sign-off, no headings, no bullet points, no markdown, no emoji: the text is read aloud by a screen reader exactly as written.',
		'- Lead with what matters most: who is on screen, what they are doing, and where. Then the setting, appearance, expressions, body language, and above all what CHANGES as the segment runs — movement, gestures, entrances and exits, and who goes where.',
		'- Read out any text that appears on screen — signs, titles, captions burned into the picture, phone and computer screens, credits — quoting it exactly. That information is invisible to the listener and often carries the point of the shot.',
		'- Mention a cut, a camera move or a scene change only when it changes what the listener needs to know.',
		'- Be concrete and neutral. Do not interpret motives, invent names, guess at the plot, or editorialize about quality.',
		'- Say only what you can actually see. If something is unclear, leave it out rather than guessing.',
		'- Match the length to the segment: one or two sentences for a few seconds, at most a short paragraph for a long one. Every sentence must add something visible.',
		'- Do not include internal or system XML tags in your response.',
		`- Write in ${language}.`
	].join('\n');
}

/** The per-request opening: where in the film this is and how it was sampled. */
export function buildUserPrompt(options: {
	fileName: string;
	start: number;
	end: number;
	plan: FramePlan;
}): string {
	const { fileName, start, end, plan } = options;
	const seconds = Math.max(0, end - start);
	const cadence =
		plan.interval === 1
			? 'one frame per second'
			: `one frame every ${plan.interval.toFixed(1)} seconds`;
	return [
		`This segment is from "${fileName}", running from ${formatTimestamp(start)} to ${formatTimestamp(end)} (${seconds.toFixed(1)} seconds).`,
		`It is shown as ${plan.count} frame${plan.count === 1 ? '' : 's'} in order, ${cadence}, each labelled with its time in the file.`,
		plan.sampled
			? 'The frames are sparse for a segment this long, so describe the scene at the level of what happens overall rather than moment by moment.'
			: ''
	]
		.filter(Boolean)
		.join('\n');
}

/** The closing instruction, after the frames (images work best before the question). */
export function buildClosingPrompt(subtitles: string | null): string {
	return [
		subtitles
			? `Subtitles for this segment, which the listener hears and you must not repeat:\n${subtitles}`
			: '',
		'Describe what is visible across the segment.'
	]
		.filter(Boolean)
		.join('\n\n');
}

/**
 * The cues that overlap the segment, as `[m:ss] text` lines, capped in length.
 * Times are file-relative, the same clock as the marks.
 */
export function subtitleContext(cues: SubtitleCue[], start: number, end: number): string | null {
	const lines: string[] = [];
	let length = 0;
	for (const cue of cues) {
		if (cue.end <= start) continue;
		if (cue.start >= end) break;
		const text = cue.text.replace(/\s+/g, ' ').trim();
		if (!text) continue;
		const line = `[${formatTimestamp(cue.start)}] ${text}`;
		if (length + line.length > MAX_SUBTITLE_CHARS) break;
		lines.push(line);
		length += line.length + 1;
	}
	return lines.length ? lines.join('\n') : null;
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

/** Never upscale a small source (the quotes are ffmpeg's own filter escaping). */
const SCALE_FILTER = `scale='min(${FRAME_WIDTH},iw)':-2`;

function toDescribeError(err: unknown): DescribeError {
	const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
	console.error('ffmpeg frame extraction failed:', err);
	if (e.code === 'ENOENT') return new DescribeError('ffmpegMissing');
	if (e.killed) return new DescribeError('timeout');
	const firstLine = (e.stderr || e.message || '').split('\n').find((l) => l.trim())?.trim();
	return new DescribeError('ffmpegFailed', firstLine);
}

/**
 * Dense path: one decode of the span with the `fps` filter. `-ss` sits *before*
 * `-i` so ffmpeg seeks instead of decoding from the top of the file, `-t` bounds the
 * work to the segment and `-frames:v` pins the count the plan promised. Files are
 * numbered from 1 in sample order.
 */
async function extractDense(absPath: string, start: number, plan: FramePlan, dir: string) {
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
		(plan.count * plan.interval).toFixed(3),
		'-map',
		'0:v:0',
		'-an',
		'-sn',
		'-dn',
		'-vf',
		`fps=1/${plan.interval},${SCALE_FILTER}`,
		'-frames:v',
		String(plan.count),
		'-q:v',
		FRAME_QUALITY,
		path.join(dir, 'f%03d.jpg')
	];
	try {
		await execFileAsync('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
	} catch (err) {
		throw toDescribeError(err);
	}
}

/**
 * Sparse path: an independent seek per frame, a few at a time. Each one lands on
 * the exact timestamp (ffmpeg decodes from the preceding keyframe) and costs the
 * same whether the frames are six seconds or six minutes apart. A seek past the
 * end of the file writes nothing, and that frame is simply absent.
 */
async function extractSparse(absPath: string, times: number[], dir: string) {
	let next = 0;
	async function worker() {
		while (next < times.length) {
			const i = next++;
			const args = [
				'-nostdin',
				'-v',
				'error',
				'-y',
				'-ss',
				times[i].toFixed(3),
				'-i',
				absPath,
				'-map',
				'0:v:0',
				'-an',
				'-sn',
				'-dn',
				'-frames:v',
				'1',
				'-vf',
				SCALE_FILTER,
				'-q:v',
				FRAME_QUALITY,
				path.join(dir, `f${String(i + 1).padStart(3, '0')}.jpg`)
			];
			try {
				await execFileAsync('ffmpeg', args, {
					maxBuffer: 8 * 1024 * 1024,
					timeout: FFMPEG_TIMEOUT_MS
				});
			} catch (err) {
				throw toDescribeError(err);
			}
		}
	}
	await Promise.all(Array.from({ length: Math.min(SEEK_POOL, times.length) }, worker));
}

interface Frame {
	/** Seconds into the file. */
	time: number;
	jpeg: Buffer;
}

/**
 * Extract the planned frames and read them back in sample order. Frames ffmpeg
 * could not produce (marks past the end of the file) are skipped, so the model
 * only ever sees frames that exist.
 */
async function extractFrames(
	absPath: string,
	start: number,
	plan: FramePlan,
	dir: string
): Promise<Frame[]> {
	const times = frameTimes(start, plan);
	if (plan.interval === 1) await extractDense(absPath, start, plan, dir);
	else await extractSparse(absPath, times, dir);

	const frames: Frame[] = [];
	for (let i = 0; i < times.length; i++) {
		const file = path.join(dir, `f${String(i + 1).padStart(3, '0')}.jpg`);
		try {
			const jpeg = await fs.readFile(file);
			if (jpeg.length > 0) frames.push({ time: times[i], jpeg });
		} catch {
			// Not written: nothing there to describe.
		}
	}
	return frames;
}

// ---------------------------------------------------------------------------
// Claude
// ---------------------------------------------------------------------------

/**
 * Map an SDK/transport failure onto the code the client knows how to explain. The
 * SDK's typed classes carry the status; the one ambiguity left is a 400, which is
 * both "malformed request" and "your credit balance is too low".
 */
function classifyApiError(err: unknown): DescribeError {
	if (err instanceof Anthropic.APIConnectionTimeoutError) {
		return new DescribeError('timeout', concise(err.message));
	}
	if (err instanceof Anthropic.APIConnectionError) {
		return new DescribeError('network', concise(err.message));
	}
	if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.PermissionDeniedError) {
		return new DescribeError('badKey', concise(err.message));
	}
	if (err instanceof Anthropic.NotFoundError) {
		return new DescribeError('badModel', concise(err.message));
	}
	if (err instanceof Anthropic.RateLimitError) {
		return new DescribeError('rateLimited', concise(err.message));
	}
	if (err instanceof Anthropic.BadRequestError) {
		return /credit|billing|balance/i.test(err.message)
			? new DescribeError('quota', concise(err.message))
			: new DescribeError('upstream', concise(err.message));
	}
	if (err instanceof Anthropic.APIError) {
		return new DescribeError('upstream', concise(err.message));
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
 * Hand the frames to the model, labelled and in order, and collect the text.
 *
 * Thinking is off: seeing and describing is perception, not deliberation, and
 * someone is waiting. The request streams so a slow answer cannot trip an HTTP
 * timeout, and `fallbacks: 'default'` lets the API re-run a policy decline on a
 * sibling model inside the same call rather than handing the user a refusal.
 */
async function describeFrames(options: {
	apiKey: string;
	frames: Frame[];
	system: string;
	opening: string;
	closing: string;
}): Promise<{ text: string; model: string }> {
	const { apiKey, frames, system, opening, closing } = options;
	const client = new Anthropic({ apiKey, timeout: API_TIMEOUT_MS, maxRetries: 1 });

	const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: 'text', text: opening }];
	for (const frame of frames) {
		content.push({ type: 'text', text: `Frame at ${formatTimestamp(frame.time)}:` });
		content.push({
			type: 'image',
			source: { type: 'base64', media_type: 'image/jpeg', data: frame.jpeg.toString('base64') }
		});
	}
	content.push({ type: 'text', text: closing });

	let message: Anthropic.Beta.BetaMessage;
	try {
		message = await client.beta.messages
			.stream({
				model: MODEL,
				max_tokens: MAX_OUTPUT_TOKENS,
				thinking: { type: 'disabled' },
				system,
				messages: [{ role: 'user', content }],
				betas: ['server-side-fallback-2026-07-01'],
				fallbacks: 'default'
			})
			.finalMessage();
	} catch (err) {
		throw classifyApiError(err);
	}

	if (message.stop_reason === 'refusal') {
		const details = message.stop_details;
		throw new DescribeError('refusal', details?.explanation ?? details?.category ?? undefined);
	}

	const text = message.content
		.filter((block): block is Anthropic.Beta.BetaTextBlock => block.type === 'text')
		.map((block) => block.text)
		.join('\n')
		.trim();
	if (!text) throw new DescribeError('empty', message.stop_reason ?? undefined);
	return { text, model: message.model };
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
	const fileDuration = Number(probe.format?.duration);
	if (Number.isFinite(fileDuration) && fileDuration > 0 && start >= fileDuration) {
		return { ok: false, code: 'badRange' };
	}
	// Marks past the end sample nothing; clamp so the plan reflects real picture.
	const clampedEnd =
		Number.isFinite(fileDuration) && fileDuration > 0 ? Math.min(end, fileDuration) : end;
	const plan = planFrames(clampedEnd - start);

	// --- Subtitles, if the file has a sidecar track ------------------------
	// They are what the listener already hears; a missing or broken track is a
	// missing extra, never a failed description.
	let subtitles: string | null = null;
	try {
		const track = await getSubtitles(relPath);
		if (track) subtitles = subtitleContext(track.cues, start, clampedEnd);
	} catch (err) {
		console.error('Subtitle lookup failed for describe:', err);
	}

	// --- Frames ------------------------------------------------------------
	// Local disk: MEDIA_ROOT may be a remote mount where creating a file costs ~0.5 s.
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecobox-describe-'));
	try {
		let frames: Frame[];
		try {
			frames = await extractFrames(absPath, start, plan, tempDir);
		} catch (err) {
			if (err instanceof DescribeError) return { ok: false, code: err.code, detail: err.detail };
			throw err;
		}
		// ffmpeg exits 0 having written nothing when the marks land past the end of
		// the file — there is no picture there to describe.
		if (frames.length === 0) {
			return { ok: false, code: 'emptyClip' };
		}

		// --- Ask ---------------------------------------------------------------
		try {
			const fileName = path.basename(relPath, path.extname(relPath));
			const { text, model } = await describeFrames({
				apiKey,
				frames,
				system: buildSystemPrompt(languageName(language), subtitles !== null),
				opening: buildUserPrompt({ fileName, start, end: clampedEnd, plan }),
				closing: buildClosingPrompt(subtitles)
			});
			return {
				ok: true,
				description: text,
				start,
				end: clampedEnd,
				model,
				frames: frames.length,
				interval: plan.interval,
				sampled: plan.sampled,
				hasSubtitles: subtitles !== null
			};
		} catch (err) {
			if (err instanceof DescribeError) return { ok: false, code: err.code, detail: err.detail };
			console.error('Video description failed:', err);
			return { ok: false, code: 'server' };
		}
	} finally {
		// The frames were never the point — they exist only for the length of one call.
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}
