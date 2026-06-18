/**
 * ELF TTS adapter — a fully local, server-side engine. No API key, no network:
 * ecobox ships its own on-device speech build (vendored dylibs ported to Linux
 * ELF) under <ELF_DIR>/lib, plus a one-shot `eci_synth` tool under <ELF_DIR>/bin.
 * We spawn that tool per synthesis unit, feed it the unit text on stdin, and
 * transcode the WAV it returns to MP3 with ffmpeg so it matches the audio/mpeg
 * contract the rest of the TTS pipeline expects.
 *
 * Everything stays on this machine and is cached on disk like the cloud
 * providers, so re-reads cost nothing. Engine init + synthesis of a sentence is
 * ~10 ms, so one process per unit is cheap and keeps each synthesis isolated.
 */
import path from 'path';
import { spawn } from 'child_process';
import type { TtsVoice, ElfVoiceParams } from '$lib/types';
import { env } from '$env/dynamic/private';
import { TtsError } from './errors';

const TIMEOUT_MS = 30000;

/**
 * Inline ECI directive prepended to the text of every synthesis to force the engine's
 * phrase-prediction pass OFF. Phrase prediction guesses prosodic phrase boundaries
 * (extra pauses / intonation resets) when the text lacks punctuation; ecobox speaks
 * text as written, so we disable it.
 *
 * It is done here, in the text stream, rather than via `eciSetParam(eciPhrasePrediction, 0)`
 * in the engine wrapper, because that param is INERT in this Linux ELF port: it round-trips
 * through GetParam but synthesis is byte-identical whether it's 0 or 1. The inline `` `pp0 ``
 * annotation, by contrast, genuinely changes the output (verified: shorter WAV, predicted
 * pauses gone) — the engine honors it because it runs with `eciInputType=1`, the same
 * backtick-annotation channel the pronunciation dictionary (elfDict.ts) rides on. This
 * mirrors the upstream Eloquence driver, which embeds `` `pp1 ``/`` `pp0 `` in its byte
 * stream. The trailing space terminates the directive.
 *
 * Like the engine's abbreviation-off policy, this is a fixed, non-configurable setting and
 * is prepended AFTER the cache hash is computed (in the synthesize route), so it is NOT part
 * of the unitHash — clear the TTS cache to re-synthesize ELF audio made before this landed
 * (which still carries phrase prediction).
 */
const PHRASE_PREDICTION_OFF = '`pp0 ';

/** Root of the shipped engine bundle (bin/ + lib/). */
function elfDir(): string {
	return env.ELF_DIR?.trim() || path.join(process.cwd(), 'elf');
}
function binPath(): string {
	return path.join(elfDir(), 'bin', 'eci_synth');
}
function libDir(): string {
	return path.join(elfDir(), 'lib');
}
/** Where the per-language pronunciation `.dic` files live (see elfDict.ts). */
export function dictionariesDir(): string {
	return path.join(libDir(), 'dictionaries');
}

/** Run a command, optionally feeding stdin, and collect stdout. */
function run(
	cmd: string,
	args: string[],
	stdin: Buffer | null
): Promise<{ code: number | null; stdout: Buffer; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
		const out: Buffer[] = [];
		let errText = '';
		const timer = setTimeout(() => {
			child.kill('SIGKILL');
			reject(new TtsError(504, 'ELF synthesis timed out'));
		}, TIMEOUT_MS);

		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => (errText += c.toString()));
		child.on('error', (e) => {
			clearTimeout(timer);
			reject(new TtsError(500, `ELF: cannot run ${path.basename(cmd)} (${e.message})`));
		});
		child.on('close', (code) => {
			clearTimeout(timer);
			resolve({ code, stdout: Buffer.concat(out), stderr: errText.trim() });
		});

		if (stdin) child.stdin.end(stdin);
		else child.stdin.end();
	});
}

/** The 8 presets × each available language, straight from the engine's tables. */
export async function elfVoices(): Promise<TtsVoice[]> {
	let res;
	try {
		res = await run(binPath(), ['--list'], null);
	} catch (e) {
		if (e instanceof TtsError) throw e;
		throw new TtsError(500, 'ELF voice list failed');
	}
	if (res.code !== 0) {
		throw new TtsError(500, res.stderr || 'ELF voice list failed');
	}
	try {
		return JSON.parse(res.stdout.toString('utf8')) as TtsVoice[];
	} catch {
		throw new TtsError(500, 'ELF returned an unparseable voice list');
	}
}

/** Append a 0..100 voice param as a clamped integer CLI flag (null/undefined = skip). */
function paramFlag(args: string[], flag: string, value: number | null | undefined): void {
	if (value == null || !Number.isFinite(value)) return;
	const v = Math.max(0, Math.min(100, Math.round(value)));
	args.push(flag, String(v));
}

/**
 * Synthesize `text` → MP3. `voiceId` is a "<Preset>-<lang>-<REGION>" id from
 * elfVoices() (e.g. "Reed-en-US"); when absent the engine defaults to Reed /
 * American English. `params`, when present, overrides the preset's voice knobs
 * (head size / pitch / inflection / roughness / breathiness / volume); when
 * absent the engine keeps the selected preset's own values. `rate` is a
 * playback-speed multiplier (1.0 = the preset's natural pace) baked into
 * synthesis via the engine's native eciSpeed — unlike the other audio providers
 * (which time-stretch client-side), so this formant voice stays crisp when sped
 * up. Because it changes the samples, the caller folds it into the cache key.
 */
export async function elfSynthesize(opts: {
	voiceId: string;
	text: string;
	params?: ElfVoiceParams;
	rate?: number;
}): Promise<Buffer> {
	const args = ['--lib-dir', libDir()];
	if (opts.voiceId) args.push('--voice-id', opts.voiceId);
	if (opts.rate != null && Number.isFinite(opts.rate)) args.push('--rate', String(opts.rate));
	const p = opts.params;
	// Volume is always applied and defaults to 100 (loudest) — even when the user
	// hasn't customized the other knobs — so local ELF playback isn't quiet.
	paramFlag(args, '--volume', p?.volume ?? 100);
	if (p) {
		paramFlag(args, '--head-size', p.headSize);
		paramFlag(args, '--pitch', p.pitch);
		paramFlag(args, '--inflection', p.inflection);
		paramFlag(args, '--roughness', p.roughness);
		paramFlag(args, '--breathiness', p.breathiness);
	}

	// Prepend the phrase-prediction-off directive (no-op on empty text so eci_synth's
	// "nothing to say" early-return still fires for blank units).
	const text = opts.text ? PHRASE_PREDICTION_OFF + opts.text : opts.text;

	let synth;
	try {
		synth = await run(binPath(), args, Buffer.from(text, 'utf8'));
	} catch (e) {
		if (e instanceof TtsError) throw e;
		throw new TtsError(500, 'ELF synthesis failed');
	}
	if (synth.code !== 0 || synth.stdout.length === 0) {
		throw new TtsError(502, synth.stderr || 'ELF produced no audio');
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
		throw new TtsError(500, 'ELF MP3 transcode failed');
	}
	if (mp3.code !== 0 || mp3.stdout.length === 0) {
		throw new TtsError(502, mp3.stderr || 'ELF MP3 transcode failed');
	}
	return mp3.stdout;
}
