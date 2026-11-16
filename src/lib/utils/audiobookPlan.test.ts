import { describe, it, expect } from 'vitest';
import type { Chunk } from '$lib/types';
import {
	planExport,
	chapterAt,
	positionPercent,
	hasReadingPosition,
	exportFileName,
	uniqueFileName,
	exceedsQuota,
	escapeFfmetadata,
	buildFfmetadata,
	CONTEXT_CHARS
} from './audiobookPlan';
import { groupChunks } from './ttsUnits';

let n = 0;
const h = (text: string, para: number): Chunk => ({ i: n++, text, para, type: 'heading' });
const p = (text: string, para: number): Chunk => ({ i: n++, text, para, type: 'paragraph' });

function book(): Chunk[] {
	n = 0;
	return [
		h('Chapter One', 0),
		p('First sentence.', 1),
		p('Second sentence.', 1),
		p('A new paragraph.', 2),
		h('Chapter Two', 3),
		p('Two starts here.', 4),
		p('And ends here.', 5)
	];
}

describe('planExport', () => {
	it('uses the reader’s own units, with a chapter per heading', () => {
		const chunks = book();
		const plan = planExport(chunks);
		expect(plan.units.map((u) => u.text)).toEqual(groupChunks(chunks, 5000).map((u) => u.text));
		expect(plan.units.map((u) => u.text)).toEqual([
			'Chapter One',
			'First sentence. Second sentence.',
			'A new paragraph.',
			'Chapter Two',
			'Two starts here.',
			'And ends here.'
		]);
		expect(plan.chapters).toEqual([
			{ title: 'Chapter One', unitOffset: 0 },
			{ title: 'Chapter Two', unitOffset: 3 }
		]);
		expect(plan.chars).toBe(plan.units.reduce((s, u) => s + u.text.length, 0));
	});

	it('gives ElevenLabs the same context slices the reader sends', () => {
		const long = 'x'.repeat(CONTEXT_CHARS + 50);
		n = 0;
		const chunks = [p(long, 0), p('middle', 1), p(long, 2)];
		const [first, mid, last] = planExport(chunks).units;
		expect(first.previousText).toBeUndefined();
		expect(mid.previousText).toBe(long.slice(-CONTEXT_CHARS));
		expect(mid.nextText).toBe(long.slice(0, CONTEXT_CHARS));
		expect(last.nextText).toBeUndefined();
	});

	it('starts at the unit holding the position and names the chapter it is inside', () => {
		const chunks = book();
		// chunk 2 ("Second sentence.") is inside unit 1 — the whole unit is kept
		const plan = planExport(chunks, 2);
		expect(plan.units[0].text).toBe('First sentence. Second sentence.');
		expect(plan.units[0].previousText).toBe('Chapter One');
		expect(plan.chapters).toEqual([
			{ title: 'Chapter One', unitOffset: 0 },
			{ title: 'Chapter Two', unitOffset: 2 }
		]);
	});

	it('does not invent a chapter when starting on a heading or before any heading', () => {
		const chunks = book();
		expect(planExport(chunks, 4).chapters).toEqual([
			{ title: 'Chapter Two', unitOffset: 0 }
		]);
		n = 0;
		const noHeadings = [p('One.', 0), p('Two.', 1)];
		expect(planExport(noHeadings, 1).chapters).toEqual([]);
	});

	it('is empty for an empty book', () => {
		expect(planExport([])).toEqual({ units: [], chapters: [], chars: 0 });
	});
});

describe('position helpers', () => {
	it('finds the chapter a chunk is in', () => {
		const chunks = book();
		expect(chapterAt(chunks, 2)).toBe('Chapter One');
		expect(chapterAt(chunks, 6)).toBe('Chapter Two');
		n = 0;
		expect(chapterAt([p('x', 0)], 0)).toBeNull();
	});

	it('floors the percentage and never says 100', () => {
		expect(positionPercent(0, 10)).toBe(0);
		expect(positionPercent(3, 10)).toBe(30);
		expect(positionPercent(999, 1000)).toBe(99);
		expect(positionPercent(5, 0)).toBe(0);
	});

	it('only offers "from position" once reading has started and not finished', () => {
		expect(hasReadingPosition(null, 10)).toBe(false);
		expect(hasReadingPosition(0, 10)).toBe(false);
		expect(hasReadingPosition(4, 10)).toBe(true);
		expect(hasReadingPosition(9, 10)).toBe(false);
	});
});

describe('file names', () => {
	it('names the file after the book, marking partial exports', () => {
		expect(exportFileName('My Book')).toBe('My Book.mp3');
		expect(exportFileName('My Book', 37)).toBe('My Book (from 37%).mp3');
		expect(exportFileName('a/b:c?')).toBe('a b c.mp3');
		expect(exportFileName('...')).toBe('Book.mp3');
	});

	it('never overwrites: picks the first free (n) suffix', () => {
		const taken = new Set(['Book.mp3', 'Book (2).mp3']);
		expect(uniqueFileName('Book.mp3', (c) => taken.has(c))).toBe('Book (3).mp3');
		expect(uniqueFileName('New.mp3', (c) => taken.has(c))).toBe('New.mp3');
	});
});

describe('exceedsQuota', () => {
	const quota = { used: 9000, limit: 10000, remaining: 1000 };
	it('blocks only what a known quota cannot cover', () => {
		expect(exceedsQuota(1000, quota)).toBe(false);
		expect(exceedsQuota(1001, quota)).toBe(true);
		expect(exceedsQuota(1e9, null)).toBe(false);
		expect(exceedsQuota(5, { used: 0, limit: 0, remaining: 0 })).toBe(false);
	});
});

describe('ffmetadata', () => {
	it('escapes the characters ffmpeg treats specially', () => {
		expect(escapeFfmetadata('a=b;c#d\\e\nf')).toBe('a\\=b\\;c\\#d\\\\e\\\nf');
	});

	it('writes chapters that end where the next one starts', () => {
		const text = buildFfmetadata('T', [
			{ title: 'One', start: 0 },
			{ title: 'Two', start: 2.5 }
		], 6);
		expect(text).toBe(
			[
				';FFMETADATA1',
				'title=T',
				'genre=Audiobook',
				'[CHAPTER]', 'TIMEBASE=1/1000', 'START=0', 'END=2500', 'title=One',
				'[CHAPTER]', 'TIMEBASE=1/1000', 'START=2500', 'END=6000', 'title=Two'
			].join('\n') + '\n'
		);
	});

	it('drops zero-length chapters (a heading with nothing after it)', () => {
		const text = buildFfmetadata('T', [
			{ title: 'Empty', start: 1 },
			{ title: 'Real', start: 1 }
		], 3);
		expect(text).not.toContain('title=Empty');
		expect(text).toContain('title=Real');
	});
});
