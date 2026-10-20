/**
 * Describe the *whole* video — an audio-description track, built chunk by chunk.
 *
 * The segment feature (`videoDescribe.ts`) answers one question about one marked
 * span. This one walks the entire file in `FULL_DESCRIBE_CHUNK_SECONDS` windows
 * (ten seconds, sampled once a second, the last window shorter), asks Claude
 * about each in turn, and stores the answers as timed cues — the same shape as a
 * subtitle track, and the player plays them back the same way, announcing each
 * cue as playback reaches it.
 *
 * What makes it more than a loop over the segment feature is **memory**. Each
 * call is handed a JSON block the model itself wrote after the previous chunk:
 * who has been named and how they look, where the scene is, what was on screen,
 * what is still unresolved — plus the last few descriptions verbatim. The model
 * returns the next description *and* an updated memory (structured output, so
 * the JSON is guaranteed). That is what lets chunk 200 say "Kim" instead of "a
 * blonde woman", say only what *changed* rather than re-describing the room, and
 * notice that the man who left in chunk 12 is back. The listener never hears the
 * memory: only `description` becomes a cue.
 *
 * A run is a background job on the server, not a request: a two-hour film is
 * seven hundred sequential calls. Progress is written to `video_descriptions`
 * after every chunk, so a cancel, a crash or a redeploy loses at most one chunk
 * and the next start resumes from the first missing one. The cues done so far
 * are served (and playable) while the run is still going.
 *
 * The track is also written **next to the video as `<base>.description.vtt`** —
 * a plain WebVTT file (`Kind: descriptions`), rewritten after every chunk. That
 * file is the durable copy: it travels with the video, opens in any player that
 * takes a VTT track, and is read back here when the database has no row for the
 * file (a rebuilt database, a video copied from another install). The subtitle
 * picker knows the `.description` qualifier and never serves it as captions.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import Anthropic from '@anthropic-ai/sdk';
import { eq, or, sql } from 'drizzle-orm';
import { db, schema } from '$server/db';
import { resolveExistingPath, getRelativePath } from './files';
import { hasDescribeCredentials, withDescribeClient } from './describeKey';
import { DESCRIPTION_SIDECAR_SUFFIX, getSubtitles, parseSubtitles } from './subtitles';
import { isVideoExtension } from '$lib/utils/mediaTypes';
import {
	API_TIMEOUT_MS,
	DescribeError,
	MODEL,
	betasFor,
	classifyApiError,
	extractFrames,
	ffprobe,
	formatTimestamp,
	languageName,
	subtitleContext,
	type Frame
} from './videoDescribe';
import {
	FULL_DESCRIBE_CHUNK_SECONDS,
	type DescribeErrorCode,
	type FullDescribeCue,
	type FullDescribeEstimate,
	type FullDescribeState,
	type FullDescribeStatus,
	type SubtitleCue
} from '$lib/types';

/**
 * A description plus the memory is a few hundred tokens; this is headroom. The
 * request streams, so a large value costs nothing.
 */
const MAX_OUTPUT_TOKENS = 4096;

/**
 * A trailing sliver shorter than this is folded into the previous chunk rather
 * than becoming a chunk of its own: half a second of picture is one frame that
 * the previous window already ends on.
 */
const MIN_TAIL_SECONDS = 1;

/**
 * Cost estimate inputs. Output per chunk is a description plus the memory JSON —
 * measured at ~250–400 tokens; the allowance for the memory and the three previous
 * descriptions that later chunks carry in their *input* is likewise measured, not
 * counted, since chunk 0 (the one we count) has none yet.
 */
const OUTPUT_TOKENS_PER_CHUNK = 350;
const MEMORY_ALLOWANCE_TOKENS = 700;
/** Roughly one image token per 750 pixels, the documented rule of thumb. */
const PIXELS_PER_TOKEN = 750;
/** Text tokens per chunk (system prompt, opening, labels) when nothing can be counted. */
const TEXT_TOKENS_PER_CHUNK = 1400;
/** Longest edge frames are scaled to before they are sent (see videoDescribe.ts). */
const ESTIMATE_FRAME_WIDTH = 1280;

/**
 * USD per million tokens, input then output, by model-id prefix (longest match
 * wins). Unknown models get a token count and no price rather than a wrong one.
 */
export const MODEL_PRICES: [prefix: string, input: number, output: number][] = [
	['claude-fable-5', 10, 50],
	['claude-mythos-5', 10, 50],
	['claude-opus-5', 5, 25],
	['claude-opus-4-8', 5, 25],
	['claude-opus-4-7', 5, 25],
	['claude-opus-4-6', 5, 25],
	['claude-sonnet-5', 2, 10],
	['claude-sonnet-4-6', 3, 15],
	['claude-haiku-4-5', 1, 5]
];

export function priceFor(model: string): { input: number; output: number } | null {
	const hit = MODEL_PRICES.filter(([prefix]) => model.startsWith(prefix)).sort(
		(a, b) => b[0].length - a[0].length
	)[0];
	return hit ? { input: hit[1], output: hit[2] } : null;
}

