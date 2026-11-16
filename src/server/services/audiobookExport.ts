/**
 * "Convert to audio": turn a converted book (`.BOOK` folder) into one MP3 next to
 * it, read by a server-side TTS service, with a chapter per heading. The book is
 * never touched.
 *
 * Shape of a run:
 *  1. Plan — the reader's own units (`planExport`), from the start or from the
 *     saved reading position.
 *  2. Synthesize each unit through `synthesizeCached` — the reader's path, so
 *     audio the user already listened to is reused, and (for billed services) every
 *     new unit is cached: a run that stops half-way resumes without paying again.
 *     Every unit is cached, so units already synthesized with the same service,
 *     voice, model, settings and (for ELF/Piper) speed are reused, by the reader
 *     and by a stopped export that is started again.
 *  3. Decode each unit to PCM (s16le mono 44.1 kHz) and stream it, in order, into
 *     ONE long-running encoder. Counting PCM bytes gives every chapter its exact
 *     start time; short silences go between paragraphs and before headings so the
 *     result breathes like the reader does.
 *  4. Mux the chapters in (ID3 CHAP frames, which `id3chapters.ts` reads back) with
 *     a stream copy, then copy the file across to the book's folder under a hidden
 *     name and rename it into place — MEDIA_ROOT is a slow remote mount, and a
 *     half-written file must never show up as a row.
 *
 * Jobs run one at a time (a book is hours of provider calls; two at once would
 * just share a rate limit) and live in memory. A restart loses the queue, but the
 * cache keeps what was paid for.
 */
import { spawn } from 'child_process';
import fs from 'fs/promises';
import path from 'path';
import { env } from '$env/dynamic/private';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import { resolveExistingPath, getRelativePath, isBookFolder } from './files';
import { TtsError, getQuota, listVoices } from './tts';
import { resolveCredential, getCredentialRow } from './tts/credentials';
import { synthesizeCached, isCached, type CachedSynthInput } from './tts/synthesizeCached';
import {
	planExport,
	chapterAt,
	positionPercent,
	hasReadingPosition,
	exportFileName,
	uniqueFileName,
	exceedsQuota,
	buildFfmetadata,
	type ExportPlan,
	type PlannedUnit
} from '$lib/utils/audiobookPlan';
import {
	TTS_AUDIO_SERVICES,
	TTS_KEYLESS_SERVICES,
	DEFAULT_ELF_VOICE_PARAMS,
	bakesRate,
	type AudiobookErrorCode,
	type AudiobookEstimate,
	type AudiobookJobStatus,
	type AudiobookScope,
	type BookContent,
	type ElfVoiceParams,
	type TtsAudioService,
	type TtsQuota
} from '$lib/types';

// ---------------------------------------------------------------------------
// Errors

export class AudiobookError extends Error {
	code: AudiobookErrorCode;
	detail: string | null;
	constructor(code: AudiobookErrorCode, detail?: string | null) {
		super(detail || code);
		this.name = 'AudiobookError';
		this.code = code;
		this.detail = detail ?? null;
	}
}

/** HTTP statuses a provider may answer once and not the next time. */
const TRANSIENT = new Set([429, 502, 503, 504]);

/** Map a provider failure to an export error code. Pure — unit-tested. */
export function classifyTtsFailure(err: unknown): { code: AudiobookErrorCode; transient: boolean; detail: string | null } {
	if (err instanceof AudiobookError) return { code: err.code, transient: false, detail: err.detail };
	if (err instanceof TtsError) {
		const detail = err.message || null;
		if (err.status === 401) return { code: 'badKey', transient: false, detail };
		if (err.status === 402) return { code: 'quotaExceeded', transient: false, detail };
		if (err.status === 503) return { code: 'unreachable', transient: true, detail };
		if (TRANSIENT.has(err.status)) return { code: 'upstream', transient: true, detail };
		// 400 / 404 / 500: missing key, voice, engine — retrying won't fix it.
		return { code: 'misconfigured', transient: false, detail };
	}
	// A thrown fetch / socket error: the network, most likely.
	return { code: 'unreachable', transient: true, detail: err instanceof Error ? err.message : null };
}

