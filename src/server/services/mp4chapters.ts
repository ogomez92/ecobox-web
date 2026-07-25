import fs from 'fs';
import type { Chapter } from '$lib/types';

/**
 * Extract chapters from an MP4/M4A/M4B container.
 *
 * Two formats are supported, in the order players generally prefer them:
 *
 *  1. **QuickTime chapter track** — the audiobook standard (and what every m4b in
 *     the wild here uses). The audio track carries a `tref/chap` reference to a
 *     separate text track whose samples are the chapter titles; the sample table
 *     (`stts`/`stsz`/`stsc`/`stco`) gives their timing and file offsets.
 *  2. **Nero `chpl`** — a flat list in `moov/udta`, used by some taggers.
 *
 * Everything is read positionally through a file descriptor: `moov` often sits
 * behind a multi-gigabyte `mdat`, so the file is never slurped into memory.
 */
export function extractMP4Chapters(filePath: string): Chapter[] {
	let fd: number;
	try {
		fd = fs.openSync(filePath, 'r');
	} catch {
		return [];
	}

	try {
		const fileSize = fs.fstatSync(fd).size;
		const moov = findAtom(fd, 0, fileSize, 'moov');
		if (!moov) return [];

		const fromTrack = extractFromChapterTrack(fd, moov);
		if (fromTrack.length > 0) return fromTrack;

		return extractFromNeroChpl(fd, moov);
	} catch {
		// A malformed container must never break playback — just report no chapters.
		return [];
	} finally {
		fs.closeSync(fd);
	}
}

// --- Atom walking -----------------------------------------------------------

interface Atom {
	type: string;
	/** Offset of the atom header. */
	start: number;
	/** Offset of the first content byte (after the 8- or 16-byte header). */
	contentStart: number;
	/** Offset one past the last content byte. */
	end: number;
}

/** Atoms in [start, end) at a single nesting level. */
function listAtoms(fd: number, start: number, end: number): Atom[] {
	const atoms: Atom[] = [];
	const header = Buffer.alloc(16);
	let offset = start;

	while (offset + 8 <= end) {
		if (fs.readSync(fd, header, 0, 8, offset) !== 8) break;

		let size = header.readUInt32BE(0);
		const type = header.subarray(4, 8).toString('latin1');
		let headerLen = 8;

		if (size === 1) {
			// 64-bit extended size
			if (fs.readSync(fd, header, 8, 8, offset + 8) !== 8) break;
			const big = header.readBigUInt64BE(8);
			if (big > BigInt(Number.MAX_SAFE_INTEGER)) break;
			size = Number(big);
			headerLen = 16;
		} else if (size === 0) {
			// Extends to the end of the enclosing box
			size = end - offset;
		}

		if (size < headerLen || offset + size > end) break;
		if (!/^[\x20-\x7e]{4}$/.test(type)) break;

		atoms.push({ type, start: offset, contentStart: offset + headerLen, end: offset + size });
		offset += size;
	}

	return atoms;
}

function findAtom(fd: number, start: number, end: number, type: string): Atom | null {
	return listAtoms(fd, start, end).find((a) => a.type === type) ?? null;
}

/** Follow a path of nested atom types, e.g. ['mdia', 'minf', 'stbl']. */
function findPath(fd: number, parent: Atom, path: string[]): Atom | null {
	let current: Atom | null = parent;
	for (const type of path) {
		if (!current) return null;
		current = findAtom(fd, current.contentStart, current.end, type);
	}
	return current;
}

function readAtomContent(fd: number, atom: Atom, maxBytes = 64 * 1024 * 1024): Buffer {
	const length = Math.min(atom.end - atom.contentStart, maxBytes);
	const buffer = Buffer.alloc(Math.max(0, length));
	if (buffer.length > 0) fs.readSync(fd, buffer, 0, buffer.length, atom.contentStart);
	return buffer;
}

// --- QuickTime chapter track ------------------------------------------------

interface TrackInfo {
	trak: Atom;
	id: number;
	/** `mdia/hdlr` handler type: 'soun', 'text', 'vide', … */
	handler: string;
	timescale: number;
	/** Track IDs referenced by this track's `tref/chap`. */
	chapRefs: number[];
}

function extractFromChapterTrack(fd: number, moov: Atom): Chapter[] {
	const tracks = listAtoms(fd, moov.contentStart, moov.end)
		.filter((a) => a.type === 'trak')
		.map((trak) => readTrackInfo(fd, trak));

	const referenced = new Set(tracks.flatMap((t) => t.chapRefs));
	let chapterTrack = tracks.find((t) => referenced.has(t.id) && t.handler === 'text');

	// Some taggers write the chapter track without a `tref/chap` back-reference.
	// Fall back to a lone QuickTime text track ('text' — modern subtitle tracks
	// use 'sbtl'/'subp', so this stays clear of real subtitles).
	if (!chapterTrack) {
		const textTracks = tracks.filter((t) => t.handler === 'text');
		if (textTracks.length === 1) chapterTrack = textTracks[0];
	}

	if (!chapterTrack || chapterTrack.timescale <= 0) return [];

	const stbl = findPath(fd, chapterTrack.trak, ['mdia', 'minf', 'stbl']);
	if (!stbl) return [];

	const startTimes = readSampleTimes(fd, stbl);
	const offsets = readSampleOffsets(fd, stbl);
	if (startTimes.length === 0 || offsets.length === 0) return [];

	const count = Math.min(startTimes.length, offsets.length);
	const chapters: Chapter[] = [];

	for (let i = 0; i < count; i++) {
		const { offset, size } = offsets[i];
		const title = readTextSample(fd, offset, size);
		const startTime = startTimes[i] / chapterTrack.timescale;
		const next = i + 1 < count ? startTimes[i + 1] / chapterTrack.timescale : undefined;
		chapters.push({
			title: title || `Chapter ${i + 1}`,
			startTime,
			...(next !== undefined ? { endTime: next } : {})
		});
	}

	return chapters;
}

