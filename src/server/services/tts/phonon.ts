/**
 * Phonon TTS adapter — a third fully local, server-side engine (alongside ELF and
 * Piper). Phonon is Gradium's small neural on-device model (31M/40M params,
 * GGUF weights on their own Rust runtime, no PyTorch), installed as the `ptts` pip
 * package into a virtualenv at <PHONON_DIR>/venv (default `<cwd>/phonon`).
 *
 * Unlike Piper, we do NOT spawn a CLI per unit: loading the model costs ~2 s, while a
 * warm model synthesizes ~5× faster than real time on this box (measured
 * 2026-11-11, EPYC-Milan: 7.8 s of audio in 1.5 s). So one persistent Python worker
 * (`scripts/phonon_worker.py`) is kept alive and fed JSON lines over stdio; it keeps
 * one model per language warm and exits after PHONON_IDLE_MS of disuse to give back
 * its RAM (~430 MB per loaded language).
 *
 * Voices:
 *  - A curated catalog subset — two female + two male per locale — from Gradium's
 *    voice catalog (`hf://gradium/phonon-voices`, downloaded and cached on first
 *    use). English runs on the open Apache-2.0 `phonon-31m-en`; fr/de/es/pt run on
 *    `phonon-40m-multilingual` (CC BY-NC) installed LOCALLY under
 *    <PHONON_DIR>/models/phonon-40m-multilingual (config.json + model.safetensors +
 *    tokenizer.json — e.g. taken from Andre Louis's Phonon NVDA add-on, which bundles
 *    it). Its Hugging Face repo is gated, so we never download it; those voices are
 *    listed only when the local copy is present (or, failing that, HF_TOKEN is set).
 *  - User-uploaded voices: a Phonon voice embedding (`.safetensors`, e.g. a clone
 *    made on Gradium's site with `clone-voice.py`). Cloning itself is NOT done here —
 *    playback only. Stored under PHONON_VOICES_DIR (default `<dataDir>/phonon-voices`)
 *    with a `<stem>.json` sidecar holding its display name and language.
 *
 * Rate is NOT baked: the 31m model exposes no pacing control, so Phonon behaves like
 * the cloud services — one cached MP3, time-stretched client-side via playbackRate.
 */
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import type { TtsVoice } from '$lib/types';
import { env } from '$env/dynamic/private';
import { TtsError } from './errors';
import { assertExecutable, assertFfmpeg, wavSampleBytes } from './localEngine';
import { silentMp3 } from './silence';

/** Languages the engine has a model for. `en` is open; the rest are gated on HF. */
export const PHONON_LANGS = ['en', 'fr', 'de', 'es', 'pt'] as const;
export type PhononLang = (typeof PHONON_LANGS)[number];

/**
 * The bundled catalog voices: two female and two male adult voices per locale.
 * `name` is the catalog name the worker resolves; `lang` is the BCP-47 locale.
 */
const CATALOG: { name: string; lang: string; gender: 'female' | 'male' }[] = [
	{ name: 'Zoey', lang: 'en-US', gender: 'female' },
	{ name: 'Harper', lang: 'en-US', gender: 'female' },
	{ name: 'Easton', lang: 'en-US', gender: 'male' },
	{ name: 'Russell', lang: 'en-US', gender: 'male' },
	{ name: 'Maeve', lang: 'en-GB', gender: 'female' },
	{ name: 'Imogen', lang: 'en-GB', gender: 'female' },
	{ name: 'Hugh', lang: 'en-GB', gender: 'male' },
	{ name: 'Toby', lang: 'en-GB', gender: 'male' },
	{ name: 'Tiphaine', lang: 'fr-FR', gender: 'female' },
	{ name: 'Orianne', lang: 'fr-FR', gender: 'female' },
	{ name: 'Augustin', lang: 'fr-FR', gender: 'male' },
	{ name: 'Jules', lang: 'fr-FR', gender: 'male' },
	{ name: 'Annika', lang: 'de-DE', gender: 'female' },
	{ name: 'Nele', lang: 'de-DE', gender: 'female' },
	{ name: 'Anton', lang: 'de-DE', gender: 'male' },
	{ name: 'Henrik', lang: 'de-DE', gender: 'male' },
	{ name: 'Celia', lang: 'es-ES', gender: 'female' },
	{ name: 'Alicia', lang: 'es-ES', gender: 'female' },
	{ name: 'Marcos', lang: 'es-ES', gender: 'male' },
	{ name: 'Iker', lang: 'es-ES', gender: 'male' },
	{ name: 'Regina', lang: 'es-MX', gender: 'female' },
	{ name: 'Ximena', lang: 'es-MX', gender: 'female' },
	{ name: 'Lalo', lang: 'es-MX', gender: 'male' },
	{ name: 'Ulises', lang: 'es-MX', gender: 'male' },
	{ name: 'Débora', lang: 'pt-BR', gender: 'female' },
	{ name: 'Flávia', lang: 'pt-BR', gender: 'female' },
	{ name: 'Davi', lang: 'pt-BR', gender: 'male' },
	{ name: 'Vitor', lang: 'pt-BR', gender: 'male' }
];