// ---------------------------------------------------------------------------
// Configuration

/** Pauses before each retry of a transient failure. */
export const RETRY_DELAYS_MS = [5_000, 15_000, 45_000];

/** Units synthesized ahead of the encoder, per service (provider concurrency limits). */
const WINDOW: Record<TtsAudioService, number> = {
	elevenlabs: 2,
	azure: 3,
	'azure-edge': 2,
	google: 3,
	elf: 4,
	piper: 2,
	phonon: 1
};

const SAMPLE_RATE = 44_100;
const BYTES_PER_SECOND = SAMPLE_RATE * 2; // s16le mono
const PARAGRAPH_GAP_S = 0.25;
const HEADING_GAP_S = 0.9;
const BITRATE = '96k';
/** How often (units) the provider quota is re-read during a run. */
const QUOTA_REFRESH_UNITS = 25;

function workRoot(): string {
	if (env.AUDIOBOOK_WORK_DIR) return env.AUDIOBOOK_WORK_DIR;
	const dbPath = env.DATABASE_URL?.replace('file:', '') || './data/ecobox.db';
	return path.join(path.dirname(dbPath), 'audiobook-work');
}

function isAudioService(s: unknown): s is TtsAudioService {
	return typeof s === 'string' && (TTS_AUDIO_SERVICES as string[]).includes(s);
}

/** Billed per character: cloud services that need a key. */
export function isBilled(service: TtsAudioService): boolean {
	return !TTS_KEYLESS_SERVICES.includes(service);
}

// ---------------------------------------------------------------------------
// Book + voice resolution (shared by estimate and run)

interface LoadedBook {
	relPath: string;
	absPath: string;
	bookName: string;
	content: BookContent;
	position: number | null;
}

async function loadBook(rawPath: string): Promise<LoadedBook> {
	let absPath: string;
	try {
		absPath = resolveExistingPath(rawPath);
	} catch (err) {
		if (err instanceof Error && err.message.includes('traversal')) throw err;
		throw new AudiobookError('notBook');
	}
	if (!(await isBookFolder(absPath))) throw new AudiobookError('notBook');
	let content: BookContent;
	try {
		content = JSON.parse(await fs.readFile(path.join(absPath, 'book.chunks.json'), 'utf-8'));
	} catch {
		throw new AudiobookError('notBook', 'book.chunks.json is missing or unreadable');
	}
	if (!Array.isArray(content.chunks) || !content.chunks.some((c) => c.text?.trim())) {
		throw new AudiobookError('empty');
	}
	const relPath = getRelativePath(absPath);
	const meta = await db.query.bookMetadata.findFirst({
		where: eq(schema.bookMetadata.bookFolderPath, relPath.normalize('NFC'))
	});
	const idx = meta?.currentChunkIndex ?? null;
	return {
		relPath,
		absPath,
		bookName: path.basename(absPath),
		content,
		position: hasReadingPosition(idx, content.chunks.length) ? idx : null
	};
}

interface VoiceConfig {
	voiceId: string;
	voiceName: string | null;
	model?: string;
	voiceSettings?: CachedSynthInput['voiceSettings'];
	elfParams?: ElfVoiceParams;
	rate?: number;
}

/**
 * The voice the reader would use: the one saved for the service, else the first
 * listed voice in the book's language (the reader's own fallback), else any.
 */