function readTrackInfo(fd: number, trak: Atom): TrackInfo {
	let id = 0;
	const tkhd = findAtom(fd, trak.contentStart, trak.end, 'tkhd');
	if (tkhd) {
		const buf = readAtomContent(fd, tkhd, 128);
		const version = buf[0];
		// version 0: creation(4) modification(4) trackID(4); version 1 uses 8-byte times
		const idOffset = version === 1 ? 4 + 16 : 4 + 8;
		if (buf.length >= idOffset + 4) id = buf.readUInt32BE(idOffset);
	}

	let handler = '';
	const hdlr = findPath(fd, trak, ['mdia', 'hdlr']);
	if (hdlr) {
		const buf = readAtomContent(fd, hdlr, 128);
		// version+flags(4) pre_defined/componentType(4) handlerType(4)
		if (buf.length >= 12) handler = buf.subarray(8, 12).toString('latin1');
	}

	let timescale = 0;
	const mdhd = findPath(fd, trak, ['mdia', 'mdhd']);
	if (mdhd) {
		const buf = readAtomContent(fd, mdhd, 64);
		const version = buf[0];
		const tsOffset = version === 1 ? 4 + 16 : 4 + 8;
		if (buf.length >= tsOffset + 4) timescale = buf.readUInt32BE(tsOffset);
	}

	const chapRefs: number[] = [];
	const tref = findAtom(fd, trak.contentStart, trak.end, 'tref');
	if (tref) {
		const chap = findAtom(fd, tref.contentStart, tref.end, 'chap');
		if (chap) {
			const buf = readAtomContent(fd, chap, 1024);
			for (let i = 0; i + 4 <= buf.length; i += 4) chapRefs.push(buf.readUInt32BE(i));
		}
	}

	return { trak, id, handler, timescale, chapRefs };
}

/** Guard against a malformed sample table allocating unbounded memory. */
const MAX_SAMPLES = 20000;

/** Per-sample start times, in track timescale units, from `stts`. */
function readSampleTimes(fd: number, stbl: Atom): number[] {
	const stts = findAtom(fd, stbl.contentStart, stbl.end, 'stts');
	if (!stts) return [];

	const buf = readAtomContent(fd, stts);
	if (buf.length < 8) return [];

	const entryCount = buf.readUInt32BE(4);
	const times: number[] = [];
	let time = 0;

	for (let i = 0; i < entryCount; i++) {
		const offset = 8 + i * 8;
		if (offset + 8 > buf.length) break;
		const sampleCount = buf.readUInt32BE(offset);
		const delta = buf.readUInt32BE(offset + 4);
		for (let s = 0; s < sampleCount; s++) {
			if (times.length >= MAX_SAMPLES) return times;
			times.push(time);
			time += delta;
		}
	}

	return times;
}

/** Per-sample file offset + size, resolved through `stsz` + `stsc` + `stco`/`co64`. */
function readSampleOffsets(fd: number, stbl: Atom): Array<{ offset: number; size: number }> {
	const sizes = readSampleSizes(fd, stbl);
	if (sizes.length === 0) return [];

	const chunkOffsets = readChunkOffsets(fd, stbl);
	if (chunkOffsets.length === 0) return [];

	// stsc: [first_chunk, samples_per_chunk, sample_description_index] runs
	const stsc = findAtom(fd, stbl.contentStart, stbl.end, 'stsc');
	if (!stsc) return [];
	const stscBuf = readAtomContent(fd, stsc);
	if (stscBuf.length < 8) return [];
	const stscCount = stscBuf.readUInt32BE(4);

	const runs: Array<{ firstChunk: number; samplesPerChunk: number }> = [];
	for (let i = 0; i < stscCount; i++) {
		const offset = 8 + i * 12;
		if (offset + 12 > stscBuf.length) break;
		runs.push({
			firstChunk: stscBuf.readUInt32BE(offset),
			samplesPerChunk: stscBuf.readUInt32BE(offset + 4)
		});
	}
	if (runs.length === 0) return [];

	const result: Array<{ offset: number; size: number }> = [];
	let sampleIndex = 0;
	let runIndex = 0;

	for (let chunk = 0; chunk < chunkOffsets.length && sampleIndex < sizes.length; chunk++) {
		const chunkNumber = chunk + 1;
		while (runIndex + 1 < runs.length && runs[runIndex + 1].firstChunk <= chunkNumber) runIndex++;
		const perChunk = runs[runIndex].samplesPerChunk;

		let offset = chunkOffsets[chunk];
		for (let s = 0; s < perChunk && sampleIndex < sizes.length; s++) {
			result.push({ offset, size: sizes[sampleIndex] });
			offset += sizes[sampleIndex];
			sampleIndex++;
		}
	}

	return result;
}