/** Tokens for one frame of `width`×`height` after the send-time downscale. */
export function frameTokens(width: number, height: number): number {
	if (!(width > 0) || !(height > 0)) return 1200;
	const scale = Math.min(1, ESTIMATE_FRAME_WIDTH / width);
	return Math.ceil((width * scale * height * scale) / PIXELS_PER_TOKEN);
}

/** Dollars for a run, or null when the model is not priced. */
export function estimateUsd(model: string, inputTokens: number, outputTokens: number): number | null {
	const price = priceFor(model);
	if (!price) return null;
	return (inputTokens * price.input + outputTokens * price.output) / 1_000_000;
}

/** How many previous descriptions ride along verbatim, on top of the memory. */
const RECENT_DESCRIPTIONS = 3;

/** Bounds on the model-maintained memory, so it cannot grow without limit. */
const MAX_MEMORY_CHARACTERS = 30;
const MAX_MEMORY_LIST = 12;
const MAX_MEMORY_FIELD_CHARS = 300;

/**
 * Transient API failures are retried with a growing pause before the run is
 * declared failed: seven hundred calls will meet a 429 or a blip sooner or later,
 * and giving up on the first one would make long videos impossible.
 */
const RETRY_DELAYS_MS = [15_000, 30_000, 60_000];
const RETRIABLE: ReadonlySet<DescribeErrorCode> = new Set([
	'rateLimited',
	'upstream',
	'network',
	'timeout'
]);

// ---------------------------------------------------------------------------
// Chunk plan (pure)
// ---------------------------------------------------------------------------

export interface Chunk {
	index: number;
	start: number;
	end: number;
}

/**
 * Cut `duration` into consecutive windows of `chunkSeconds`. The last window
 * ends at the duration itself, so it is shorter than the rest unless the file
 * divides evenly; a remainder under `MIN_TAIL_SECONDS` is absorbed by the window
 * before it instead of becoming a one-frame chunk.
 */
export function planChunks(
	duration: number,
	chunkSeconds: number = FULL_DESCRIBE_CHUNK_SECONDS
): Chunk[] {
	if (!(duration > 0) || !(chunkSeconds > 0)) return [];
	const chunks: Chunk[] = [];
	let start = 0;
	while (start < duration) {
		let end = Math.min(start + chunkSeconds, duration);
		const remainder = duration - end;
		if (remainder > 0 && remainder < MIN_TAIL_SECONDS) end = duration;
		chunks.push({ index: chunks.length, start, end });
		start = end;
	}
	return chunks;
}

/** One frame per second across a chunk: 0, 1, … up to (not including) its end. */
export function chunkFrameCount(chunk: Chunk): number {
	return Math.max(1, Math.ceil(chunk.end - chunk.start));
}

// ---------------------------------------------------------------------------
// Memory (pure)
// ---------------------------------------------------------------------------

/**
 * What the model carries from one chunk to the next. It writes this itself and
 * reads it back; the shape is fixed by the structured-output schema below so the
 * server can trim it and never has to parse prose.
 */
export interface SceneMemory {
	/** Where the story is, in one or two sentences. */
	summary: string;
	characters: MemoryCharacter[];
	/** The current location and how it looks. */
	setting: string;
	/** On-screen text seen so far that still matters (titles, signs, messages). */
	onScreenText: string[];
	/** Things begun but not finished that the next description should watch for. */
	openThreads: string[];
}

export interface MemoryCharacter {
	/**
	 * A name only when it has been established (spoken in the subtitles, shown on
	 * screen, or in the credits); otherwise a short stable description that later
	 * chunks keep using, e.g. "the man in the grey suit".
	 */
	name: string;
	appearance: string;
	/** Last thing they were seen doing, and where. */
	lastSeen: string;
}

export const EMPTY_MEMORY: SceneMemory = {
	summary: '',
	characters: [],
	setting: '',
	onScreenText: [],
	openThreads: []
};

