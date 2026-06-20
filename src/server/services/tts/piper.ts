/**
 * Piper TTS adapter — a second fully local, server-side engine (alongside ELF).
 * Piper is a neural (VITS) text-to-speech: ecobox vendors only the engine itself
 * under <PIPER_DIR> (the rhasspy/piper release — the `piper` executable plus its
 * bundled onnxruntime, espeak-ng phonemizer and `espeak-ng-data`). It ships NO
 * voices. The user imports voice models through Settings; each is a
 * `<name>.onnx` (the model) + `<name>.onnx.json` (its config) pair stored under
 * <PIPER_VOICES_DIR> (default: a `piper-voices` dir next to the SQLite db, so it
 * stays writable and out of the app bundle, like the on-disk audio cache).
 *
 * Per synthesis unit we spawn `piper` once (text on stdin → WAV on stdout) and pipe
 * the WAV through ffmpeg to MP3, matching the audio/mpeg pipeline + on-disk cache the
 * other server-synthesized services use. Like ELF — and unlike the cloud services,
 * which time-stretch the finished MP3 via <audio>.playbackRate — Piper BAKES the
 * reading rate into synthesis through its native `--length_scale` (it re-paces the
 * waveform instead of resampling it, so there are no stretch artifacts). Re-synthesis
 * is free for a local engine, so this is higher fidelity; rate is therefore folded
 * into the cache key and the reader re-speaks the current unit on a rate change. It's
 * a local engine in both TTS_KEYLESS_SERVICES and TTS_BAKED_RATE_SERVICES — keyless,
 * no network.
 */
import fs from 'fs/promises';
import path from 'path';
import { spawn } from 'child_process';
import type { TtsVoice } from '$lib/types';
import { env } from '$env/dynamic/private';
import { TtsError } from './errors';
import { assertExecutable, assertFfmpeg } from './localEngine';

// Neural synthesis loads the ONNX model on every spawn, so it's slower to start than
// ELF's formant path — give it a generous ceiling (the disk cache makes it one-time).
const TIMEOUT_MS = 60000;

/** Root of the vendored engine bundle (the `piper` binary + its libs + espeak data). */
function piperDir(): string {
	return env.PIPER_DIR?.trim() || path.join(process.cwd(), 'piper');
}
function binPath(): string {
	return path.join(piperDir(), 'piper');
}
function espeakDataDir(): string {
	return path.join(piperDir(), 'espeak-ng-data');
}

/** Where imported voice models (<stem>.onnx + <stem>.onnx.json) are stored. */
export function voicesDir(): string {
	if (env.PIPER_VOICES_DIR?.trim()) return env.PIPER_VOICES_DIR.trim();
	const dbPath = env.DATABASE_URL?.replace('file:', '') || './data/ecobox.db';
	return path.join(path.dirname(dbPath), 'piper-voices');
}

/** A safe voice "stem" is a bare filename — no separators, no traversal. */
const STEM_RE = /^[A-Za-z0-9._-]+$/;
export function isValidStem(stem: string): boolean {
	return !!stem && stem === path.basename(stem) && !stem.includes('..') && STEM_RE.test(stem);
}

function modelFile(stem: string): string {
	return path.join(voicesDir(), `${stem}.onnx`);
}
function configFile(stem: string): string {
	return path.join(voicesDir(), `${stem}.onnx.json`);
}

/** Run a command, optionally feeding stdin, and collect stdout. */
function run(
	cmd: string,
	args: string[],
	stdin: Buffer | null,
	extraEnv?: NodeJS.ProcessEnv
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, {
			stdio: ['pipe', 'pipe', 'pipe'],
			env: extraEnv ? { ...process.env, ...extraEnv } : process.env
		});
		const out: Buffer[] = [];
		let errText = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new TtsError(504, 'Piper synthesis timed out'));
		}, TIMEOUT_MS);

		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => (errText += c.toString()));
		child.on('error', (e) => {
			clearTimeout(timer);
			// ENOENT means the binary itself is missing (the piper engine wasn't vendored
			// for this arch, or ffmpeg isn't installed) — say so instead of "spawn … ENOENT".
			const hint = (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'not found — is it installed?' : e.message;
			reject(new TtsError(500, `Piper: cannot run ${path.basename(cmd)} (${hint})`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out), stderr: errText.trim() });
		});

		if (stdin) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

interface PiperConfig {
	num_speakers?: number;
	speaker_id_map?: Record<string, number>;
	dataset?: string;
	language?: { code?: string; family?: string; name_english?: string; name_native?: string };
	/** The voice's natural pacing; rate scales relative to this (default 1.0). */
	inference?: { length_scale?: number };
}

/** "en_US" → "en-US" (BCP-47-ish); falls back to the family or ''. */
function langOf(cfg: PiperConfig): string {
	const code = cfg.language?.code;
	if (code) return code.replace('_', '-');
	return cfg.language?.family ?? '';
}