async function resolveVoice(service: TtsAudioService, locale: string, rate: number): Promise<VoiceConfig> {
	const cred = await resolveCredential(service);
	let voices: { id: string; name: string; lang: string }[] = [];
	try {
		voices = await listVoices(service, locale);
	} catch (err) {
		// Listing exercises the key; a provider that can't list will not synthesize either.
		if (!cred.voiceId) throw err;
	}
	let voiceId = cred.voiceId;
	if (!voiceId) {
		const primary = (locale || 'en').toLowerCase().split('-')[0];
		const match =
			voices.find((v) => v.lang.toLowerCase() === locale.toLowerCase()) ??
			voices.find((v) => v.lang.toLowerCase().split(/[-_]/)[0] === primary) ??
			voices[0];
		if (!match) throw new AudiobookError('noVoice');
		voiceId = match.id;
	}
	const voiceName = voices.find((v) => v.id === voiceId)?.name ?? null;

	let elfParams: ElfVoiceParams | undefined;
	if (service === 'elf') {
		const row = await getCredentialRow('elf');
		if (row?.elfCustomize) {
			elfParams = {
				headSize: row.elfHeadSize ?? DEFAULT_ELF_VOICE_PARAMS.headSize,
				pitch: row.elfPitch ?? DEFAULT_ELF_VOICE_PARAMS.pitch,
				inflection: row.elfInflection ?? DEFAULT_ELF_VOICE_PARAMS.inflection,
				roughness: row.elfRoughness ?? DEFAULT_ELF_VOICE_PARAMS.roughness,
				breathiness: row.elfBreathiness ?? DEFAULT_ELF_VOICE_PARAMS.breathiness,
				volume: row.elfVolume ?? DEFAULT_ELF_VOICE_PARAMS.volume
			};
		}
	}
	return {
		voiceId,
		voiceName,
		model: cred.model || undefined,
		voiceSettings: service === 'elevenlabs' ? cred.voiceSettings : undefined,
		elfParams,
		// Baked-rate engines (ELF, Piper) synthesize AT a speed, so the export uses
		// the reading speed — the same key the reader caches under, which is what
		// lets an export reuse audio already heard. Stretch services have no speed
		// in their audio (the player stretches), so the file is at normal speed.
		rate: bakesRate(service) ? rate : undefined
	};
}

function unitInput(
	service: TtsAudioService,
	voice: VoiceConfig,
	book: LoadedBook,
	u: PlannedUnit
): CachedSynthInput {
	const isEleven = service === 'elevenlabs';
	return {
		service,
		voiceId: voice.voiceId,
		text: u.text,
		lang: book.content.locale || 'en',
		model: voice.model,
		voiceSettings: voice.voiceSettings,
		elfParams: voice.elfParams,
		rate: voice.rate,
		previousText: isEleven ? u.previousText : undefined,
		nextText: isEleven ? u.nextText : undefined,
		bookPath: book.relPath,
		// Cache every unit, local engines included: a stopped run then resumes
		// where it was, and the reader gets the audio for free too.
		store: true
	};
}

/** Characters that are not already sitting in the TTS cache. */
async function billableChars(plan: ExportPlan, inputs: (u: PlannedUnit) => CachedSynthInput): Promise<number> {
	let n = 0;
	for (const u of plan.units) {
		if (!u.text.trim()) continue;
		if (!(await isCached(inputs(u)))) n += u.text.length;
	}
	return n;
}

async function readQuota(service: TtsAudioService): Promise<TtsQuota | null> {
	try {
		return await getQuota(service);
	} catch (err) {
		const c = classifyTtsFailure(err);
		throw new AudiobookError(c.code, c.detail);
	}
}

/** The reader's speed multiplier, clamped to the reader's own range; 1 when absent. */
export function parseRate(rate: unknown): number {
	const n = typeof rate === 'number' ? rate : Number(rate);
	if (!Number.isFinite(n) || n <= 0) return 1;
	return Math.max(0.5, Math.min(5, n));
}

function parseService(service: unknown): TtsAudioService {
	if (service === 'webspeech') throw new AudiobookError('clientOnly');
	if (!isAudioService(service)) throw new AudiobookError('misconfigured', 'Unknown TTS service');
	return service;
}

// ---------------------------------------------------------------------------
// Estimate