const LANG_NAMES: Record<string, string> = {
	'en-US': 'English (US)',
	'en-GB': 'English (UK)',
	'fr-FR': 'French',
	'de-DE': 'German',
	'es-ES': 'Spanish (Spain)',
	'es-MX': 'Spanish (Mexico)',
	'pt-BR': 'Portuguese (Brazil)',
	en: 'English',
	fr: 'French',
	de: 'German',
	es: 'Spanish',
	pt: 'Portuguese'
};

/** The first synthesis of a language loads (and may download) its model. */
const TIMEOUT_MS = 180000;
const IDLE_MS = Number(env.PHONON_IDLE_MS) || 15 * 60 * 1000;
const CUSTOM_PREFIX = 'custom:';

function phononDir(): string {
	return env.PHONON_DIR?.trim() || path.join(process.cwd(), 'phonon');
}
function pythonPath(): string {
	return process.platform === 'win32'
		? path.join(phononDir(), 'venv', 'Scripts', 'python.exe')
		: path.join(phononDir(), 'venv', 'bin', 'python');
}
function workerScript(): string {
	return env.PHONON_WORKER?.trim() || path.join(process.cwd(), 'scripts', 'phonon_worker.py');
}
/** Hugging Face cache for models + catalog voices; inside the engine dir, owned by the service. */
/** Local copy of phonon-40m-multilingual (fr/de/es/pt; it speaks English too). */
function multilingualDir(): string {
	return env.PHONON_MULTILINGUAL_DIR?.trim() || path.join(phononDir(), 'models', 'phonon-40m-multilingual');
}
async function hasLocalMultilingual(): Promise<boolean> {
	try {
		await fs.access(path.join(multilingualDir(), 'config.json'));
		await fs.access(path.join(multilingualDir(), 'model.safetensors'));
		return true;
	} catch {
		return false;
	}
}
function hfHome(): string {
	return env.PHONON_HF_HOME?.trim() || path.join(phononDir(), 'hf');
}

/** Where uploaded voices (<stem>.safetensors + <stem>.json) are stored. */
export function voicesDir(): string {
	if (env.PHONON_VOICES_DIR?.trim()) return env.PHONON_VOICES_DIR.trim();
	const dbPath = env.DATABASE_URL?.replace('file:', '') || './data/ecobox.db';
	return path.join(path.dirname(dbPath), 'phonon-voices');
}

const STEM_RE = /^[A-Za-z0-9._-]+$/;
export function isValidStem(stem: string): boolean {
	return !!stem && stem === path.basename(stem) && !stem.includes('..') && STEM_RE.test(stem);
}
export function isPhononLang(l: string): l is PhononLang {
	return (PHONON_LANGS as readonly string[]).includes(l);
}

/** "es-MX" → "es"; anything unsupported → null. */
function baseLang(lang: string): PhononLang | null {
	const b = (lang || '').toLowerCase().split(/[-_]/)[0];
	return isPhononLang(b) ? b : null;
}

/**
 * A non-English language can be spoken when the local multilingual model is present,
 * or — as a fallback — when a Hugging Face token can fetch the gated per-language
 * model, or that model is already in the local cache.
 */
