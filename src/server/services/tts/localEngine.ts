/**
 * Shared dependency preflight for the fully-local TTS engines (ELF, Piper). Both
 * spawn a vendored binary and pipe its WAV through the system ffmpeg, so both fail
 * for the same boring reasons: the bundled binary is missing or not executable, or
 * ffmpeg isn't installed. These helpers turn those into precise, actionable
 * TtsErrors — surfaced by the Settings "Test" button at activation time — instead
 * of a cryptic spawn failure discovered mid-read.
 */
import { spawn } from 'child_process';
import { access, constants } from 'fs/promises';
import { TtsError } from './errors';

/**
 * Confirm a bundled engine binary exists and is executable. Reports 503 ("engine
 * unavailable") when the file is simply missing — e.g. a fresh checkout that hasn't
 * built `eci_synth`, or a CPU-arch mismatch — and 500 when it's present but can't
 * be run (a permissions problem).
 */
export async function assertExecutable(binPath: string, engine: string): Promise<void> {
	try {
		await access(binPath, constants.X_OK);
	} catch (e) {
		const code = (e as NodeJS.ErrnoException).code;
		if (code === 'ENOENT')
			throw new TtsError(503, `${engine} engine is not installed (missing binary at ${binPath}).`);
		throw new TtsError(
			500,
			`${engine} engine binary is not executable at ${binPath} (${code ?? 'permission denied'}).`
		);
	}
}

/** ffmpeg won't vanish mid-process, so once confirmed we skip the re-check. */
let ffmpegConfirmed = false;

/**
 * Confirm the system ffmpeg — the WAV→MP3 transcoder both local engines depend on —
 * is installed and runnable. Without this, a local engine's voice list (which never
 * touches ffmpeg) would "Test" green while every sentence then failed to transcode.
 */
export async function assertFfmpeg(engine: string): Promise<void> {
	if (ffmpegConfirmed) return;
	await new Promise<void>((resolve, reject) => {
		const child = spawn('ffmpeg', ['-hide_banner', '-version'], { stdio: 'ignore' });
		child.on('error', (e) => {
			if ((e as NodeJS.ErrnoException).code === 'ENOENT')
				reject(new TtsError(503, `${engine} needs ffmpeg, which is not installed on the server.`));
			else reject(new TtsError(500, `${engine}: cannot run ffmpeg (${e.message}).`));
		});
		child.on('close', (code) => {
			if (code === 0) {
				ffmpegConfirmed = true;
				resolve();
			} else {
				reject(new TtsError(500, `${engine}: ffmpeg is present but exited with code ${code}.`));
			}
		});
	});
}

/**
 * Byte length of a RIFF/WAVE buffer's `data` chunk — i.e. how much audio the engine
 * actually produced. Zero means the engine ran fine and had nothing to pronounce.
 *
 * That case is real and common, not an edge case: a converted book routinely contains
 * paragraphs that are only an em-dash, an ellipsis or a stray zero-width space (a
 * scene break, a stripped markdown rule), and `groupChunks` flushes at every paragraph
 * boundary, so each becomes a synthesis unit of its own. ECI answers those with a
 * well-formed but empty 44-byte WAV and exit 0 — success, nothing to say — which must
 * not be confused with a crash (non-zero exit), because the two need opposite handling.
 *
 * Walks the chunk list rather than assuming the canonical 44-byte header, since a WAV
 * may carry LIST/fact chunks ahead of `data`.
 */
export function wavSampleBytes(buf: Buffer): number {
	if (
		buf.length < 12 ||
		buf.toString('latin1', 0, 4) !== 'RIFF' ||
		buf.toString('latin1', 8, 12) !== 'WAVE'
	)
		return 0;
	let off = 12;
	while (off + 8 <= buf.length) {
		const id = buf.toString('latin1', off, off + 4);
		const size = buf.readUInt32LE(off + 4);
		// Trust the buffer over a declared size that overruns it (truncated capture).
		if (id === 'data') return Math.max(0, Math.min(size, buf.length - (off + 8)));
		off += 8 + size + (size % 2); // chunks are word-aligned
	}
	return 0;
}