export async function estimateAudiobook(
	rawPath: string,
	rawService: unknown,
	rawRate?: unknown
): Promise<AudiobookEstimate> {
	const service = parseService(rawService);
	const rate = parseRate(rawRate);
	const book = await loadBook(rawPath);
	let voice: VoiceConfig;
	try {
		voice = await resolveVoice(service, book.content.locale, rate);
	} catch (err) {
		const c = classifyTtsFailure(err);
		throw new AudiobookError(c.code, c.detail);
	}
	const inputs = (u: PlannedUnit) => unitInput(service, voice, book, u);
	const chunks = book.content.chunks;

	const wholePlan = planExport(chunks, 0);
	const whole: AudiobookScope = {
		chars: wholePlan.chars,
		billableChars: await billableChars(wholePlan, inputs),
		fileName: exportFileName(book.bookName)
	};

	let fromPosition: AudiobookEstimate['fromPosition'] = null;
	if (book.position !== null) {
		const plan = planExport(chunks, book.position);
		const percent = positionPercent(book.position, chunks.length);
		fromPosition = {
			chars: plan.chars,
			billableChars: await billableChars(plan, inputs),
			fileName: exportFileName(book.bookName, percent),
			chunkIndex: book.position,
			percent,
			chapter: chapterAt(chunks, book.position)
		};
	}

	return {
		service,
		voiceId: voice.voiceId,
		voiceName: voice.voiceName,
		bookName: book.bookName,
		whole,
		fromPosition,
		billed: isBilled(service),
		rate: bakesRate(service) ? rate : null,
		quota: await readQuota(service)
	};
}

// ---------------------------------------------------------------------------
// Jobs

interface Job {
	status: AudiobookJobStatus;
	service: TtsAudioService;
	rate: number;
	fromPosition: boolean;
	abort: AbortController;
	finishedAt?: number;
}

const jobs = new Map<string, Job>();
const queue: Job[] = [];
let draining = false;
const RESULT_TTL_MS = 6 * 60 * 60 * 1000;

function pruneFinished(now = Date.now()) {
	for (const [key, job] of jobs) {
		if (job.finishedAt !== undefined && now - job.finishedAt > RESULT_TTL_MS) jobs.delete(key);
	}
}

function keyFor(relPath: string): string {
	return relPath.normalize('NFC');
}

function isActive(job: Job | undefined): boolean {
	return !!job && (job.status.state === 'queued' || job.status.state === 'running' || job.status.state === 'finishing');
}

export function getAudiobookStatus(relPath: string): AudiobookJobStatus | null {
	pruneFinished();
	const job = jobs.get(keyFor(relPath));
	return job ? { ...job.status } : null;
}

/**
 * Queue an export. Re-checks the quota server-side (the dialog's check could be
 * stale, or bypassed), so a billed service never starts a run it can't finish.
 */
export async function startAudiobook(
	rawPath: string,
	rawService: unknown,
	fromPosition: boolean,
	rawRate?: unknown
): Promise<AudiobookJobStatus> {
	const service = parseService(rawService);
	const rate = parseRate(rawRate);
	const book = await loadBook(rawPath);
	const key = keyFor(book.relPath);
	if (isActive(jobs.get(key))) throw new AudiobookError('busy');

	const plan = planExport(book.content.chunks, fromPosition && book.position !== null ? book.position : 0);
	if (plan.units.length === 0 || plan.chars === 0) throw new AudiobookError('empty');

	const job: Job = {
		service,
		rate,
		fromPosition: fromPosition && book.position !== null,
		abort: new AbortController(),
		status: {
			path: book.relPath,
			state: 'queued',
			service,
			totalUnits: plan.units.length,
			doneUnits: 0,
			totalChars: plan.chars,
			doneChars: 0,
			quotaRemaining: null,
			outputPath: null,
			error: null,
			detail: null
		}
	};
	jobs.set(key, job);
	queue.push(job);
	void drain();
	return { ...job.status };
}

/** Stop a queued or running export. Already-synthesized (billed) units stay cached. */
export function cancelAudiobook(relPath: string): AudiobookJobStatus | null {
	const job = jobs.get(keyFor(relPath));
	if (!job) return null;
	if (isActive(job)) {
		job.abort.abort();
		if (job.status.state === 'queued') {
			const i = queue.indexOf(job);
			if (i >= 0) queue.splice(i, 1);
			finish(job, 'cancelled');
		}
	}
	return { ...job.status };
}