async function langAvailable(lang: PhononLang): Promise<boolean> {
	if (lang === 'en') return true;
	if (await hasLocalMultilingual()) return true;
	if (env.HF_TOKEN?.trim()) return true;
	try {
		await fs.access(path.join(hfHome(), 'hub', `models--gradium--phonon-40m-${lang}`, 'snapshots'));
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Persistent worker
// ---------------------------------------------------------------------------

interface Pending {
	resolve: (r: { ok: boolean; error?: string }) => void;
	reject: (e: Error) => void;
	timer: ReturnType<typeof setTimeout>;
}

let worker: ChildProcessWithoutNullStreams | null = null;
let nextId = 1;
const pending = new Map<number, Pending>();
let stdoutBuf = '';
let stderrTail = '';
let idleTimer: ReturnType<typeof setTimeout> | null = null;

function failAll(err: Error) {
	for (const [, p] of pending) {
		clearTimeout(p.timer);
		p.reject(err);
	}
	pending.clear();
}

function startWorker(multilingual: boolean): ChildProcessWithoutNullStreams {
	const childEnv: NodeJS.ProcessEnv = { ...process.env, HF_HOME: hfHome() };
	if (multilingual) {
		for (const l of ['FR', 'DE', 'ES', 'PT']) {
			if (!childEnv[`PHONON_MODEL_${l}`]) childEnv[`PHONON_MODEL_${l}`] = multilingualDir();
		}
	}
	if (env.HF_TOKEN?.trim()) childEnv.HF_TOKEN = env.HF_TOKEN.trim();
	if (env.PHONON_THREADS?.trim()) childEnv.PHONON_THREADS = env.PHONON_THREADS.trim();
	const child = spawn(pythonPath(), ['-I', workerScript()], {
		stdio: ['pipe', 'pipe', 'pipe'],
		env: childEnv
	});
	stdoutBuf = '';
	stderrTail = '';
	child.stdout.setEncoding('utf8');
	child.stdout.on('data', (chunk: string) => {
		stdoutBuf += chunk;
		let nl: number;
		while ((nl = stdoutBuf.indexOf('\n')) >= 0) {
			const line = stdoutBuf.slice(0, nl).trim();
			stdoutBuf = stdoutBuf.slice(nl + 1);
			if (!line) continue;
			let msg: { id?: number; ok?: boolean; error?: string };
			try {
				msg = JSON.parse(line);
			} catch {
				continue; // not protocol — ignore
			}
			const p = msg.id != null ? pending.get(msg.id) : undefined;
			if (!p) continue;
			pending.delete(msg.id!);
			clearTimeout(p.timer);
			p.resolve({ ok: !!msg.ok, error: msg.error });
		}
	});
	child.stderr.on('data', (c: Buffer) => {
		stderrTail = (stderrTail + c.toString()).slice(-2000);
	});
	child.on('error', (e) => {
		const hint = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found — is the venv installed?' : e.message;
		if (worker === child) worker = null;
		failAll(new TtsError(500, `Phonon: cannot start the engine (${hint})`));
	});
	child.on('close', (code) => {
		if (worker === child) worker = null;
		if (pending.size > 0) {
			const tail = stderrTail.trim().split('\n').slice(-3).join(' ');
			failAll(new TtsError(502, `Phonon engine exited (code ${code})${tail ? `: ${tail}` : ''}`));
		}
	});
	return child;
}

function bumpIdle() {
	if (idleTimer) clearTimeout(idleTimer);
	idleTimer = setTimeout(() => {
		if (pending.size === 0 && worker) {
			worker.stdin.end(); // worker exits when stdin closes
			worker = null;
		} else bumpIdle();
	}, IDLE_MS);
	idleTimer.unref?.();
}

async function request(payload: Record<string, unknown>): Promise<{ ok: boolean; error?: string }> {
	if (!worker) worker = startWorker(await hasLocalMultilingual());
	bumpIdle();
	const id = nextId++;
	const w = worker;
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => {
			pending.delete(id);
			// A wedged worker would block every later unit (it's serial) — recycle it.
			if (worker === w) {
				w.kill('SIGKILL');
				worker = null;
			}
			reject(new TtsError(504, 'Phonon synthesis timed out'));
		}, TIMEOUT_MS);
		pending.set(id, { resolve, reject, timer });
		w.stdin.write(JSON.stringify({ id, ...payload }) + '\n');
	});
}

