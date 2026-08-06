import fs from 'fs/promises';
import path from 'path';
import { resolveExistingPath } from './files';
import type { SubtitleCue } from '$lib/types';

/**
 * SubRip (.srt) sidecar subtitles.
 *
 * A subtitle track is a plain sibling file: `Chapter 1.mp3` → `Chapter 1.srt`
 * (`Chapter 1.mp3.srt` is accepted too, since some rippers write that). Nothing
 * is embedded and nothing is registered — dropping the .srt next to the media is
 * the whole contract, which is also what makes it work for one file of a
 * chaptered/DAISY folder as much as for a standalone file.
 *
 * The parser is deliberately forgiving: real-world .srt files come from dozens of
 * tools and routinely have missing indices, missing blank lines, `.` instead of
 * `,` before the milliseconds, HTML/ASS markup, and legacy encodings. A file we
 * can't make sense of yields `[]` — subtitles must never break playback.
 */

export const SUBTITLE_EXTENSION = '.srt';

/** Sanity ceiling: a subtitle file is text, a multi-MB one is a mistake. */
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
/** Ceiling on parsed cues; a feature-length film has a few thousand. */
const MAX_CUES = 50_000;

// MARK: - Parsing

/** `HH:MM:SS,mmm`, with the hours optional and `.` accepted for the decimal. */
const TIMESTAMP = String.raw`(?:(\d+):)?(\d{1,3}):(\d{1,2})[.,](\d{1,3})`;
const TIMING_RE = new RegExp(`^\\s*${TIMESTAMP}\\s*-->\\s*${TIMESTAMP}`);

function toSeconds(hours: string | undefined, minutes: string, seconds: string, millis: string): number {
	return (
		Number(hours ?? 0) * 3600 +
		Number(minutes) * 60 +
		Number(seconds) +
		Number(millis.padEnd(3, '0')) / 1000
	);
}

const NAMED_ENTITIES: Record<string, string> = {
	amp: '&',
	lt: '<',
	gt: '>',
	quot: '"',
	apos: "'",
	nbsp: ' '
};

function decodeEntity(entity: string, body: string): string {
	if (body.startsWith('#')) {
		const code = body[1] === 'x' || body[1] === 'X'
			? parseInt(body.slice(2), 16)
			: parseInt(body.slice(1), 10);
		return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : entity;
	}
	return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
}

/**
 * Strip the markup subtitle authors sprinkle in — `<i>`/`<font …>` tags and
 * ASS/SSA override blocks like `{\an8}` — and normalize whitespace. Line breaks
 * *between* lines are kept: they're the cue's own layout, and the reader shows
 * them as written.
 */
function cleanCueText(lines: string[]): string {
	return lines
		.map((line) =>
			line
				.replace(/\{\\[^}]*\}/g, '') // {\an8}, {\pos(…)}
				.replace(/<[^>]+>/g, '') // <i>, </i>, <font color="#fff">
				.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
				.replace(/\s+/g, ' ')
				.trim()
		)
		.filter((line) => line.length > 0)
		.join('\n');
}

/**
 * Parse a .srt document into time-ordered cues.
 *
 * Cues are found by their timing line rather than by blank-line blocks, so a file
 * that omits indices or separators still parses. Text runs until a blank line, the
 * next timing line, or the bare index that precedes one.
 */
export function parseSrt(input: string): SubtitleCue[] {
	const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
	const cues: SubtitleCue[] = [];

	for (let i = 0; i < lines.length && cues.length < MAX_CUES; i++) {
		const timing = TIMING_RE.exec(lines[i]);
		if (!timing) continue;

		const start = toSeconds(timing[1], timing[2], timing[3], timing[4]);
		const end = toSeconds(timing[5], timing[6], timing[7], timing[8]);

		const text: string[] = [];
		let j = i + 1;
		for (; j < lines.length; j++) {
			const line = lines[j];
			if (line.trim() === '') break; // the normal cue separator
			if (TIMING_RE.test(line)) break; // separator missing — next cue starts here
			// A bare number immediately before a timing line is the *next* cue's index.
			if (/^\s*\d+\s*$/.test(line) && j + 1 < lines.length && TIMING_RE.test(lines[j + 1])) break;
			text.push(line);
		}
		i = j - 1; // resume at the separator; the loop's i++ steps onto it

		const cleaned = cleanCueText(text);
		// A cue with no text is a hole in the file, not a silence marker.
		if (cleaned) cues.push({ start, end: Math.max(end, start), text: cleaned });
	}

	return cues.sort((a, b) => a.start - b.start);
}

