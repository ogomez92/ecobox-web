import { describe, it, expect } from 'vitest';
import { groupChunks, singletonUnits, unitForChunk, type Unit } from './ttsUnits';
import type { Chunk } from '$lib/types';

function chunk(i: number, para: number, type: Chunk['type'], text: string): Chunk {
	return { i, para, type, text };
}

// Two paragraphs (para 1 has 3 sentences, para 2 has 2) plus headings.
const sample: Chunk[] = [
	chunk(0, 0, 'heading', 'Chapter One'),
	chunk(1, 1, 'paragraph', 'Aaa.'),
	chunk(2, 1, 'paragraph', 'Bbb.'),
	chunk(3, 1, 'paragraph', 'Ccc.'),
	chunk(4, 2, 'paragraph', 'Ddd.'),
	chunk(5, 2, 'paragraph', 'Eee.'),
	chunk(6, 3, 'heading', 'Chapter Two'),
	chunk(7, 4, 'paragraph', 'Fff.')
];

function covers(units: Unit[], total: number) {
	// Units must tile [0, total) contiguously with no gaps or overlaps.
	let next = 0;
	for (const u of units) {
		expect(u.startIndex).toBe(next);
		expect(u.endIndex).toBeGreaterThanOrEqual(u.startIndex);
		next = u.endIndex + 1;
	}
	expect(next).toBe(total);
}

describe('groupChunks', () => {
	it('keeps each heading as its own unit and merges sentences within a paragraph', () => {
		const units = groupChunks(sample, 1500);
		// heading(0), para1(1-3), para2(4-5), heading(6), para4(7)
		expect(units.map((u) => [u.startIndex, u.endIndex])).toEqual([
			[0, 0],
			[1, 3],
			[4, 5],
			[6, 6],
			[7, 7]
		]);
		expect(units[1].text).toBe('Aaa. Bbb. Ccc.');
		covers(units, sample.length);
	});

	it('never crosses a paragraph boundary', () => {
		const units = groupChunks(sample, 1500);
		// The 3-sentence paragraph and the 2-sentence paragraph stay separate.
		expect(units.some((u) => u.startIndex === 1 && u.endIndex === 5)).toBe(false);
	});

	it('splits on the char budget but never splits a single sentence', () => {
		// maxChars small enough that two 4-char sentences (+space) exceed it.
		const units = groupChunks(sample.slice(1, 4), 6);
		// Each sentence becomes its own unit.
		expect(units).toHaveLength(3);
		covers(units, 3);
	});

	it('emits a long single sentence as its own unit', () => {
		const long = 'x'.repeat(5000) + '.';
		const units = groupChunks([chunk(0, 0, 'paragraph', long)], 1500);
		expect(units).toHaveLength(1);
		expect(units[0].text).toBe(long);
	});
});

describe('unitForChunk', () => {
	it('maps every chunk index to a unit that contains it', () => {
		const units = groupChunks(sample, 1500);
		for (let i = 0; i < sample.length; i++) {
			const u = units[unitForChunk(units, i)];
			expect(i).toBeGreaterThanOrEqual(u.startIndex);
			expect(i).toBeLessThanOrEqual(u.endIndex);
		}
	});
});

describe('singletonUnits', () => {
	it('produces one unit per chunk', () => {
		const units = singletonUnits(sample);
		expect(units).toHaveLength(sample.length);
		covers(units, sample.length);
		expect(units[2]).toEqual({ startIndex: 2, endIndex: 2, text: 'Bbb.' });
	});
});
