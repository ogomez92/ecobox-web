/**
 * Video -> audio extraction.
 *
 * Ecobox plays video files through the same `<audio>` element as everything else,
 * so the picture is never rendered — but two things still argue for turning a
 * video into a real audio file: containers no browser can demux (.mkv, .avi, …)
 * are otherwise unplayable, and even a playable one makes the client stream the
 * whole video track to hear the audio.
 *
 * The shape mirrors the book pipeline (bookConvert): convert, verify the result
 * independently, and only then reclaim the original. A failure at any step leaves
 * the source untouched — never delete on a guess.
 *
 * Audio is stream-copied whenever the codec is already something browsers play
 * (AAC/MP3/FLAC/Opus/Vorbis/ALAC), which turns a 4 GB mkv into its audio track in
 * seconds and loses nothing; anything else (AC-3, DTS, PCM, WMA…) is transcoded to
 * AAC. While ffmpeg has the container open, text-based subtitle streams are written
 * out as sidecar .srt files, which the subtitle finder then picks up by name.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import { resolveExistingPath, getRelativePath, resolvePath } from './files';
import { isVideoExtension } from '$lib/utils/mediaTypes';

const execFileAsync = promisify(execFile);

/** ffmpeg on a long transcode is slow but not unbounded; this is a stuck-process guard. */
const FFMPEG_TIMEOUT_MS = 60 * 60 * 1000;

export type VideoConvertStatus = 'converted' | 'failed';

export interface VideoConvertResult {
	status: VideoConvertStatus;
	/** Media-root-relative path of the produced audio file (on success). */
	audioPath?: string;
	/** Media-root-relative paths of any subtitle sidecars written alongside it. */
	subtitlePaths?: string[];
	/** Whether the audio track was copied verbatim rather than re-encoded. */
	copied?: boolean;
	/** Duration in seconds, as measured on the produced file (0 if unknown). */
	duration?: number;
	/** A concise, user-facing cause when status is 'failed'. */
	reason?: string;
}

// ---------------------------------------------------------------------------
// Probing
// ---------------------------------------------------------------------------

interface ProbeStream {
	index: number;
	codec_type?: string;
	codec_name?: string;
	channels?: number;
	duration?: string;
	tags?: Record<string, string>;
}

interface ProbeResult {
	streams: ProbeStream[];
	format?: { duration?: string };
}

async function ffprobe(absPath: string): Promise<ProbeResult | null> {
	try {
		const { stdout } = await execFileAsync(
			'ffprobe',
			['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', absPath],
			{ maxBuffer: 16 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }
		);
		return JSON.parse(stdout) as ProbeResult;
	} catch (err) {
		console.error('ffprobe failed:', err);
		return null;
	}
}

/** Seconds from a probe, preferring the stream's own duration over the container's. */
function probeDuration(probe: ProbeResult | null, stream?: ProbeStream): number {
	const raw = stream?.duration ?? probe?.format?.duration;
	const value = Number(raw);
	return Number.isFinite(value) && value > 0 ? value : 0;
}

// ---------------------------------------------------------------------------
// Target selection
// ---------------------------------------------------------------------------

export interface AudioTarget {
	/** Output file extension, including the dot. */
	extension: string;
	/** True when the source stream can be muxed across untouched. */
	copy: boolean;
}

/**
 * Where a given audio codec should land. Copying is preferred — it is instant and
 * lossless — but only into a container that both ffmpeg and browsers accept for
 * that codec. Everything else becomes AAC in an .m4a, the widest-support pair.
 */
const COPYABLE_CODECS: Record<string, string> = {
	aac: '.m4a',
	alac: '.m4a',
	mp3: '.mp3',
	flac: '.flac',
	opus: '.opus',
	vorbis: '.ogg'
};

export function chooseAudioTarget(codec: string | undefined): AudioTarget {
	const extension = COPYABLE_CODECS[(codec ?? '').toLowerCase()];
	return extension ? { extension, copy: true } : { extension: '.m4a', copy: false };
}

/**
 * A free path next to the source, keeping the source's base name so the sidecar
 * rules still line up (`movie.mkv` -> `movie.m4a` keeps `movie.en.srt` matching).
 * Only a genuine collision gets a suffix.
 */