/** A readable per-model label, e.g. "lessac — English (US), medium". */
function labelOf(stem: string, cfg: PiperConfig): string {
	const dataset = cfg.dataset || stem;
	const lang = cfg.language?.name_english || cfg.language?.code || '';
	// Voices are conventionally named "<lang>-<dataset>-<quality>"; surface the quality.
	const quality = (stem.split('-').pop() || '').replace('_', '-');
	const known = ['x-low', 'low', 'medium', 'high'];
	const q = known.includes(quality) ? `, ${quality}` : '';
	return lang ? `${dataset} — ${lang}${q}` : `${dataset}${q}`;
}

async function readConfig(stem: string): Promise<PiperConfig | null> {
	try {
		return JSON.parse(await fs.readFile(configFile(stem), 'utf8')) as PiperConfig;
	} catch {
		return null;
	}
}

/** Imported `.onnx` stems that also have a readable `.onnx.json`, sorted. */
async function listStems(): Promise<string[]> {
	let entries: string[];
	try {
		entries = await fs.readdir(voicesDir());
	} catch {
		return []; // nothing imported yet
	}
	return entries
		.filter((n) => n.endsWith('.onnx'))
		.map((n) => n.slice(0, -'.onnx'.length))
		.filter(isValidStem)
		.sort();
}

/**
 * Selectable voices — one per single-speaker model, or one per speaker for a
 * multi-speaker model. IDs are "<stem>" or "<stem>#<speakerId>". A model whose
 * config can't be read is skipped (it can't be synthesized anyway).
 */
export async function piperVoices(): Promise<TtsVoice[]> {
	const voices: TtsVoice[] = [];
	for (const stem of await listStems()) {
		const cfg = await readConfig(stem);
		if (!cfg) continue;
		const lang = langOf(cfg);
		const label = labelOf(stem, cfg);
		const speakerMap = cfg.speaker_id_map ?? {};
		const speakerNames = Object.keys(speakerMap);
		if ((cfg.num_speakers ?? 1) > 1 && speakerNames.length > 0) {
			for (const spk of speakerNames) {
				voices.push({ id: `${stem}#${speakerMap[spk]}`, name: `${label} · ${spk}`, lang });
			}
		} else {
			voices.push({ id: stem, name: label, lang });
		}
	}
	return voices;
}

/**
 * Activation preflight for the Settings "Test" button. Piper's voice list is built
 * purely from files on disk, so listing voices alone never proves the engine can run
 * — this confirms the vendored `piper` binary exists and is executable and that
 * ffmpeg is installed, then reports whether any voices are imported (the engine is
 * useless without one). Library-load failures at the wrong CPU arch still surface at
 * first synthesis via the spawn-error path, but the common "binary/ffmpeg missing"
 * and "no voices yet" cases are caught here. Never throws.
 */
export async function piperHealthCheck(): Promise<{ ok: boolean; message: string; voiceCount?: number }> {
	try {
		await assertExecutable(binPath(), 'Piper');
		await assertFfmpeg('Piper');
		const voices = await piperVoices();
		if (voices.length === 0)
			return { ok: false, message: 'Piper engine is ready, but no voices are imported yet.' };
		return { ok: true, message: 'ok', voiceCount: voices.length };
	} catch (e) {
		if (e instanceof TtsError) return { ok: false, message: e.message };
		return { ok: false, message: e instanceof Error ? e.message : 'Piper check failed.' };
	}
}

/** Per-model management view (for the import/delete UI): one row per imported model. */
export async function listPiperModels(): Promise<
	{ stem: string; label: string; lang: string; speakers: number; bytes: number }[]
> {
	const rows = [];
	for (const stem of await listStems()) {
		const cfg = await readConfig(stem);
		if (!cfg) continue;
		let bytes = 0;
		try {
			bytes = (await fs.stat(modelFile(stem))).size;
		} catch {
			// ignore — file may have vanished
		}
		rows.push({
			stem,
			label: labelOf(stem, cfg),
			lang: langOf(cfg),
			speakers: cfg.num_speakers ?? 1,
			bytes
		});
	}
	return rows;
}

/**
 * Resolve a voiceId ("<stem>" or "<stem>#<speaker>") to its files, speaker id, and the
 * voice's natural `length_scale` (so a rate multiplier scales relative to it).
 */
