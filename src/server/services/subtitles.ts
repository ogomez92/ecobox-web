import fs from 'fs/promises';
import path from 'path';
import { resolveExistingPath } from './files';
import type { SubtitleCue } from '$lib/types';

/**
 * Sidecar subtitles (.srt / .vtt).
 *
 * A subtitle track is a plain sibling file: `Chapter 1.mp3` → `Chapter 1.srt`
 * (`Chapter 1.mp3.srt` is accepted too, since some rippers write that, and so is
 * `.vtt` in either form). Nothing is embedded and nothing is registered —
 * dropping the file next to the media is the whole contract, which is also what
 * makes it work for one file of a chaptered/DAISY folder as much as for a
 * standalone file.
 *
 * Beyond the exact names, any sibling track whose name merely *starts* with the
 * media name is accepted — `movie-forced.srt`, `movie.en.vtt`, `movie.mp4.es.srt`
 * — because that is how downloaded and extracted tracks are actually named. See
 * pickSubtitleFile for how a near-miss is kept from stealing another file's track.
 *
 * The parser is deliberately forgiving: real-world subtitle files come from dozens
 * of tools and routinely have missing indices, missing blank lines, `.` instead of
 * `,` before the milliseconds, HTML/ASS markup, and legacy encodings. A file we
 * can't make sense of yields `[]` — subtitles must never break playback.
 */

/** Sidecar formats, in the order they are preferred when both exist. */
export const SUBTITLE_EXTENSIONS = ['.srt', '.vtt'];

export type SubtitleFormat = 'srt' | 'vtt';

/** Sanity ceiling: a subtitle file is text, a multi-MB one is a mistake. */
const MAX_SUBTITLE_BYTES = 8 * 1024 * 1024;
/** Ceiling on parsed cues; a feature-length film has a few thousand. */
const MAX_CUES = 50_000;

// MARK: - Parsing

/** `HH:MM:SS,mmm`, with the hours optional and `.` accepted for the decimal. */
const TIMESTAMP = String.raw`(?:(\d+):)?(\d{1,3}):(\d{1,2})[.,](\d{1,3})`;
const TIMING_RE = new RegExp(`^\\s*${TIMESTAMP}\\s*-->\\s*${TIMESTAMP}`);

/** WebVTT blocks that carry no cues: their body is comments, CSS or region setup. */
const VTT_BLOCK_RE = /^(NOTE|STYLE|REGION)(\s|$)/;

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
 * Strip the markup subtitle authors sprinkle in — `<i>`/`<font …>` tags, WebVTT's
 * `<v Speaker>`/`<c.loud>`/`<00:00:01.000>` spans, and ASS/SSA override blocks
 * like `{\an8}` — and normalize whitespace. Line breaks *between* lines are kept:
 * they're the cue's own layout, and the reader shows them as written.
 */
function cleanCueText(lines: string[]): string {
	return lines
		.map((line) =>
			line
				.replace(/\{\\[^}]*\}/g, '') // {\an8}, {\pos(…)}
				.replace(/<[^>]+>/g, '') // <i>, </i>, <font color="#fff">, <v Bob>
				.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, decodeEntity)
				.replace(/\s+/g, ' ')
				.trim()
		)
		.filter((line) => line.length > 0)
		.join('\n');
}

/**
 * Parse a .srt or .vtt document into time-ordered cues.
 *
 * Cues are found by their timing line rather than by blank-line blocks, so a file
 * that omits indices or separators still parses. Text runs until a blank line, the
 * next timing line, or the line that introduces one. The two formats differ only
 * in what precedes a cue: SubRip puts a bare number there, WebVTT an optional
 * free-text identifier (plus NOTE/STYLE/REGION blocks that carry no cues at all).
 * Cue settings trailing a WebVTT timing line (`align:start position:10%`) need no
 * handling — the timing pattern only claims the front of the line.
 */
export function parseSubtitles(input: string, format: SubtitleFormat = 'srt'): SubtitleCue[] {
	const lines = input.replace(/^\uFEFF/, '').split(/\r\n|\r|\n/);
	const cues: SubtitleCue[] = [];
	const isVtt = format === 'vtt';

	for (let i = 0; i < lines.length && cues.length < MAX_CUES; i++) {
		// A WebVTT comment/style/region block runs to the next blank line and must be
		// skipped wholesale — its body is not cue text.
		if (isVtt && VTT_BLOCK_RE.test(lines[i]) && (i === 0 || lines[i - 1].trim() === '')) {
			while (i < lines.length && lines[i].trim() !== '') i++;
			continue;
		}

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
			// The line right before a timing line introduces the *next* cue: a bare
			// number in SubRip, any identifier in WebVTT (where a blank line between
			// cues is mandatory, so nothing else can legitimately sit there).
			const introducesNextCue = j + 1 < lines.length && TIMING_RE.test(lines[j + 1]);
			if (introducesNextCue && (isVtt || /^\s*\d+\s*$/.test(line))) break;
			text.push(line);
		}
		i = j - 1; // resume at the separator; the loop's i++ steps onto it

		const cleaned = cleanCueText(text);
		// A cue with no text is a hole in the file, not a silence marker.
		if (cleaned) cues.push({ start, end: Math.max(end, start), text: cleaned });
	}

	return cues.sort((a, b) => a.start - b.start);
}