function clip(text: unknown, max = MAX_MEMORY_FIELD_CHARS): string {
	const s = typeof text === 'string' ? text.replace(/\s+/g, ' ').trim() : '';
	return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

function clipList(list: unknown, max = MAX_MEMORY_LIST): string[] {
	if (!Array.isArray(list)) return [];
	return list
		.map((item) => clip(item))
		.filter(Boolean)
		.slice(-max);
}

/**
 * Coerce whatever came back into a bounded `SceneMemory`. Structured output makes
 * the shape right; this keeps its *size* right, so a chatty model cannot grow the
 * memory chunk by chunk until it crowds out the frames. Newest entries win.
 */
export function normalizeMemory(raw: unknown): SceneMemory {
	const m = (raw && typeof raw === 'object' ? raw : {}) as Record<string, unknown>;
	const characters = Array.isArray(m.characters)
		? m.characters
				.map((c) => {
					const ch = (c && typeof c === 'object' ? c : {}) as Record<string, unknown>;
					return {
						name: clip(ch.name, 80),
						appearance: clip(ch.appearance),
						lastSeen: clip(ch.lastSeen)
					};
				})
				.filter((c) => c.name)
				.slice(-MAX_MEMORY_CHARACTERS)
		: [];
	return {
		summary: clip(m.summary, 600),
		characters,
		setting: clip(m.setting),
		onScreenText: clipList(m.onScreenText),
		openThreads: clipList(m.openThreads)
	};
}

/** The JSON schema the model's answer must match. */
export const ANSWER_SCHEMA = {
	type: 'object',
	additionalProperties: false,
	required: ['description', 'memory'],
	properties: {
		description: {
			type: 'string',
			description:
				'The audio description for this chunk, exactly as it will be read aloud. Plain sentences, no markup. Empty string only if nothing at all changed on screen.'
		},
		memory: {
			type: 'object',
			additionalProperties: false,
			required: ['summary', 'characters', 'setting', 'onScreenText', 'openThreads'],
			properties: {
				summary: {
					type: 'string',
					description: 'Where the story stands after this chunk, one or two sentences.'
				},
				characters: {
					type: 'array',
					items: {
						type: 'object',
						additionalProperties: false,
						required: ['name', 'appearance', 'lastSeen'],
						properties: {
							name: {
								type: 'string',
								description:
									'Their established name, or the stable descriptive handle used for them so far.'
							},
							appearance: { type: 'string' },
							lastSeen: {
								type: 'string',
								description: 'What they were last seen doing and where, with the time.'
							}
						}
					}
				},
				setting: { type: 'string' },
				onScreenText: { type: 'array', items: { type: 'string' } },
				openThreads: { type: 'array', items: { type: 'string' } }
			}
		}
	}
} as const;

export interface ChunkAnswer {
	description: string;
	memory: SceneMemory;
}

/**
 * Read the model's answer. With structured output on this is a plain parse; the
 * fallbacks exist so that a stray fence or a bare paragraph (a fallback model,
 * say) still yields a description rather than a failed chunk — in that case the
 * memory simply carries over unchanged.
 */
export function parseChunkAnswer(text: string, previous: SceneMemory): ChunkAnswer {
	const candidates = [text.trim()];
	const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
	if (fenced) candidates.push(fenced[1].trim());
	const braces = text.match(/\{[\s\S]*\}/);
	if (braces) candidates.push(braces[0]);
	for (const candidate of candidates) {
		try {
			const parsed = JSON.parse(candidate) as Record<string, unknown>;
			if (parsed && typeof parsed === 'object' && 'description' in parsed) {
				return {
					description: clip(parsed.description, 4000),
					memory: 'memory' in parsed ? normalizeMemory(parsed.memory) : previous
				};
			}
		} catch {
			// try the next shape
		}
	}
	return { description: clip(text, 4000), memory: previous };
}

// ---------------------------------------------------------------------------
// Prompt (pure)
// ---------------------------------------------------------------------------

/**
 * The standing instructions for a chunked run. They carry everything the segment
 * prompt does — only what can be seen, never restate the sound, read on-screen
 * text verbatim — and add what continuity needs: the description is one entry in
 * a running track, so it says what is *new* since the last one, keeps names and
 * handles stable through the memory, and stays short enough to be spoken in the
 * ten seconds it covers.
 */
export function buildFullSystemPrompt(language: string, hasSubtitles: boolean): string {
	return [
		'You are writing the audio description track for a whole video, for a blind or low-vision listener who hears all of its sound but cannot see the picture at all. The video is being walked in consecutive chunks of about ten seconds; you are given the frames of one chunk, sampled once a second, and you write the description that will be read aloud while that chunk plays.',
		'',
		'You also keep a memory. Before the frames you receive a JSON object you wrote after the previous chunk (empty on the first): who has appeared and how they look, where the scene is, what text has been on screen, what is unresolved, and the last few descriptions as they were read out. Use it so the track reads as one continuous narration rather than a series of unrelated snapshots. Return an updated memory with your description.',
		'',
		'Describing:',
		'- Describe only what can be SEEN. Never transcribe, quote, paraphrase or summarize speech, and never narrate sounds or music: the listener hears all of that already.',
		hasSubtitles
			? '- The subtitles for the chunk are included as context only. They are exactly what the listener hears: use them to know who is speaking, to learn names, and to avoid repeating anything, but never restate them.'
			: '- No subtitles are available, so identify speakers only by what is visible.',
		'- Say what is NEW. The listener has just heard the previous description: do not repeat the setting, the clothing or the positions unless they changed. Lead with what changes in this chunk — movement, gestures, expressions, entrances and exits, cuts to a new place — and with anything that appears for the first time.',
		'- When nothing visible has changed since the previous description, say so in a few words or return an empty description; do not pad.',
		'- Read out any text on screen exactly as written: titles, signs, captions burned into the picture, phone and computer screens, letters, credits. That information is invisible to the listener and often carries the point of the shot. Do not read it again in later chunks unless it changes.',
		'- Mention a cut, a camera move or a change of place only when it changes what the listener needs to know.',
		'',
		'Names and continuity:',
		'- Use a name for a person only once it has been established — spoken in the subtitles, shown on screen, or in the credits. Until then, refer to them by a short, stable description ("the man in the grey suit") and keep using exactly that phrase in every later chunk, so the listener can follow one person across the track.',
		'- The moment a name becomes established, record it in the memory against that person, and use it from then on. Never invent or guess a name.',
		'- Keep the memory accurate and compact: a sentence or two of summary, one entry per character who may return, the current setting, on-screen text that still matters, and threads that are open. Drop what is no longer relevant. It is notes for you, not prose for the listener.',
		'',
		'Style:',
		'- Present tense, plain declarative sentences, concrete and neutral. Do not interpret motives, guess at the plot, or editorialize.',
		'- The description is spoken over the chunk it covers, so keep it to what fits in about ten seconds: usually one to three sentences, a little more when a lot changes, nothing when nothing does.',
		'- No preamble, no headings, no bullet points, no markdown, no emoji, and never mention frames, images, sampling, chunks, the memory, or that you were shown anything. Write about the scene itself.',
		'- Do not include internal or system XML tags in your response.',
		`- Write the description in ${language}. The memory may be in any language.`
	].join('\n');
}

/**
 * The context block that opens each chunk's message: where in the file this is,
 * then the memory and the last few descriptions as JSON. JSON, deliberately: the
 * model reads structure back more reliably than it reads its own prose, and the
 * field names double as reminders of what to keep.
 */
export function buildFullUserPrompt(options: {
	fileName: string;
	chunk: Chunk;
	totalChunks: number;
	frameCount: number;
	memory: SceneMemory;
	recent: FullDescribeCue[];
}): string {
	const { fileName, chunk, totalChunks, frameCount, memory, recent } = options;
	const context = {
		memory,
		previousDescriptions: recent.map((cue) => ({
			from: formatTimestamp(cue.start),
			to: formatTimestamp(cue.end),
			text: cue.text
		}))
	};
	return [
		`Video: "${fileName}". This is chunk ${chunk.index + 1} of ${totalChunks}, running from ${formatTimestamp(chunk.start)} to ${formatTimestamp(chunk.end)} (${(chunk.end - chunk.start).toFixed(1)} seconds), shown as ${frameCount} frame${frameCount === 1 ? '' : 's'} in order, one per second, each labelled with its time in the file.`,
		chunk.index === 0
			? 'This is the very first chunk: there is no previous description, so establish the scene — who is there, where, what it looks like — as the opening of the track.'
			: 'Continue the track from the previous description.',
		'',
		'Context (not for the listener):',
		JSON.stringify(context, null, 2)
	].join('\n');
}

/** After the frames: the subtitles for the chunk, then the ask. */
export function buildFullClosingPrompt(subtitles: string | null): string {
	return [
		subtitles
			? `Subtitles for this chunk, which the listener hears and you must not repeat:\n${subtitles}`
			: '',
		'Write the description for this chunk and the updated memory.'
	]
		.filter(Boolean)
		.join('\n\n');
}

// ---------------------------------------------------------------------------
// The sidecar file (pure writer + I/O)
// ---------------------------------------------------------------------------

/** `HH:MM:SS.mmm`, the WebVTT timestamp form. */
export function vttTimestamp(seconds: number): string {
	const total = Math.max(0, seconds);
	const h = Math.floor(total / 3600);
	const m = Math.floor((total % 3600) / 60);
	const sec = total % 60;
	return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${sec.toFixed(3).padStart(6, '0')}`;
}

/**
 * The track as a WebVTT file. `Kind: descriptions` is the header WebVTT defines
 * for exactly this use, `Language` lets an import recover the locale, and empty
 * cues (nothing changed on screen) are left out — a cue with no text is noise to
 * every other player. Text is escaped the way the spec asks so a description
 * containing `<` or `&` round-trips through our own parser and anyone else's.
 */
export function cuesToVtt(cues: FullDescribeCue[], meta: { language: string; title: string }): string {
	const escape = (text: string) =>
		text
			.replace(/&/g, '&amp;')
			.replace(/</g, '&lt;')
			.replace(/>/g, '&gt;')
			.replace(/-->/g, '→')
			.replace(/\r?\n\s*\n/g, '\n')
			.trim();
	const lines = [
		'WEBVTT',
		'Kind: descriptions',
		`Language: ${meta.language}`,
		'',
		`NOTE Audio description of "${meta.title}", written by Ecobox with Claude.`,
		''
	];
	let n = 0;
	for (const cue of cues) {
		const text = escape(cue.text);
		if (!text) continue;
		n++;
		lines.push(String(n), `${vttTimestamp(cue.start)} --> ${vttTimestamp(cue.end)}`, text, '');
	}
	return lines.join('\n');
}

/** The language a sidecar declares, or '' when it has no header. */
export function vttLanguage(text: string): string {
	return text.match(/^Language:\s*(\S+)/m)?.[1].toLowerCase() ?? '';
}

/**
 * `<dir>/<base>.description.vtt` beside the video. Works on the absolute path
 * (for I/O) and on the media-root-relative one (for the client), which is why it
 * keeps the separators it is given instead of joining with the platform's.
 */
export function sidecarPathFor(videoPath: string): string {
	const ext = path.extname(videoPath);
	return `${videoPath.slice(0, videoPath.length - ext.length)}${DESCRIPTION_SIDECAR_SUFFIX}.vtt`;
}

/**
 * Write the sidecar. Best effort: the database row is the run's state, and a
 * read-only folder must not stop a description from being made — it is logged,
 * and the track still plays from the row.
 */
async function writeSidecar(absPath: string, cues: FullDescribeCue[], language: string): Promise<void> {
	if (!cues.some((c) => c.text)) return;
	const title = path.basename(absPath, path.extname(absPath));
	try {
		await fs.writeFile(sidecarPathFor(absPath), cuesToVtt(cues, { language, title }), 'utf8');
	} catch (err) {
		console.error('Could not write description sidecar:', err);
	}
}

async function removeSidecar(absPath: string): Promise<void> {
	await fs.rm(sidecarPathFor(absPath), { force: true }).catch(() => {});
}

/** Read a sidecar back as a finished track, or null when there is none. */
async function readSidecar(absPath: string): Promise<{ cues: FullDescribeCue[]; language: string } | null> {
	let text: string;
	try {
		text = await fs.readFile(sidecarPathFor(absPath), 'utf8');
	} catch {
		return null;
	}
	const cues = parseSubtitles(text, 'vtt').map((c) => ({ start: c.start, end: c.end, text: c.text }));
	return cues.length ? { cues, language: vttLanguage(text) } : null;
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

type Row = typeof schema.videoDescriptions.$inferSelect;

function readRow(relPath: string): Row | null {
	const rows = db
		.select()
		.from(schema.videoDescriptions)
		.where(eq(schema.videoDescriptions.path, relPath))
		.all();
	return rows[0] ?? null;
}

function parseCues(json: string): FullDescribeCue[] {
	try {
		const parsed = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as FullDescribeCue[]) : [];
	} catch {
		return [];
	}
}

function parseMemory(json: string | null): SceneMemory {
	if (!json) return EMPTY_MEMORY;
	try {
		return normalizeMemory(JSON.parse(json));
	} catch {
		return EMPTY_MEMORY;
	}
}

/** In-process registry of live runs; a row says `running` only while one exists. */
const jobs = new Map<string, AbortController>();

function idleStatus(): FullDescribeStatus {
	return {
		state: 'idle',
		language: '',
		totalChunks: 0,
		doneChunks: 0,
		cues: [],
		model: null,
		sidecar: null,
		errorCode: null,
		errorDetail: null
	};
}

/** A finished track read from the sidecar alone — no row, so no chunk count but the cues. */
function importedStatus(relPath: string, track: { cues: FullDescribeCue[]; language: string }): FullDescribeStatus {
	return {
		state: 'done',
		language: track.language,
		totalChunks: track.cues.length,
		doneChunks: track.cues.length,
		cues: track.cues,
		model: null,
		sidecar: sidecarPathFor(relPath),
		errorCode: null,
		errorDetail: null
	};
}

function rowToStatus(row: Row | null): FullDescribeStatus {
	if (!row) return idleStatus();
	// A row left `running` by a crash or a redeploy has no job behind it: report
	// it as paused, which is what it is — resumable from where it stopped.
	let state = row.status as FullDescribeState;
	if (state === 'running' && !jobs.has(row.path)) state = 'paused';
	return {
		state,
		language: row.language,
		totalChunks: row.totalChunks,
		doneChunks: row.doneChunks,
		cues: parseCues(row.cues),
		model: row.model,
		sidecar: row.doneChunks > 0 ? sidecarPathFor(row.path) : null,
		errorCode: state === 'failed' ? ((row.errorCode as DescribeErrorCode | null) ?? 'server') : null,
		errorDetail: state === 'failed' ? row.errorDetail : null
	};
}

function setStatus(relPath: string, status: FullDescribeState, code?: string, detail?: string) {
	db.update(schema.videoDescriptions)
		.set({
			status,
			errorCode: code ?? null,
			errorDetail: detail ?? null,
			updatedAt: new Date()
		})
		.where(eq(schema.videoDescriptions.path, relPath))
		.run();
}

// ---------------------------------------------------------------------------
// The model call
// ---------------------------------------------------------------------------

async function describeChunk(options: {
	frames: Frame[];
	system: string;
	opening: string;
	closing: string;
	memory: SceneMemory;
	signal: AbortSignal;
}): Promise<{ answer: ChunkAnswer; model: string }> {
	const { frames, system, opening, closing, memory, signal } = options;

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
		message = await withDescribeClient(
			(client, auth) =>
				client.beta.messages
					.stream(
						{
							model: MODEL,
							max_tokens: MAX_OUTPUT_TOKENS,
							// As for a segment: seeing is perception, not deliberation, and the
							// structured answer leaves nothing for a leaked tag to land in.
							thinking: { type: 'disabled' },
							system,
							messages: [{ role: 'user', content }],
							output_config: { format: { type: 'json_schema', schema: ANSWER_SCHEMA } },
							betas: betasFor(auth),
							fallbacks: 'default'
						},
						{ signal }
					)
					.finalMessage(),
			{ timeout: API_TIMEOUT_MS, maxRetries: 1 }
		);
	} catch (err) {
		if (signal.aborted) throw new DescribeError('timeout', 'cancelled');
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
	return { answer: parseChunkAnswer(text, memory), model: message.model };
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve) => {
		const timer = setTimeout(done, ms);
		function done() {
			signal.removeEventListener('abort', done);
			clearTimeout(timer);
			resolve();
		}
		signal.addEventListener('abort', done, { once: true });
	});
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Walk the chunks from `row.doneChunks`, one model call each, persisting after
 * every chunk. Runs detached from any request; its outcome is the row's status.
 */
async function runJob(relPath: string, absPath: string, controller: AbortController) {
	const { signal } = controller;
	try {
		const row = readRow(relPath);
		if (!row) return;
		const chunks = planChunks(row.duration, row.chunkSeconds);
		const cues = parseCues(row.cues);
		let memory = parseMemory(row.memory);
		const language = languageName(row.language);
		const fileName = path.basename(relPath, path.extname(relPath));

		// The subtitle track once, sliced per chunk: what the listener hears.
		let subtitleCues: SubtitleCue[] = [];
		try {
			const track = await getSubtitles(relPath);
			if (track) subtitleCues = track.cues;
		} catch (err) {
			console.error('Subtitle lookup failed for full describe:', err);
		}
		const system = buildFullSystemPrompt(language, subtitleCues.length > 0);

		if (!hasDescribeCredentials()) {
			setStatus(relPath, 'failed', 'noKey');
			return;
		}

		for (let i = row.doneChunks; i < chunks.length; i++) {
			if (signal.aborted) {
				setStatus(relPath, 'paused');
				return;
			}
			const chunk = chunks[i];
			const frameCount = chunkFrameCount(chunk);
			const subtitles = subtitleContext(subtitleCues, chunk.start, chunk.end);

			// Frames on local disk, gone before the next chunk starts.
			const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecobox-describe-full-'));
			let outcome: { answer: ChunkAnswer; model: string } | null = null;
			try {
				const frames = await extractFrames(
					absPath,
					chunk.start,
					{ count: frameCount, interval: 1, sampled: false },
					tempDir
				);
				if (frames.length === 0) {
					// Past the picture (a container whose duration overstates its video):
					// nothing to describe here, and nothing further along either.
					cues.push({ start: chunk.start, end: chunk.end, text: '' });
					persistProgress(relPath, i + 1, cues, memory, null);
					continue;
				}

				const opening = buildFullUserPrompt({
					fileName,
					chunk,
					totalChunks: chunks.length,
					frameCount: frames.length,
					memory,
					recent: cues.filter((c) => c.text).slice(-RECENT_DESCRIPTIONS)
				});
				const closing = buildFullClosingPrompt(subtitles);

				for (let attempt = 0; ; attempt++) {
					try {
						outcome = await describeChunk({
							frames,
							system,
							opening,
							closing,
							memory,
							signal
						});
						break;
					} catch (err) {
						if (signal.aborted) throw err;
						const failure = err instanceof DescribeError ? err : new DescribeError('server');
						if (!RETRIABLE.has(failure.code) || attempt >= RETRY_DELAYS_MS.length) throw failure;
						console.warn(
							`Full describe: chunk ${i} ${failure.code}, retrying in ${RETRY_DELAYS_MS[attempt] / 1000}s`
						);
						await sleep(RETRY_DELAYS_MS[attempt], signal);
						if (signal.aborted) throw new DescribeError('timeout', 'cancelled');
					}
				}
			} finally {
				await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
			}

			if (!outcome) continue;
			memory = outcome.answer.memory;
			cues.push({ start: chunk.start, end: chunk.end, text: outcome.answer.description });
			persistProgress(relPath, i + 1, cues, memory, outcome.model);
			// The durable copy, kept current so a stop at any point leaves a usable file.
			await writeSidecar(absPath, cues, row.language);
		}

		setStatus(relPath, 'done');
	} catch (err) {
		if (signal.aborted) {
			setStatus(relPath, 'paused');
			return;
		}
		const failure = err instanceof DescribeError ? err : null;
		console.error('Full video description failed:', err);
		setStatus(relPath, 'failed', failure?.code ?? 'server', failure?.detail);
	} finally {
		if (jobs.get(relPath) === controller) jobs.delete(relPath);
	}
}

function persistProgress(
	relPath: string,
	doneChunks: number,
	cues: FullDescribeCue[],
	memory: SceneMemory,
	model: string | null
) {
	db.update(schema.videoDescriptions)
		.set({
			doneChunks,
			cues: JSON.stringify(cues),
			memory: JSON.stringify(memory),
			...(model ? { model } : {}),
			updatedAt: new Date()
		})
		.where(eq(schema.videoDescriptions.path, relPath))
		.run();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/** Resolve a client path to its on-disk file, or the code that says why not. */
function locate(
	relInput: string
): { absPath: string; relPath: string } | { code: DescribeErrorCode } {
	let absPath: string;
	let relPath: string;
	try {
		absPath = resolveExistingPath(relInput);
		relPath = getRelativePath(absPath);
	} catch (err) {
		if (String((err as Error)?.message ?? '').includes('traversal')) throw err;
		return { code: 'notFound' };
	}
	if (!isVideoExtension(relPath)) return { code: 'notVideo' };
	return { absPath, relPath };
}

/**
 * The stored track and progress for `relInput` (idle when there is none). With
 * no row but a sidecar on disk — a rebuilt database, a video that arrived with
 * its `.description.vtt` — the file is the track, reported as done.
 */
export async function getFullDescription(relInput: string): Promise<FullDescribeStatus> {
	const located = locate(relInput);
	if ('code' in located) return idleStatus();
	const row = readRow(located.relPath);
	if (row) return rowToStatus(row);
	const imported = await readSidecar(located.absPath);
	return imported ? importedStatus(located.relPath, imported) : idleStatus();
}

export type StartResult = { ok: true; status: FullDescribeStatus } | { ok: false; code: DescribeErrorCode; detail?: string };

/**
 * Start — or resume — describing the whole of `relInput` in `language`.
 *
 * An existing row for the same file (same size and mtime) is continued from its
 * first missing chunk, whatever state it was left in; `restart` throws it away
 * first. A row for a different version of the file is always replaced. A run
 * already going is left alone and its status returned.
 */
export async function startFullDescription(options: {
	path: string;
	language: string;
	restart?: boolean;
}): Promise<StartResult> {
	const located = locate(options.path);
	if ('code' in located) return { ok: false, code: located.code };
	const { absPath, relPath } = located;

	let stat;
	try {
		stat = await fs.stat(absPath);
		if (!stat.isFile()) return { ok: false, code: 'notFound' };
	} catch {
		return { ok: false, code: 'notFound' };
	}

	if (jobs.has(relPath)) return { ok: true, status: rowToStatus(readRow(relPath)) };

	// Credentials before any expensive work — and before writing a row that would
	// otherwise sit there `failed` for the lack of them.
	if (!hasDescribeCredentials()) return { ok: false, code: 'noKey' };

	const existing = readRow(relPath);
	const size = stat.size;
	const mtime = Math.floor(stat.mtimeMs);
	const sameFile = existing && existing.size === size && existing.mtime === mtime;
	const language = (options.language || 'en').toLowerCase();

	if (!existing && !options.restart) {
		const imported = await readSidecar(absPath);
		if (imported) return { ok: true, status: importedStatus(relPath, imported) };
	}

	if (!existing || !sameFile || options.restart || existing.language !== language) {
		await removeSidecar(absPath);
		const probe = await ffprobe(absPath);
		if (!probe) return { ok: false, code: 'ffmpegFailed', detail: 'ffprobe could not read the video' };
		if (!(probe.streams ?? []).some((s) => s.codec_type === 'video')) {
			return { ok: false, code: 'noVideoStream' };
		}
		const duration = Number(probe.format?.duration);
		if (!Number.isFinite(duration) || duration <= 0) {
			return { ok: false, code: 'emptyClip' };
		}
		const chunks = planChunks(duration);
		db.insert(schema.videoDescriptions)
			.values({
				path: relPath,
				language,
				size,
				mtime,
				duration,
				chunkSeconds: FULL_DESCRIBE_CHUNK_SECONDS,
				totalChunks: chunks.length,
				doneChunks: 0,
				status: 'running',
				cues: '[]',
				memory: null,
				model: null,
				updatedAt: new Date()
			})
			.onConflictDoUpdate({
				target: schema.videoDescriptions.path,
				set: {
					language,
					size,
					mtime,
					duration,
					chunkSeconds: FULL_DESCRIBE_CHUNK_SECONDS,
					totalChunks: chunks.length,
					doneChunks: 0,
					status: 'running',
					errorCode: null,
					errorDetail: null,
					cues: '[]',
					memory: null,
					model: null,
					updatedAt: new Date()
				}
			})
			.run();
	} else if (existing.status === 'done') {
		return { ok: true, status: rowToStatus(existing) };
	} else {
		setStatus(relPath, 'running');
	}

	const controller = new AbortController();
	jobs.set(relPath, controller);
	// Detached on purpose: the request that started the run returns at once, and
	// the client polls `GET` for progress.
	void runJob(relPath, absPath, controller);
	return { ok: true, status: rowToStatus(readRow(relPath)) };
}

/**
 * What describing the whole of `relInput` would cost. The first chunk's frames
 * are extracted for real and sent to the token counter (free), which is exact for
 * this file's resolution and the prompt as written; later chunks' memory and
 * previous descriptions are added as a measured allowance. With no credential, or
 * a counter that fails, the frame size gives a rougher figure (`exact: false`).
 */
export async function estimateFullDescription(options: {
	path: string;
	language: string;
}): Promise<{ ok: true; estimate: FullDescribeEstimate } | { ok: false; code: DescribeErrorCode; detail?: string }> {
	const located = locate(options.path);
	if ('code' in located) return { ok: false, code: located.code };
	const { absPath, relPath } = located;

	const probe = await ffprobe(absPath);
	if (!probe) return { ok: false, code: 'ffmpegFailed', detail: 'ffprobe could not read the video' };
	const video = (probe.streams ?? []).find((s) => s.codec_type === 'video');
	if (!video) return { ok: false, code: 'noVideoStream' };
	const duration = Number(probe.format?.duration);
	if (!Number.isFinite(duration) || duration <= 0) return { ok: false, code: 'emptyClip' };

	const chunks = planChunks(duration);
	const frames = chunks.reduce((n, c) => n + chunkFrameCount(c), 0);
	const perFrame = frameTokens(video.width ?? 0, video.height ?? 0);
	const rough = (): FullDescribeEstimate => {
		const inputTokens = frames * perFrame + chunks.length * (TEXT_TOKENS_PER_CHUNK + MEMORY_ALLOWANCE_TOKENS);
		const outputTokens = chunks.length * OUTPUT_TOKENS_PER_CHUNK;
		return {
			chunks: chunks.length,
			frames,
			model: MODEL,
			inputTokens,
			outputTokens,
			usd: estimateUsd(MODEL, inputTokens, outputTokens),
			exact: false
		};
	};
	if (!hasDescribeCredentials()) return { ok: true, estimate: rough() };

	// Count the first chunk for real: its frames, the prompt, its subtitles.
	const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecobox-describe-estimate-'));
	try {
		const first = chunks[0];
		const firstFrames = await extractFrames(
			absPath,
			first.start,
			{ count: chunkFrameCount(first), interval: 1, sampled: false },
			tempDir
		);
		if (firstFrames.length === 0) return { ok: true, estimate: rough() };

		let subtitleCues: SubtitleCue[] = [];
		try {
			const track = await getSubtitles(relPath);
			if (track) subtitleCues = track.cues;
		} catch {
			// no subtitles is the common case
		}
		const fileName = path.basename(relPath, path.extname(relPath));
		const system = buildFullSystemPrompt(languageName(options.language), subtitleCues.length > 0);
		const opening = buildFullUserPrompt({
			fileName,
			chunk: first,
			totalChunks: chunks.length,
			frameCount: firstFrames.length,
			memory: EMPTY_MEMORY,
			recent: []
		});
		const closing = buildFullClosingPrompt(subtitleContext(subtitleCues, first.start, first.end));
		const content: Anthropic.Beta.BetaContentBlockParam[] = [{ type: 'text', text: opening }];
		for (const frame of firstFrames) {
			content.push({ type: 'text', text: `Frame at ${formatTimestamp(frame.time)}:` });
			content.push({
				type: 'image',
				source: { type: 'base64', media_type: 'image/jpeg', data: frame.jpeg.toString('base64') }
			});
		}
		content.push({ type: 'text', text: closing });

		const counted = await withDescribeClient(
			(client, auth) =>
				client.beta.messages.countTokens({
					model: MODEL,
					system,
					messages: [{ role: 'user', content }],
					...(auth === 'token' ? { betas: ['oauth-2025-04-20'] } : {})
				}),
			{ timeout: 60_000, maxRetries: 1 }
		);
		// A full chunk's worth, scaled by frame count for the (shorter) last chunk.
		const textTokens = Math.max(0, counted.input_tokens - firstFrames.length * perFrame);
		const countedPerFrame = firstFrames.length > 0 ? (counted.input_tokens - textTokens) / firstFrames.length : perFrame;
		const inputTokens = Math.round(
			frames * countedPerFrame + chunks.length * (textTokens + MEMORY_ALLOWANCE_TOKENS)
		);
		const outputTokens = chunks.length * OUTPUT_TOKENS_PER_CHUNK;
		return {
			ok: true,
			estimate: {
				chunks: chunks.length,
				frames,
				model: MODEL,
				inputTokens,
				outputTokens,
				usd: estimateUsd(MODEL, inputTokens, outputTokens),
				exact: true
			}
		};
	} catch (err) {
		console.error('Description estimate could not count tokens, using the rough figure:', err);
		return { ok: true, estimate: rough() };
	} finally {
		await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Stop a live run, keeping what it produced. No-op when nothing is running. */
export function cancelFullDescription(relInput: string): FullDescribeStatus {
	const located = locate(relInput);
	if ('code' in located) return rowToStatus(null);
	const controller = jobs.get(located.relPath);
	if (controller) {
		controller.abort();
		jobs.delete(located.relPath);
		setStatus(located.relPath, 'paused');
	}
	return rowToStatus(readRow(located.relPath));
}

/** Forget the track entirely — row and sidecar — stopping it first if it is running. */
export async function deleteFullDescription(relInput: string): Promise<void> {
	const located = locate(relInput);
	if ('code' in located) return;
	jobs.get(located.relPath)?.abort();
	jobs.delete(located.relPath);
	db.delete(schema.videoDescriptions).where(eq(schema.videoDescriptions.path, located.relPath)).run();
	await removeSidecar(located.absPath);
}

/**
 * Drop tracks for a deleted path: the file itself, or everything under a deleted
 * folder. Mirrors the book-bookmark purge in the files DELETE handler; LIKE
 * wildcards in the folder name are escaped so they cannot widen the match.
 */
export function purgeFullDescriptionsForPath(relPath: string): void {
	const p = relPath.normalize('NFC');
	const esc = p.replace(/[\\%_]/g, (c) => '\\' + c);
	for (const [key, controller] of jobs) {
		if (key === p || key.startsWith(p + '/')) {
			controller.abort();
			jobs.delete(key);
		}
	}
	db.delete(schema.videoDescriptions)
		.where(
			or(
				eq(schema.videoDescriptions.path, p),
				sql`${schema.videoDescriptions.path} LIKE ${esc + '/%'} ESCAPE '\\'`
			)
		)
		.run();
}