async function freeOutputPath(dirRel: string, base: string, extension: string): Promise<string> {
	const join = (name: string) => (dirRel === '.' || dirRel === '' ? name : `${dirRel}/${name}`);

	for (let attempt = 0; attempt < 100; attempt++) {
		const name = attempt === 0 ? `${base}${extension}` : `${base} (audio ${attempt})${extension}`;
		const rel = join(name);
		try {
			await fs.access(resolvePath(rel));
		} catch {
			return rel; // nothing there — this one is ours
		}
	}
	throw new Error('no free output name');
}

// ---------------------------------------------------------------------------
// Subtitles
// ---------------------------------------------------------------------------

/**
 * Subtitle codecs that carry actual text. Image-based tracks (PGS on Blu-ray
 * rips, VobSub on DVD rips) are deliberately skipped: converting them would need
 * OCR, and half-transcribed captions are worse than none.
 */
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'subviewer', 'subviewer1']);

/**
 * Pull every text subtitle stream out as a sidecar `.srt`, named
 * `<base>.<language>.srt` so the finder's prefix matching picks it up. Never
 * throws and never overwrites: a subtitle we fail to extract is a missing extra,
 * not a failed conversion.
 */
async function extractSubtitles(
	absInput: string,
	dirRel: string,
	base: string,
	streams: ProbeStream[]
): Promise<string[]> {
	const textStreams = streams.filter(
		(s) => s.codec_type === 'subtitle' && TEXT_SUBTITLE_CODECS.has((s.codec_name ?? '').toLowerCase())
	);
	if (textStreams.length === 0) return [];

	const join = (name: string) => (dirRel === '.' || dirRel === '' ? name : `${dirRel}/${name}`);
	const written: string[] = [];
	const used = new Set<string>();

	for (const [ordinal, stream] of textStreams.entries()) {
		// Prefer the declared language ("eng"), fall back to the track's position so
		// several unlabelled tracks stay distinguishable.
		const language = (stream.tags?.language ?? '').trim().toLowerCase();
		const label = /^[a-z]{2,3}$/.test(language) ? language : String(ordinal + 1);
		let name = textStreams.length === 1 && !language ? `${base}.srt` : `${base}.${label}.srt`;
		if (used.has(name)) name = `${base}.${label}.${ordinal + 1}.srt`;
		used.add(name);

		const rel = join(name);
		try {
			await fs.access(resolvePath(rel));
			continue; // a sidecar with that name already exists — leave the user's file alone
		} catch {
			// not there: go ahead
		}

		try {
			await execFileAsync(
				'ffmpeg',
				['-nostdin', '-n', '-v', 'error', '-i', absInput, '-map', `0:${stream.index}`, '-c:s', 'srt', resolvePath(rel)],
				{ maxBuffer: 4 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS }
			);
			const stats = await fs.stat(resolvePath(rel));
			if (stats.size > 0) written.push(rel);
			else await fs.rm(resolvePath(rel), { force: true });
		} catch (err) {
			console.error(`Subtitle stream ${stream.index} extraction failed:`, err);
			await fs.rm(resolvePath(rel), { force: true }).catch(() => {});
		}
	}

	return written;
}

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Extract the audio track of a video into a sibling audio file and, once the
 * result verifies, delete the video. Runs synchronously (v1), like book
 * conversion; the route keeps the seam for moving it to a job queue.
 */