// ---------------------------------------------------------------------------
// Uploaded voices
// ---------------------------------------------------------------------------

interface CustomMeta {
	name: string;
	lang: PhononLang;
}

function voiceFile(stem: string) {
	return path.join(voicesDir(), `${stem}.safetensors`);
}
function metaFile(stem: string) {
	return path.join(voicesDir(), `${stem}.json`);
}

async function readMeta(stem: string): Promise<CustomMeta> {
	try {
		const m = JSON.parse(await fs.readFile(metaFile(stem), 'utf8')) as Partial<CustomMeta>;
		return {
			name: typeof m.name === 'string' && m.name.trim() ? m.name.trim() : stem,
			lang: m.lang && isPhononLang(m.lang) ? m.lang : 'en'
		};
	} catch {
		return { name: stem, lang: 'en' };
	}
}

async function listStems(): Promise<string[]> {
	try {
		return (await fs.readdir(voicesDir()))
			.filter((n) => n.endsWith('.safetensors'))
			.map((n) => n.slice(0, -'.safetensors'.length))
			.filter(isValidStem)
			.sort();
	} catch {
		return [];
	}
}

export async function listPhononCustomVoices(): Promise<
	{ stem: string; name: string; lang: PhononLang; bytes: number }[]
> {
	const rows = [];
	for (const stem of await listStems()) {
		const meta = await readMeta(stem);
		let bytes = 0;
		try {
			bytes = (await fs.stat(voiceFile(stem))).size;
		} catch {
			continue;
		}
		rows.push({ stem, ...meta, bytes });
	}
	return rows;
}

/**
 * Minimal safetensors sanity check: an 8-byte little-endian header length followed
 * by that many bytes of JSON. Keeps an arbitrary upload from reaching the engine.
 */
export function looksLikeSafetensors(buf: Buffer): boolean {
	if (buf.length < 16) return false;
	const n = Number(buf.readBigUInt64LE(0));
	if (n <= 0 || n > 1024 * 1024 || 8 + n > buf.length) return false;
	try {
		const h = JSON.parse(buf.toString('utf8', 8, 8 + n));
		return typeof h === 'object' && h !== null;
	} catch {
		return false;
	}
}

export async function savePhononVoice(stem: string, data: Buffer, meta: CustomMeta): Promise<void> {
	if (!isValidStem(stem)) throw new TtsError(400, 'Invalid voice name');
	const dir = voicesDir();
	await fs.mkdir(dir, { recursive: true });
	const vTmp = `${voiceFile(stem)}.tmp`;
	const mTmp = `${metaFile(stem)}.tmp`;
	try {
		await fs.writeFile(mTmp, JSON.stringify(meta));
		await fs.writeFile(vTmp, data);
		await fs.rename(mTmp, metaFile(stem));
		await fs.rename(vTmp, voiceFile(stem));
	} catch (e) {
		await fs.rm(vTmp, { force: true }).catch(() => {});
		await fs.rm(mTmp, { force: true }).catch(() => {});
		throw new TtsError(500, `Failed to save voice (${e instanceof Error ? e.message : 'write error'})`);
	}
}

export async function deletePhononVoice(stem: string): Promise<void> {
	if (!isValidStem(stem)) throw new TtsError(400, 'Invalid voice name');
	await fs.rm(voiceFile(stem), { force: true }).catch(() => {});
	await fs.rm(metaFile(stem), { force: true }).catch(() => {});
}

// ---------------------------------------------------------------------------
// Service surface
// ---------------------------------------------------------------------------

export async function phononVoices(): Promise<TtsVoice[]> {
	const available = new Map<PhononLang, boolean>();
	for (const l of PHONON_LANGS) available.set(l, await langAvailable(l));
	const voices: TtsVoice[] = [];
	for (const v of CATALOG) {
		if (!available.get(baseLang(v.lang)!)) continue;
		voices.push({
			id: v.name,
			name: `${v.name} — ${LANG_NAMES[v.lang] ?? v.lang}, ${v.gender}`,
			lang: v.lang
		});
	}
	for (const c of await listPhononCustomVoices()) {
		voices.push({
			id: `${CUSTOM_PREFIX}${c.stem}`,
			name: `${c.name} — ${LANG_NAMES[c.lang] ?? c.lang}, uploaded`,
			lang: c.lang
		});
	}
	return voices;
}

