/**
 * Pure planning for "Convert to audio": which synthesis units a book export
 * speaks, where its chapters start, what it costs, and what the file is called.
 * No I/O, so the server job and the tests share exactly the same rules.
 *
 * Units are the reader's own grouping (`groupChunks` at AUDIO_UNIT_MAX_CHARS),
 * with the same ElevenLabs context slices, so an export and a listening session
 * produce the same `unitHash` — audio already synthesized for one is free for
 * the other.
 */
import type { Chunk, TtsQuota } from '$lib/types';
import { groupChunks, unitForChunk, AUDIO_UNIT_MAX_CHARS, type Unit } from './ttsUnits';

/** ElevenLabs context window the reader sends around each unit (chars). */
export const CONTEXT_CHARS = 400;

export interface PlannedUnit extends Unit {
	/** Index in the book's full unit list. */
	index: number;
	/** Text before/after, as the reader sends it for ElevenLabs prosody. */
	previousText?: string;
	nextText?: string;
	/** True when this unit is a heading (a chapter starts here). */
	heading: boolean;
}

export interface PlannedChapter {
	title: string;
	/** Position in the export's unit list (not the book's). */
	unitOffset: number;
}

export interface ExportPlan {
	units: PlannedUnit[];
	chapters: PlannedChapter[];
	/** Total characters spoken. */
	chars: number;
}

/**
 * Plan an export of `chunks`, starting at the unit that holds `startChunk`
 * (0 = the whole book). A partial export whose first unit is not a heading opens
 * with the chapter it starts inside, so the file's first chapter is still named.
 */
export function planExport(chunks: Chunk[], startChunk = 0, maxChars = AUDIO_UNIT_MAX_CHARS): ExportPlan {
	const all = groupChunks(chunks, maxChars);
	if (all.length === 0) return { units: [], chapters: [], chars: 0 };
	const first = startChunk > 0 ? unitForChunk(all, startChunk) : 0;

	const units: PlannedUnit[] = [];
	for (let k = first; k < all.length; k++) {
		const u = all[k];
		units.push({
			...u,
			index: k,
			previousText: all[k - 1]?.text.slice(-CONTEXT_CHARS),
			nextText: all[k + 1]?.text.slice(0, CONTEXT_CHARS),
			heading: chunks[u.startIndex]?.type === 'heading'
		});
	}

	const chapters: PlannedChapter[] = [];
	if (units.length > 0 && !units[0].heading) {
		for (let k = first - 1; k >= 0; k--) {
			if (chunks[all[k].startIndex]?.type === 'heading') {
				chapters.push({ title: cleanTitle(all[k].text), unitOffset: 0 });
				break;
			}
		}
	}
	units.forEach((u, offset) => {
		if (u.heading) {
			const title = cleanTitle(u.text);
			if (title) chapters.push({ title, unitOffset: offset });
		}
	});

	return { units, chapters, chars: units.reduce((n, u) => n + u.text.length, 0) };
}

/** The heading that `chunkIndex` falls under, or null before the first heading. */
export function chapterAt(chunks: Chunk[], chunkIndex: number): string | null {
	for (let k = Math.min(chunkIndex, chunks.length - 1); k >= 0; k--) {
		if (chunks[k].type === 'heading') return cleanTitle(chunks[k].text) || null;
	}
	return null;
}

function cleanTitle(text: string): string {
	const t = text.replace(/\s+/g, ' ').trim();
	return t.length > 120 ? `${t.slice(0, 117)}…` : t;
}

/** Percent of the book before `chunkIndex`, floored so "100%" never means "not done". */
export function positionPercent(chunkIndex: number, totalChunks: number): number {
	if (totalChunks <= 0) return 0;
	return Math.max(0, Math.min(99, Math.floor((chunkIndex / totalChunks) * 100)));
}

/**
 * Whether reading has meaningfully started: past the first sentence and not
 * parked on the last one (a finished book offers only "whole book").
 */
export function hasReadingPosition(chunkIndex: number | null | undefined, totalChunks: number): boolean {
	return typeof chunkIndex === 'number' && chunkIndex > 0 && chunkIndex < totalChunks - 1;
}

/** Output file name: the book's folder name, plus where a partial export starts. */
export function exportFileName(bookName: string, fromPercent?: number): string {
	const base = bookName.replace(/[\\/:*?"<>|\u0000-\u001f]/g, ' ').replace(/[. ]+$/, '').trim() || 'Book';
	return fromPercent === undefined ? `${base}.mp3` : `${base} (from ${fromPercent}%).mp3`;
}

/** `name.mp3` → `name (2).mp3`, … — the first candidate `taken` doesn't hold. */
export function uniqueFileName(name: string, taken: (candidate: string) => boolean): string {
	if (!taken(name)) return name;
	const dot = name.lastIndexOf('.');
	const stem = dot > 0 ? name.slice(0, dot) : name;
	const ext = dot > 0 ? name.slice(dot) : '';
	for (let n = 2; n < 1000; n++) {
		const candidate = `${stem} (${n})${ext}`;
		if (!taken(candidate)) return candidate;
	}
	return `${stem} (${Date.now()})${ext}`;
}

/** True when a known quota can't cover `chars` (unknown quota never blocks). */
export function exceedsQuota(chars: number, quota: TtsQuota | null | undefined): boolean {
	if (!quota || quota.limit <= 0) return false;
	return chars > quota.remaining;
}

/** Escape a value for an ffmpeg FFMETADATA1 file (`=`, `;`, `#`, `\` and newlines). */
export function escapeFfmetadata(value: string): string {
	return value.replace(/[\\=;#\n]/g, (c) => `\\${c}`);
}

/**
 * FFMETADATA1 text for the finished file: title tag plus one chapter per heading.
 * `chapterStarts` are seconds on the file's own timeline; each chapter ends where
 * the next begins and the last at `totalSeconds`.
 */
export function buildFfmetadata(
	title: string,
	chapters: { title: string; start: number }[],
	totalSeconds: number
): string {
	const lines = [';FFMETADATA1', `title=${escapeFfmetadata(title)}`, 'genre=Audiobook'];
	const ms = (s: number) => Math.max(0, Math.round(s * 1000));
	const end = ms(totalSeconds);
	chapters.forEach((c, k) => {
		const start = ms(c.start);
		const stop = k + 1 < chapters.length ? ms(chapters[k + 1].start) : end;
		if (stop <= start) return; // a heading with no audio after it adds nothing
		lines.push('[CHAPTER]', 'TIMEBASE=1/1000', `START=${start}`, `END=${stop}`, `title=${escapeFfmetadata(c.title)}`);
	});
	return lines.join('\n') + '\n';
}