/** A deleted book or folder takes its running exports with it (files DELETE). */
export function cancelAudiobooksForPath(relPath: string): void {
	const prefix = keyFor(relPath);
	for (const key of [...jobs.keys()]) {
		if (key === prefix || key.startsWith(prefix + '/') || prefix === '') cancelAudiobook(key);
	}
}

function finish(job: Job, state: 'done' | 'failed' | 'cancelled', error?: AudiobookErrorCode, detail?: string | null) {
	job.status.state = state;
	job.status.error = error ?? null;
	job.status.detail = detail ?? null;
	job.finishedAt = Date.now();
}

async function drain(): Promise<void> {
	if (draining) return;
	draining = true;
	try {
		let job: Job | undefined;
		while ((job = queue.shift()) !== undefined) {
			if (job.abort.signal.aborted) continue;
			job.status.state = 'running';
			try {
				await runJob(job);
				finish(job, 'done');
				console.log(`Audiobook export done: ${job.status.outputPath}`);
			} catch (err) {
				if (job.abort.signal.aborted) {
					finish(job, 'cancelled');
				} else {
					const c = classifyTtsFailure(err);
					console.error(`Audiobook export failed (${c.code}): ${job.status.path}`, err);
					finish(job, 'failed', c.code, c.detail);
				}
			}
		}
	} finally {
		draining = false;
		pruneFinished();
	}
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		if (signal.aborted) return reject(new Error('aborted'));
		const timer = setTimeout(() => {
			signal.removeEventListener('abort', onAbort);
			resolve();
		}, ms);
		const onAbort = () => {
			clearTimeout(timer);
			reject(new Error('aborted'));
		};
		signal.addEventListener('abort', onAbort, { once: true });
	});
}

/** Synthesize with retries on transient failures; anything else fails at once. */
async function synthesizeWithRetry(input: CachedSynthInput, signal: AbortSignal): Promise<ArrayBuffer> {
	for (let attempt = 0; ; attempt++) {
		if (signal.aborted) throw new Error('aborted');
		try {
			return (await synthesizeCached(input)).audio;
		} catch (err) {
			const c = classifyTtsFailure(err);
			if (!c.transient || attempt >= RETRY_DELAYS_MS.length) throw new AudiobookError(c.code, c.detail);
			console.warn(`Audiobook unit failed (${c.code}${c.detail ? `: ${c.detail}` : ''}), retrying`);
			await sleep(RETRY_DELAYS_MS[attempt], signal);
		}
	}
}

/** Run ffmpeg to completion over a buffer; resolves with stdout. */
function ffmpegBuffer(args: string[], input: Buffer | Uint8Array, signal: AbortSignal): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const proc = spawn('ffmpeg', args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		let stderr = '';
		const onAbort = () => proc.kill('SIGKILL');
		signal.addEventListener('abort', onAbort, { once: true });
		proc.stdout.on('data', (d: Buffer) => out.push(d));
		proc.stderr.on('data', (d: Buffer) => {
			if (stderr.length < 2000) stderr += d.toString();
		});
		proc.on('error', (err: NodeJS.ErrnoException) => {
			signal.removeEventListener('abort', onAbort);
			reject(new AudiobookError('ffmpeg', err.code === 'ENOENT' ? 'ffmpeg is not installed on the server' : err.message));
		});
		proc.on('close', (code) => {
			signal.removeEventListener('abort', onAbort);
			if (signal.aborted) return reject(new Error('aborted'));
			if (code === 0) resolve(Buffer.concat(out));
			else reject(new AudiobookError('ffmpeg', stderr.trim().split('\n').pop() || `ffmpeg exited ${code}`));
		});
		proc.stdin.on('error', () => {
			// EPIPE when ffmpeg rejects the input early; the close handler reports it.
		});
		proc.stdin.end(input);
	});
}