export async function phononHealthCheck(): Promise<{ ok: boolean; message: string; voiceCount?: number }> {
	try {
		await assertExecutable(pythonPath(), 'Phonon');
		await assertFfmpeg('Phonon');
		await fs.access(workerScript()).catch(() => {
			throw new TtsError(503, `Phonon worker script is missing at ${workerScript()}.`);
		});
		const voices = await phononVoices();
		const locked = [];
		for (const l of PHONON_LANGS) if (!(await langAvailable(l))) locked.push(l);
		const note = locked.length
			? ` (${locked.join('/')} need the phonon-40m-multilingual model in ${multilingualDir()})`
			: '';
		return { ok: true, message: `ok${note}`, voiceCount: voices.length };
	} catch (e) {
		return { ok: false, message: e instanceof Error ? e.message : 'Phonon check failed.' };
	}
}

async function resolveVoice(voiceId: string): Promise<{ voice: string; voicePath?: string; lang: PhononLang }> {
	if (!voiceId) throw new TtsError(400, 'No Phonon voice selected');
	if (voiceId.startsWith(CUSTOM_PREFIX)) {
		const stem = voiceId.slice(CUSTOM_PREFIX.length);
		if (!isValidStem(stem)) throw new TtsError(400, 'Invalid Phonon voice id');
		let mtime: number;
		try {
			mtime = Math.floor((await fs.stat(voiceFile(stem))).mtimeMs);
		} catch {
			throw new TtsError(404, 'Phonon voice not found — upload it in Settings');
		}
		const { lang } = await readMeta(stem);
		// mtime in the key: a replaced file registers fresh instead of reusing a stale embedding.
		return { voice: `${CUSTOM_PREFIX}${stem}@${mtime}`, voicePath: voiceFile(stem), lang };
	}
	const entry = CATALOG.find((v) => v.name === voiceId);
	if (!entry) throw new TtsError(404, 'Unknown Phonon voice');
	return { voice: entry.name, lang: baseLang(entry.lang)! };
}

function runFfmpeg(wav: Buffer): Promise<Buffer> {
	return new Promise((resolve, reject) => {
		const child = spawn(
			'ffmpeg',
			['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '64k', 'pipe:1'],
			{ stdio: ['pipe', 'pipe', 'pipe'] }
		);
		const out: Buffer[] = [];
		let err = '';
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => (err += c.toString()));
		child.on('error', () => reject(new TtsError(500, 'Phonon: cannot run ffmpeg')));
		child.on('close', (code) => {
			const mp3 = Buffer.concat(out);
			if (code !== 0 || mp3.length === 0) reject(new TtsError(502, err.trim() || 'Phonon MP3 transcode failed'));
			else resolve(mp3);
		});
		child.stdin.end(wav);
	});
}

/** Synthesize `text` → MP3 with a catalog or uploaded voice. */
export async function phononSynthesize(opts: { voiceId: string; text: string }): Promise<Buffer> {
	const text = (opts.text || '').replace(/\s+/g, ' ').trim();
	if (!text) return silentMp3();
	const { voice, voicePath, lang } = await resolveVoice(opts.voiceId);
	if (!(await langAvailable(lang))) {
		throw new TtsError(
			503,
			`Phonon ${LANG_NAMES[lang] ?? lang} needs the phonon-40m-multilingual model in ${multilingualDir()}.`
		);
	}

	const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ecobox-phonon-'));
	const out = path.join(tmpDir, 'unit.wav');
	try {
		const res = await request({ text, voice, voicePath, lang, out });
		if (!res.ok) {
			const msg = res.error || 'Phonon produced no audio';
			if (/GatedRepo|Authentication required|401|403/.test(msg))
				throw new TtsError(503, `Phonon: no access to the ${lang} model — install phonon-40m-multilingual in ${multilingualDir()}.`);
			throw new TtsError(502, `Phonon: ${msg}`);
		}
		const wav = await fs.readFile(out);
		if (wavSampleBytes(wav) === 0) return silentMp3();
		return await runFfmpeg(wav);
	} finally {
		await fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});
	}
}
