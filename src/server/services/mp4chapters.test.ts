import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractMP4Chapters } from './mp4chapters';

// --- Minimal MP4 builders ---------------------------------------------------

function u8(n: number) {
	return Buffer.from([n]);
}
function u16(n: number) {
	const b = Buffer.alloc(2);
	b.writeUInt16BE(n);
	return b;
}
function u32(n: number) {
	const b = Buffer.alloc(4);
	b.writeUInt32BE(n);
	return b;
}
function u64(n: bigint) {
	const b = Buffer.alloc(8);
	b.writeBigUInt64BE(n);
	return b;
}
function atom(type: string, ...payload: Buffer[]): Buffer {
	const body = Buffer.concat(payload);
	return Buffer.concat([u32(body.length + 8), Buffer.from(type, 'latin1'), body]);
}

/** version(1) + flags(3) prefix used by full boxes. */
const FULL = Buffer.alloc(4);

function tkhd(trackId: number) {
	return atom('tkhd', FULL, u32(0), u32(0), u32(trackId), Buffer.alloc(60));
}
function hdlr(handler: string) {
	return atom('hdlr', FULL, u32(0), Buffer.from(handler, 'latin1'), Buffer.alloc(12));
}
function mdhd(timescale: number) {
	return atom('mdhd', FULL, u32(0), u32(0), u32(timescale), u32(0), u32(0));
}

/** A QuickTime text sample: 2-byte length prefix + title bytes. */
function textSample(title: string | Buffer): Buffer {
	const body = Buffer.isBuffer(title) ? title : Buffer.from(title, 'utf8');
	return Buffer.concat([u16(body.length), body]);
}

interface BuildOptions {
	/** Omit the audio track's tref/chap back-reference. */
	noChapRef?: boolean;
	/** Handler type for the chapter track (defaults to 'text'). */
	textHandler?: string;
	/** Extra text tracks, to exercise the ambiguous-fallback guard. */
	extraTextTrack?: boolean;
}

/**
 * Build an MP4 with a QuickTime chapter track. Layout is ftyp → mdat → moov so
 * the sample offsets in `stco` are known before `moov` is assembled.
 */
function buildChapterTrackMp4(
	samples: Array<{ title: string | Buffer; duration: number }>,
	timescale: number,
	options: BuildOptions = {}
): Buffer {
	const ftyp = atom('ftyp', Buffer.from('M4A mp42isom', 'latin1'));
	const sampleBuffers = samples.map((s) => textSample(s.title));
	const mdatContent = Buffer.concat(sampleBuffers);
	const mdat = atom('mdat', mdatContent);
	const firstSampleOffset = ftyp.length + 8; // after mdat's own header

	const stts = atom(
		'stts',
		FULL,
		u32(samples.length),
		...samples.map((s) => Buffer.concat([u32(1), u32(s.duration)]))
	);
	const stsz = atom(
		'stsz',
		FULL,
		u32(0),
		u32(samples.length),
		...sampleBuffers.map((b) => u32(b.length))
	);
	// One chunk holding every sample
	const stsc = atom('stsc', FULL, u32(1), u32(1), u32(samples.length), u32(1));
	const stco = atom('stco', FULL, u32(1), u32(firstSampleOffset));
	const stbl = atom('stbl', stts, stsc, stsz, stco);

	const textTrak = atom(
		'trak',
		tkhd(2),
		atom('mdia', mdhd(timescale), hdlr(options.textHandler ?? 'text'), atom('minf', stbl))
	);

	const audioTrak = atom(
		'trak',
		tkhd(1),
		atom('mdia', mdhd(44100), hdlr('soun'), atom('minf', atom('stbl'))),
		...(options.noChapRef ? [] : [atom('tref', atom('chap', u32(2)))])
	);

	const extra = options.extraTextTrack
		? [atom('trak', tkhd(3), atom('mdia', mdhd(1000), hdlr('text'), atom('minf', atom('stbl'))))]
		: [];

	const moov = atom('moov', atom('mvhd', FULL, Buffer.alloc(96)), audioTrak, textTrak, ...extra);
	return Buffer.concat([ftyp, mdat, moov]);
}

/** Build an MP4 carrying Nero-style `moov/udta/chpl` chapters. */
function buildNeroChplMp4(
	chapters: Array<{ title: string; startSeconds: number }>,
	version = 1
): Buffer {
	const entries = chapters.map((c) => {
		const title = Buffer.from(c.title, 'utf8');
		return Buffer.concat([
			u64(BigInt(Math.round(c.startSeconds * 10_000_000))),
			u8(title.length),
			title
		]);
	});
	const chpl = atom(
		'chpl',
		Buffer.from([version, 0, 0, 0]),
		...(version !== 0 ? [u32(0)] : []),
		u8(chapters.length),
		...entries
	);
	const audioTrak = atom(
		'trak',
		tkhd(1),
		atom('mdia', mdhd(44100), hdlr('soun'), atom('minf', atom('stbl')))
	);
	const moov = atom('moov', atom('mvhd', FULL, Buffer.alloc(96)), audioTrak, atom('udta', chpl));
	return Buffer.concat([atom('ftyp', Buffer.from('M4A mp42isom', 'latin1')), moov]);
}

// --- Tests ------------------------------------------------------------------

let tmpDir: string;

beforeAll(() => {
	tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp4chapters-'));
});

afterAll(() => {
	fs.rmSync(tmpDir, { recursive: true, force: true });
});

let counter = 0;
function writeTemp(buffer: Buffer): string {
	const file = path.join(tmpDir, `test-${counter++}.m4b`);
	fs.writeFileSync(file, buffer);
	return file;
}