/** MP3 → raw PCM at the export's fixed format. */
function decodeToPcm(mp3: ArrayBuffer, signal: AbortSignal): Promise<Buffer> {
	return ffmpegBuffer(
		['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), 'pipe:1'],
		new Uint8Array(mp3),
		signal
	);
}

/** One encoder for the whole book, fed PCM in order. */
function startEncoder(outFile: string, signal: AbortSignal) {
	const proc = spawn(
		'ffmpeg',
		[
			'-hide_banner', '-loglevel', 'error', '-y',
			'-f', 's16le', '-ac', '1', '-ar', String(SAMPLE_RATE), '-i', 'pipe:0',
			'-c:a', 'libmp3lame', '-b:a', BITRATE, outFile
		],
		{ stdio: ['pipe', 'ignore', 'pipe'] }
	);
	let stderr = '';
	let failure: AudiobookError | null = null;
	proc.stderr.on('data', (d: Buffer) => {
		if (stderr.length < 2000) stderr += d.toString();
	});
	const done = new Promise<void>((resolve, reject) => {
		proc.on('error', (err: NodeJS.ErrnoException) => {
			failure = new AudiobookError('ffmpeg', err.code === 'ENOENT' ? 'ffmpeg is not installed on the server' : err.message);
			reject(failure);
		});
		proc.on('close', (code) => {
			if (code === 0) resolve();
			else {
				failure ??= new AudiobookError('ffmpeg', stderr.trim().split('\n').pop() || `encoder exited ${code}`);
				reject(failure);
			}
		});
	});
	done.catch(() => {}); // observed via write()/finish()
	const onAbort = () => proc.kill('SIGKILL');
	signal.addEventListener('abort', onAbort, { once: true });
	proc.stdin.on('error', () => {
		// Surfaces through `done`.
	});

	return {
		async write(buf: Buffer): Promise<void> {
			if (failure) throw failure;
			if (buf.length === 0) return;
			if (!proc.stdin.write(buf)) {
				await new Promise<void>((resolve, reject) => {
					proc.stdin.once('drain', resolve);
					done.catch(reject);
				});
			}
		},
		async finish(): Promise<void> {
			proc.stdin.end();
			try {
				await done;
			} finally {
				signal.removeEventListener('abort', onAbort);
			}
		}
	};
}

async function runJob(job: Job): Promise<void> {
	// The run's own controller: a user cancel aborts it, and so does a failure (to
	// stop the window and the encoder) — without the failure reading as a cancel.
	const run = new AbortController();
	if (job.abort.signal.aborted) run.abort();
	job.abort.signal.addEventListener('abort', () => run.abort(), { once: true });
	const signal = run.signal;
	// Re-load: the book or its position may have changed while queued.
	const book = await loadBook(job.status.path);
	const plan = planExport(book.content.chunks, job.fromPosition && book.position !== null ? book.position : 0);
	job.status.totalUnits = plan.units.length;
	job.status.totalChars = plan.chars;

	const voice = await (async () => {
		try {
			return await resolveVoice(job.service, book.content.locale, job.rate);
		} catch (err) {
			const c = classifyTtsFailure(err);
			throw new AudiobookError(c.code, c.detail);
		}
	})();
	const inputs = (u: PlannedUnit) => unitInput(job.service, voice, book, u);

	const quota = await readQuota(job.service);
	if (quota) {
		job.status.quotaRemaining = quota.remaining;
		const needed = await billableChars(plan, inputs);
		if (exceedsQuota(needed, quota)) {
			throw new AudiobookError('quotaExceeded', `${needed} characters needed, ${quota.remaining} left`);
		}
	}

	const workDir = path.join(workRoot(), `${process.pid}-${Date.now()}`);
	await fs.mkdir(workDir, { recursive: true });
	try {
		const rawFile = path.join(workDir, 'audio.mp3');
		const finalFile = path.join(workDir, 'final.mp3');
		const encoder = startEncoder(rawFile, signal);
		const chapterStarts = new Map<number, number>(); // unitOffset → seconds
		let pcmBytes = 0;

		// Synthesis + decode run ahead in a bounded window; writes stay in order.
		const window = WINDOW[job.service] ?? 2;
		const pending: Promise<Buffer>[] = [];
		const produce = (u: PlannedUnit) =>
			synthesizeWithRetry(inputs(u), signal).then((mp3) => decodeToPcm(mp3, signal));
		let next = 0;
		const fill = () => {
			while (next < plan.units.length && pending.length < window) {
				const p = produce(plan.units[next++]);
				p.catch(() => {}); // awaited in order below; avoid unhandled rejections meanwhile
				pending.push(p);
			}
		};
		fill();

		try {
			for (let offset = 0; offset < plan.units.length; offset++) {
				const u = plan.units[offset];
				const pcm = await pending.shift()!;
				fill();
				if (signal.aborted) throw new Error('aborted');

				// A breath before a heading, a shorter one between paragraphs.
				if (offset > 0) {
					const gap = u.heading ? HEADING_GAP_S : PARAGRAPH_GAP_S;
					const silence = Buffer.alloc(Math.round(gap * SAMPLE_RATE) * 2);
					await encoder.write(silence);
					pcmBytes += silence.length;
				}
				chapterStarts.set(offset, pcmBytes / BYTES_PER_SECOND);
				await encoder.write(pcm);
				pcmBytes += pcm.length;

				job.status.doneUnits = offset + 1;
				job.status.doneChars += u.text.length;
				if (quota && (offset + 1) % QUOTA_REFRESH_UNITS === 0) {
					getQuota(job.service)
						.then((q) => {
							if (q) job.status.quotaRemaining = q.remaining;
						})
						.catch(() => {});
				}
			}
		} catch (err) {
			// Stop the window and the encoder; whatever was billed is cached already.
			run.abort();
			throw err;
		}

		job.status.state = 'finishing';
		await encoder.finish();
		if (pcmBytes === 0) throw new AudiobookError('empty');

		const totalSeconds = pcmBytes / BYTES_PER_SECOND;
		const chapters = plan.chapters.map((c) => ({ title: c.title, start: chapterStarts.get(c.unitOffset) ?? 0 }));
		const title = book.content.title?.trim() || book.bookName;
		const metaFile = path.join(workDir, 'meta.txt');
		await fs.writeFile(metaFile, buildFfmetadata(title, chapters, totalSeconds), 'utf-8');
		await ffmpegBuffer(
			[
				'-hide_banner', '-loglevel', 'error', '-y',
				'-i', rawFile, '-i', metaFile,
				'-map', '0:a', '-map_metadata', '1', '-map_chapters', '1',
				'-c', 'copy', '-id3v2_version', '3', finalFile
			],
			Buffer.alloc(0),
			signal
		);

		// Named by the reading position, exactly as the dialog announced it.
		const percent =
			job.fromPosition && book.position !== null
				? positionPercent(book.position, book.content.chunks.length)
				: undefined;
		job.status.outputPath = await placeOutput(book, finalFile, exportFileName(book.bookName, percent), signal);
		if (quota) {
			try {
				const q = await getQuota(job.service);
				if (q) job.status.quotaRemaining = q.remaining;
			} catch {
				// informational only
			}
		}
	} finally {
		await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
	}
}

/** Copy the finished file next to the book under a hidden name, then rename it into place. */
async function placeOutput(
	book: LoadedBook,
	finalFile: string,
	wanted: string,
	signal: AbortSignal
): Promise<string> {
	const parentAbs = path.dirname(book.absPath);
	let existing: Set<string>;
	try {
		existing = new Set((await fs.readdir(parentAbs)).map((n) => n.normalize('NFC').toLowerCase()));
	} catch (err) {
		throw new AudiobookError('write', err instanceof Error ? err.message : null);
	}
	const name = uniqueFileName(wanted, (c) => existing.has(c.normalize('NFC').toLowerCase()));
	const tmp = path.join(parentAbs, `.${name}.ecobox-audio.tmp`);
	try {
		await fs.copyFile(finalFile, tmp);
		if (signal.aborted) throw new Error('aborted');
		await fs.rename(tmp, path.join(parentAbs, name));
	} catch (err) {
		await fs.rm(tmp, { force: true }).catch(() => {});
		if (signal.aborted) throw err;
		throw new AudiobookError('write', err instanceof Error ? err.message : null);
	}
	return getRelativePath(path.join(parentAbs, name));
}