function readSampleSizes(fd: number, stbl: Atom): number[] {
	const stsz = findAtom(fd, stbl.contentStart, stbl.end, 'stsz');
	if (!stsz) return [];

	const buf = readAtomContent(fd, stsz);
	if (buf.length < 12) return [];

	const uniformSize = buf.readUInt32BE(4);
	const sampleCount = Math.min(buf.readUInt32BE(8), MAX_SAMPLES);

	if (uniformSize !== 0) return new Array(sampleCount).fill(uniformSize);

	const sizes: number[] = [];
	for (let i = 0; i < sampleCount; i++) {
		const offset = 12 + i * 4;
		if (offset + 4 > buf.length) break;
		sizes.push(buf.readUInt32BE(offset));
	}
	return sizes;
}

function readChunkOffsets(fd: number, stbl: Atom): number[] {
	const co64 = findAtom(fd, stbl.contentStart, stbl.end, 'co64');
	if (co64) {
		const buf = readAtomContent(fd, co64);
		if (buf.length < 8) return [];
		const count = Math.min(buf.readUInt32BE(4), MAX_SAMPLES);
		const offsets: number[] = [];
		for (let i = 0; i < count; i++) {
			const offset = 8 + i * 8;
			if (offset + 8 > buf.length) break;
			const value = buf.readBigUInt64BE(offset);
			if (value > BigInt(Number.MAX_SAFE_INTEGER)) break;
			offsets.push(Number(value));
		}
		return offsets;
	}

	const stco = findAtom(fd, stbl.contentStart, stbl.end, 'stco');
	if (!stco) return [];
	const buf = readAtomContent(fd, stco);
	if (buf.length < 8) return [];
	const count = Math.min(buf.readUInt32BE(4), MAX_SAMPLES);
	const offsets: number[] = [];
	for (let i = 0; i < count; i++) {
		const offset = 8 + i * 4;
		if (offset + 4 > buf.length) break;
		offsets.push(buf.readUInt32BE(offset));
	}
	return offsets;
}

/**
 * A QuickTime text sample: 2-byte big-endian length, then the title bytes,
 * optionally followed by encoding atoms we don't need. UTF-16 is signalled by a
 * BOM; anything else is UTF-8.
 */
function readTextSample(fd: number, offset: number, size: number): string {
	if (size < 2 || size > 64 * 1024) return '';

	const buf = Buffer.alloc(size);
	if (fs.readSync(fd, buf, 0, size, offset) < 2) return '';

	const length = Math.min(buf.readUInt16BE(0), buf.length - 2);
	if (length <= 0) return '';
	let text = buf.subarray(2, 2 + length);

	let title: string;
	if (text.length >= 2 && text[0] === 0xfe && text[1] === 0xff) {
		text = text.subarray(2);
		if (text.length % 2 !== 0) text = text.subarray(0, text.length - 1);
		title = Buffer.from(text).swap16().toString('utf16le');
	} else if (text.length >= 2 && text[0] === 0xff && text[1] === 0xfe) {
		text = text.subarray(2);
		if (text.length % 2 !== 0) text = text.subarray(0, text.length - 1);
		title = text.toString('utf16le');
	} else {
		title = text.toString('utf8');
	}

	return title.replace(/\0/g, '').trim();
}

// --- Nero chpl --------------------------------------------------------------

function extractFromNeroChpl(fd: number, moov: Atom): Chapter[] {
	const udta = findAtom(fd, moov.contentStart, moov.end, 'udta');
	if (!udta) return [];
	const chpl = findAtom(fd, udta.contentStart, udta.end, 'chpl');
	if (!chpl) return [];

	const buf = readAtomContent(fd, chpl, 1024 * 1024);
	if (buf.length < 5) return [];

	const version = buf[0];
	// version+flags(4), then a reserved u32 in version 1, then a u8 chapter count
	let offset = version !== 0 ? 8 : 4;
	if (offset + 1 > buf.length) return [];
	const count = buf[offset];
	offset += 1;

	const chapters: Chapter[] = [];
	for (let i = 0; i < count; i++) {
		if (offset + 9 > buf.length) break;
		const start = buf.readBigUInt64BE(offset);
		offset += 8;
		const titleLength = buf[offset];
		offset += 1;
		if (offset + titleLength > buf.length) break;
		const title = buf.subarray(offset, offset + titleLength).toString('utf8').replace(/\0/g, '').trim();
		offset += titleLength;

		chapters.push({
			// Nero timestamps are in 100-nanosecond units
			title: title || `Chapter ${i + 1}`,
			startTime: Number(start) / 10_000_000
		});
	}

	return chapters.sort((a, b) => a.startTime - b.startTime);
}
