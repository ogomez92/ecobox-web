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