export const parseSrt = (input: string): SubtitleCue[] => parseSubtitles(input, 'srt');
export const parseVtt = (input: string): SubtitleCue[] => parseSubtitles(input, 'vtt');

/** Which parser dialect a file name asks for; unknown extensions read as SubRip. */
export function subtitleFormatOf(fileName: string): SubtitleFormat {
	return path.extname(fileName).toLowerCase() === '.vtt' ? 'vtt' : 'srt';
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

/** A name split at its final dot: `movie.mp4` → `movie` + `.mp4`. */
function splitExtension(name: string): { base: string; ext: string } {
	const ext = path.extname(name);
	return { base: ext ? name.slice(0, -ext.length) : name, ext: ext.toLowerCase() };
}

/**
 * Characters that read as "and now a qualifier": `movie-forced`, `movie.en`,
 * `movie_es`, `movie (cc)`. A prefix match that breaks at one of these is a far
 * better bet than one that lands mid-word, so it is ranked first.
 */
const QUALIFIER_BOUNDARY = /^[.\-_ ([]/;

/**
 * Choose the subtitle track for `mediaFileName` out of one directory's entries,
 * or null. Pure, so the (fiddly) ranking is unit-testable without a filesystem.
 *
 * Exact names win outright, in the order `<base>.srt`, `<base>.vtt`,
 * `<name.ext>.srt`, `<name.ext>.vtt`. Only then does prefix matching run, and it
 * is guarded: a candidate whose stem is another file's own name is skipped
 * entirely, so in a folder of `ep1.mp3` … `ep10.mp3` the track `ep10.srt` can
 * never be handed to `ep1.mp3`. What remains is ranked by whether the extra text
 * starts at a qualifier boundary, then by how little was added, then by format.
 */
export function pickSubtitleFile(mediaFileName: string, entryNames: string[]): string | null {
	const mediaFull = normalizeName(mediaFileName);
	const mediaBase = normalizeName(splitExtension(mediaFileName).base);
	if (!mediaBase) return null;

	const subtitles: { name: string; stem: string; ext: string }[] = [];
	// Every *other* file in the folder, by both its full name and its base name —
	// the two forms a sidecar of that file would be named after.
	const claimedByOthers = new Set<string>();

	for (const name of entryNames) {
		const { base, ext } = splitExtension(name);
		if (SUBTITLE_EXTENSIONS.includes(ext)) {
			subtitles.push({ name, stem: normalizeName(base), ext });
			continue;
		}
		const normalized = normalizeName(name);
		if (normalized === mediaFull) continue; // the media file itself claims nothing
		claimedByOthers.add(normalized);
		claimedByOthers.add(normalizeName(base));
	}

	for (const stem of [mediaBase, mediaFull]) {
		for (const ext of SUBTITLE_EXTENSIONS) {
			const exact = subtitles.find((s) => s.stem === stem && s.ext === ext);
			if (exact) return exact.name;
		}
	}

	const candidates = subtitles
		.filter((s) => s.stem.startsWith(mediaBase) && !claimedByOthers.has(s.stem))
		.map((s) => ({
			...s,
			boundary: QUALIFIER_BOUNDARY.test(s.stem.slice(mediaBase.length)) ? 0 : 1,
			extRank: SUBTITLE_EXTENSIONS.indexOf(s.ext)
		}))
		.sort(
			(a, b) =>
				a.boundary - b.boundary ||
				a.stem.length - b.stem.length ||
				a.extRank - b.extRank ||
				a.name.localeCompare(b.name)
		);

	return candidates[0]?.name ?? null;
}

/**
 * The sibling subtitle file for a media path, or null. Matching is
 * case-insensitive and Unicode-normalization-insensitive (accented names are
 * stored NFD on disk as often as NFC — see resolveExistingPath), so the directory
 * is listed once and compared rather than probed name by name.
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

	const names = entries.filter((entry) => !entry.isDirectory()).map((entry) => entry.name);
	const match = pickSubtitleFile(fileName, names);
	if (!match) return null;
	return dirRel === '.' ? match : `${dirRel}/${match}`;
}

export interface SubtitleTrack {
	/** Path of the subtitle file relative to MEDIA_ROOT. */
	path: string;
	/** Which dialect it was parsed as. */
	format: SubtitleFormat;
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

	const format = subtitleFormatOf(subtitleRel);
	const key = `${stats.size}:${stats.mtimeMs}`;
	const cached = cache.get(absolutePath);
	if (cached?.key === key) return { path: subtitleRel, format, cues: cached.cues };

	const cues = parseSubtitles(decodeSubtitles(await fs.readFile(absolutePath)), format);
	if (cache.size > 64) cache.clear();
	cache.set(absolutePath, { key, cues });

	return { path: subtitleRel, format, cues };
}