export async function extractVideoAudio(relInputPath: string): Promise<VideoConvertResult> {
	// Canonicalize first: clients send NFC, accented names are often stored NFD, and
	// ffmpeg matches bytes exactly.
	let absInput: string;
	try {
		absInput = resolveExistingPath(relInputPath);
		relInputPath = getRelativePath(absInput);
	} catch (err) {
		if (String((err as Error)?.message ?? '').includes('traversal')) throw err;
		return { status: 'failed', reason: 'the file could not be found' };
	}

	if (!isVideoExtension(relInputPath)) {
		return { status: 'failed', reason: `${path.extname(relInputPath) || 'that file'} is not a video` };
	}

	try {
		const stats = await fs.stat(absInput);
		if (!stats.isFile()) return { status: 'failed', reason: 'that path is not a file' };
	} catch {
		return { status: 'failed', reason: 'the file could not be found' };
	}

	const probe = await ffprobe(absInput);
	if (!probe) {
		return { status: 'failed', reason: 'ffprobe could not read the video (is ffmpeg installed?)' };
	}

	const streams = probe.streams ?? [];
	const audioStream = streams.find((s) => s.codec_type === 'audio');
	if (!audioStream) {
		return { status: 'failed', reason: 'the video has no audio track' };
	}

	const sourceDuration = probeDuration(probe, audioStream);
	const target = chooseAudioTarget(audioStream.codec_name);

	const dirRel = path.dirname(relInputPath);
	const base = path.basename(relInputPath, path.extname(relInputPath));

	let outputRel: string;
	try {
		outputRel = await freeOutputPath(dirRel, base, target.extension);
	} catch {
		return { status: 'failed', reason: 'no free name was available for the audio file' };
	}
	const outputAbs = resolvePath(outputRel);

	// -vn/-sn/-dn drop everything but audio; -map picks the exact stream we probed
	// (files with several audio tracks otherwise depend on ffmpeg's own choice).
	// -map_metadata keeps title/artist tags. +faststart moves the MP4 index to the
	// front, without which a browser must download the whole file before it can seek.
	const args = ['-nostdin', '-n', '-v', 'error', '-i', absInput, '-map', `0:${audioStream.index}`, '-vn', '-sn', '-dn', '-map_metadata', '0'];
	if (target.copy) {
		args.push('-c:a', 'copy');
	} else {
		args.push('-c:a', 'aac', '-b:a', '128k');
		// Surround downmixed to stereo: smaller, and multichannel AAC playback is
		// patchy across browsers.
		if ((audioStream.channels ?? 2) > 2) args.push('-ac', '2');
	}
	if (target.extension === '.m4a') args.push('-movflags', '+faststart');
	args.push(outputAbs);

	try {
		await execFileAsync('ffmpeg', args, { maxBuffer: 8 * 1024 * 1024, timeout: FFMPEG_TIMEOUT_MS });
	} catch (err) {
		console.error('ffmpeg audio extraction failed:', err);
		await fs.rm(outputAbs, { force: true }).catch(() => {});
		const e = err as NodeJS.ErrnoException & { stderr?: string; killed?: boolean };
		if (e.code === 'ENOENT') return { status: 'failed', reason: 'ffmpeg is not installed on the server' };
		if (e.killed) return { status: 'failed', reason: 'the conversion took too long and was stopped' };
		const firstLine = (e.stderr || e.message || '').split('\n').find((l) => l.trim())?.trim();
		return { status: 'failed', reason: firstLine ? `ffmpeg failed (${firstLine})` : 'ffmpeg could not extract the audio' };
	}

	// Verify independently of ffmpeg's exit code: a truncated or silent result must
	// not cost the user their only copy of the file.
	const outputProbe = await ffprobe(outputAbs);
	const outputDuration = probeDuration(outputProbe, outputProbe?.streams?.find((s) => s.codec_type === 'audio'));
	let outputSize = 0;
	try {
		outputSize = (await fs.stat(outputAbs)).size;
	} catch {
		outputSize = 0;
	}

	// A stream copy is sample-exact, so any real shortfall is a truncated file; 2%
	// (with a 2s floor for short clips) absorbs the usual container rounding.
	const tolerated = Math.max(2, sourceDuration * 0.02);
	const durationOk = sourceDuration === 0 || outputDuration >= sourceDuration - tolerated;

	if (outputSize === 0 || !durationOk) {
		await fs.rm(outputAbs, { force: true }).catch(() => {});
		return {
			status: 'failed',
			reason:
				outputSize === 0
					? 'the extracted audio was empty'
					: `the extracted audio was too short (${Math.round(outputDuration)}s of ${Math.round(sourceDuration)}s)`
		};
	}

	// Subtitles come out before the source goes: they only exist inside it.
	const subtitlePaths = await extractSubtitles(absInput, dirRel, base, streams);

	// Verified — reclaim the original. A failure here is non-fatal: the audio is
	// already written, so log it and keep the (now redundant) video rather than
	// calling the whole conversion failed.
	await fs.unlink(absInput).catch((err) => console.error('Failed to remove video after verify:', err));

	return {
		status: 'converted',
		audioPath: outputRel,
		subtitlePaths,
		copied: target.copy,
		duration: outputDuration
	};
}