async function resolveVoice(voiceId: string): Promise<{
	modelPath: string;
	configPath: string;
	speaker: number | null;
	baseLengthScale: number;
}> {
	if (!voiceId) throw new TtsError(400, 'No Piper voice selected');
	const hash = voiceId.lastIndexOf('#');
	const stem = hash >= 0 ? voiceId.slice(0, hash) : voiceId;
	const spk = hash >= 0 ? parseInt(voiceId.slice(hash + 1), 10) : NaN;
	if (!isValidStem(stem)) throw new TtsError(400, 'Invalid Piper voice id');
	const modelPath = modelFile(stem);
	try {
		await fs.access(modelPath);
	} catch {
		throw new TtsError(404, 'Piper voice not found — import it in Settings');
	}
	const ls = (await readConfig(stem))?.inference?.length_scale;
	const baseLengthScale = typeof ls === 'number' && Number.isFinite(ls) && ls > 0 ? ls : 1;
	return {
		modelPath,
		configPath: configFile(stem),
		speaker: Number.isFinite(spk) ? spk : null,
		baseLengthScale
	};
}

/**
 * Synthesize `text` → MP3 with the selected imported voice. The reading-rate
 * multiplier (1.0 = the voice's natural pace) is baked into synthesis via Piper's
 * native `--length_scale` — a duration multiplier, i.e. the inverse of speed — scaled
 * from the voice's own default. This re-paces the waveform without resampling, so it
 * stays artifact-free at any speed (no client-side time-stretch). The caller folds
 * `rate` into the cache key since it changes the samples.
 */
export async function piperSynthesize(opts: {
	voiceId: string;
	text: string;
	rate?: number;
}): Promise<Buffer> {
	// Piper reads one line of stdin per utterance and would emit one WAV per line;
	// flatten newlines so a multi-sentence unit produces a single WAV.
	const text = (opts.text || '').replace(/\s+/g, ' ').trim();
	if (!text) throw new TtsError(400, 'No text to synthesize');

	const { modelPath, configPath, speaker, baseLengthScale } = await resolveVoice(opts.voiceId);
	const args = ['-q', '-m', modelPath, '-c', configPath, '-f', '-', '--espeak_data', espeakDataDir()];
	if (speaker != null) args.push('-s', String(speaker));
	// length_scale = base / rate (faster speech → shorter phonemes → smaller scale).
	const rate = opts.rate != null && Number.isFinite(opts.rate) && opts.rate > 0 ? opts.rate : 1;
	args.push('--length_scale', (baseLengthScale / rate).toFixed(4));

	let synth;
	try {
		// rpath should locate the bundled libs, but set LD_LIBRARY_PATH too as a backstop.
		synth = await run(binPath(), args, Buffer.from(text, 'utf8'), { LD_LIBRARY_PATH: piperDir() });
	} catch (e) {
		if (e instanceof TtsError) throw e;
		throw new TtsError(500, 'Piper synthesis failed');
	}
	if (synth.code !== 0 || synth.stdout.length === 0) {
		throw new TtsError(502, synth.stderr || 'Piper produced no audio');
	}

	// Transcode the WAV to MP3 to match the audio/mpeg pipeline + on-disk cache.
	let mp3;
	try {
		mp3 = await run(
			'ffmpeg',
			['-hide_banner', '-loglevel', 'error', '-f', 'wav', '-i', 'pipe:0', '-f', 'mp3', '-b:a', '64k', 'pipe:1'],
			synth.stdout
		);
	} catch (e) {
		if (e instanceof TtsError) throw e;
		throw new TtsError(500, 'Piper MP3 transcode failed');
	}
	if (mp3.code !== 0 || mp3.stdout.length === 0) {
		throw new TtsError(502, mp3.stderr || 'Piper MP3 transcode failed');
	}
	return mp3.stdout;
}

/**
 * Persist an imported voice (model + config) atomically. `stem` is the validated
 * base name (no extension). Throws TtsError on a bad stem or write failure.
 */
export async function savePiperVoice(stem: string, onnx: Buffer, config: Buffer): Promise<void> {
	if (!isValidStem(stem)) throw new TtsError(400, 'Invalid voice name');
	const dir = voicesDir();
	await fs.mkdir(dir, { recursive: true });
	// Write to temp files, then rename into place — config first so a model is never
	// visible to piperVoices() without its config (which would make it unsynthesizable).
	const cfgTmp = `${configFile(stem)}.tmp`;
	const onnxTmp = `${modelFile(stem)}.tmp`;
	try {
		await fs.writeFile(cfgTmp, config);
		await fs.writeFile(onnxTmp, onnx);
		await fs.rename(cfgTmp, configFile(stem));
		await fs.rename(onnxTmp, modelFile(stem));
	} catch (e) {
		await fs.rm(cfgTmp, { force: true }).catch(() => {});
		await fs.rm(onnxTmp, { force: true }).catch(() => {});
		throw new TtsError(500, `Failed to save voice (${e instanceof Error ? e.message : 'write error'})`);
	}
}

/** Remove an imported voice's model + config. No-op if it doesn't exist. */
export async function deletePiperVoice(stem: string): Promise<void> {
	if (!isValidStem(stem)) throw new TtsError(400, 'Invalid voice name');
	await fs.rm(modelFile(stem), { force: true }).catch(() => {});
	await fs.rm(configFile(stem), { force: true }).catch(() => {});
}