describe('extractMP4Chapters — QuickTime chapter track', () => {
	it('reads titles and start times from the referenced text track', () => {
		const file = writeTemp(
			buildChapterTrackMp4(
				[
					{ title: 'Opening Credits', duration: 1000 },
					{ title: 'Chapter 1', duration: 2500 },
					{ title: 'Chapter 2', duration: 500 }
				],
				1000
			)
		);

		expect(extractMP4Chapters(file)).toEqual([
			{ title: 'Opening Credits', startTime: 0, endTime: 1 },
			{ title: 'Chapter 1', startTime: 1, endTime: 3.5 },
			{ title: 'Chapter 2', startTime: 3.5 }
		]);
	});

	it('scales start times by the track timescale', () => {
		const file = writeTemp(
			buildChapterTrackMp4(
				[
					{ title: 'One', duration: 22050 },
					{ title: 'Two', duration: 11025 }
				],
				22050
			)
		);

		const chapters = extractMP4Chapters(file);
		expect(chapters.map((c) => c.startTime)).toEqual([0, 1]);
	});

	it('decodes UTF-16 titles flagged by a BOM', () => {
		const utf16be = Buffer.concat([
			Buffer.from([0xfe, 0xff]),
			Buffer.from('Café ☕', 'utf16le').swap16()
		]);
		const utf16le = Buffer.concat([
			Buffer.from([0xff, 0xfe]),
			Buffer.from('Naïve', 'utf16le')
		]);
		const file = writeTemp(
			buildChapterTrackMp4(
				[
					{ title: utf16be, duration: 1000 },
					{ title: utf16le, duration: 1000 }
				],
				1000
			)
		);

		expect(extractMP4Chapters(file).map((c) => c.title)).toEqual(['Café ☕', 'Naïve']);
	});

	it('falls back to a numbered title when a sample has no text', () => {
		const file = writeTemp(
			buildChapterTrackMp4(
				[
					{ title: '', duration: 1000 },
					{ title: '', duration: 1000 }
				],
				1000
			)
		);

		expect(extractMP4Chapters(file).map((c) => c.title)).toEqual(['Chapter 1', 'Chapter 2']);
	});

	it('uses a lone text track even without a tref/chap reference', () => {
		const file = writeTemp(
			buildChapterTrackMp4([{ title: 'Only', duration: 1000 }], 1000, { noChapRef: true })
		);

		expect(extractMP4Chapters(file).map((c) => c.title)).toEqual(['Only']);
	});

	it('ignores unreferenced text tracks when more than one exists', () => {
		const file = writeTemp(
			buildChapterTrackMp4([{ title: 'Ambiguous', duration: 1000 }], 1000, {
				noChapRef: true,
				extraTextTrack: true
			})
		);

		expect(extractMP4Chapters(file)).toEqual([]);
	});

	it('ignores subtitle tracks (sbtl handler)', () => {
		const file = writeTemp(
			buildChapterTrackMp4([{ title: 'Subtitle line', duration: 1000 }], 1000, {
				noChapRef: true,
				textHandler: 'sbtl'
			})
		);

		expect(extractMP4Chapters(file)).toEqual([]);
	});
});

describe('extractMP4Chapters — Nero chpl', () => {
	it('reads chapters from moov/udta/chpl (version 1)', () => {
		const file = writeTemp(
			buildNeroChplMp4([
				{ title: 'Intro', startSeconds: 0 },
				{ title: 'Part One', startSeconds: 12.5 }
			])
		);

		expect(extractMP4Chapters(file)).toEqual([
			{ title: 'Intro', startTime: 0 },
			{ title: 'Part One', startTime: 12.5 }
		]);
	});

	it('reads version 0 chpl (no reserved field)', () => {
		const file = writeTemp(buildNeroChplMp4([{ title: 'Solo', startSeconds: 3 }], 0));

		expect(extractMP4Chapters(file)).toEqual([{ title: 'Solo', startTime: 3 }]);
	});

	it('sorts chapters by start time', () => {
		const file = writeTemp(
			buildNeroChplMp4([
				{ title: 'Later', startSeconds: 30 },
				{ title: 'Earlier', startSeconds: 10 }
			])
		);

		expect(extractMP4Chapters(file).map((c) => c.title)).toEqual(['Earlier', 'Later']);
	});
});

describe('extractMP4Chapters — files without chapters', () => {
	it('returns [] for an MP4 with only an audio track', () => {
		const moov = atom(
			'moov',
			atom('mvhd', FULL, Buffer.alloc(96)),
			atom('trak', tkhd(1), atom('mdia', mdhd(44100), hdlr('soun'), atom('minf', atom('stbl'))))
		);
		const file = writeTemp(Buffer.concat([atom('ftyp', Buffer.from('M4A ', 'latin1')), moov]));

		expect(extractMP4Chapters(file)).toEqual([]);
	});

	it('returns [] for a file with no moov atom', () => {
		const file = writeTemp(atom('ftyp', Buffer.from('M4A ', 'latin1')));
		expect(extractMP4Chapters(file)).toEqual([]);
	});

	it('returns [] for truncated / garbage data instead of throwing', () => {
		const file = writeTemp(Buffer.from('not an mp4 at all, really'));
		expect(extractMP4Chapters(file)).toEqual([]);
	});

	it('returns [] for a missing file', () => {
		expect(extractMP4Chapters(path.join(tmpDir, 'does-not-exist.m4b'))).toEqual([]);
	});
});