// MARK: - Reading

/**
 * Subtitle files predate UTF-8 habits: Spanish and French .srt files off the
 * shelf are routinely windows-1252, and Windows tools sometimes emit UTF-16.
 * Same rescue as the DAISY navigation files — decode as UTF-8 and fall back when
 * that yields replacement characters.
 */
function decodeSubtitles(buffer: Buffer): string {
	if (buffer.length >= 2) {
		if (buffer[0] === 0xff && buffer[1] === 0xfe) return new TextDecoder('utf-16le').decode(buffer);
		if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer);
	}
	const utf8 = buffer.toString('utf8');
	return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8;
}

const normalizeName = (name: string) => name.normalize('NFC').toLowerCase();

/** `movie.mp4` → `movie.srt`, then `movie.mp4.srt`. In preference order. */
function subtitleCandidates(fileName: string): string[] {
	const ext = path.extname(fileName);
	const base = ext ? fileName.slice(0, -ext.length) : fileName;
	const candidates = [`${base}${SUBTITLE_EXTENSION}`];
	if (ext) candidates.push(`${fileName}${SUBTITLE_EXTENSION}`);
	return candidates.map(normalizeName);
}

/**
 * The sibling .srt for a media path, or null. Matching is case-insensitive and
 * Unicode-normalization-insensitive (accented names are stored NFD on disk as
 * often as NFC — see resolveExistingPath), so the directory is listed once and
 * compared rather than probed name by name.
 */
export async function findSubtitleFile(mediaRelPath: string): Promise<string | null> {
	const fileName = path.basename(mediaRelPath);
	if (!fileName) return null;

	const dirRel = path.dirname(mediaRelPath);
	const dirAbs = resolveExistingPath(dirRel === '.' ? '' : dirRel);

	let entries;
	try {
		entries = await fs.readdir(dirAbs, { withFileTypes: true });
	} catch {
		return null; // Folder gone or unreadable — simply no subtitles.
	}

	for (const candidate of subtitleCandidates(fileName)) {
		const match = entries.find((entry) => !entry.isDirectory() && normalizeName(entry.name) === candidate);
		if (match) return dirRel === '.' ? match.name : `${dirRel}/${match.name}`;
	}
	return null;
}

export interface SubtitleTrack {
	/** Path of the .srt relative to MEDIA_ROOT. */
	path: string;
	cues: SubtitleCue[];
}

// Parsed cues, keyed by absolute path and invalidated by size + mtime — the same
// contract as the duration cache. Never user data; safe to drop at any time.
const cache = new Map<string, { key: string; cues: SubtitleCue[] }>();

/** Find and parse the sibling subtitle track of a media file, or null. */
export async function getSubtitles(mediaRelPath: string): Promise<SubtitleTrack | null> {
	const subtitleRel = await findSubtitleFile(mediaRelPath);
	if (!subtitleRel) return null;

	const absolutePath = resolveExistingPath(subtitleRel);
	const stats = await fs.stat(absolutePath);
	if (!stats.isFile() || stats.size > MAX_SUBTITLE_BYTES) return null;

	const key = `${stats.size}:${stats.mtimeMs}`;
	const cached = cache.get(absolutePath);
	if (cached?.key === key) return { path: subtitleRel, cues: cached.cues };

	const cues = parseSrt(decodeSubtitles(await fs.readFile(absolutePath)));
	if (cache.size > 64) cache.clear();
	cache.set(absolutePath, { key, cues });

	return { path: subtitleRel, cues };
}
