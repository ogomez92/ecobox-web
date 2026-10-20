import { describe, it, expect } from 'vitest';
import { sortEntries, SORT_FIELDS, DEFAULT_DIRECTION } from './fileSort';
import type { FileEntry } from '$lib/types';

function entry(name: string, extra: Partial<FileEntry> = {}): FileEntry {
	return {
		name,
		path: name,
		isDirectory: false,
		size: 0,
		modifiedAt: new Date('2026-01-01T00:00:00Z'),
		...extra
	};
}

const names = (list: FileEntry[]) => list.map((e) => e.name);

describe('sortEntries', () => {
	it('exposes five fields in shortcut order with sensible first directions', () => {
		expect(SORT_FIELDS).toEqual(['name', 'lastPlayed', 'duration', 'size', 'modifiedAt']);
		expect(DEFAULT_DIRECTION.name).toBe('asc');
		expect(DEFAULT_DIRECTION.duration).toBe('desc');
	});

	it('puts directories first whatever the field or direction', () => {
		const list = [entry('b.mp3', { size: 5 }), entry('a', { isDirectory: true }), entry('z', { isDirectory: true })];
		expect(names(sortEntries(list, 'size', 'desc'))).toEqual(['a', 'z', 'b.mp3']);
		expect(names(sortEntries(list, 'name', 'desc'))).toEqual(['z', 'a', 'b.mp3']);
	});

	it('sorts names naturally', () => {
		const list = [entry('10.mp3'), entry('2.mp3'), entry('1.mp3')];
		expect(names(sortEntries(list, 'name', 'asc'))).toEqual(['1.mp3', '2.mp3', '10.mp3']);
		expect(names(sortEntries(list, 'name', 'desc'))).toEqual(['10.mp3', '2.mp3', '1.mp3']);
	});

	it('sorts by duration with unknown durations last in both directions', () => {
		const list = [
			entry('short.mp3', { duration: 60 }),
			entry('unknown.mp3'),
			entry('long.mp3', { duration: 3600 }),
			entry('radio.radio')
		];
		expect(names(sortEntries(list, 'duration', 'desc'))).toEqual([
			'long.mp3',
			'short.mp3',
			'radio.radio',
			'unknown.mp3'
		]);
		expect(names(sortEntries(list, 'duration', 'asc'))).toEqual([
			'short.mp3',
			'long.mp3',
			'radio.radio',
			'unknown.mp3'
		]);
	});

	it('sorts by last played on one timeline, folders interleaved, never-played last', () => {
		const list = [
			entry('old.mp3', { lastPlayedAt: 1_000 }),
			entry('never.mp3'),
			entry('new.mp3', { lastPlayedAt: 9_000 }),
			entry('book', { isDirectory: true, lastPlayedAt: 5_000 }),
			entry('album', { isDirectory: true })
		];
		expect(names(sortEntries(list, 'lastPlayed', 'desc'))).toEqual([
			'new.mp3',
			'book',
			'old.mp3',
			'album',
			'never.mp3'
		]);
		expect(names(sortEntries(list, 'lastPlayed', 'asc'))).toEqual([
			'old.mp3',
			'book',
			'new.mp3',
			'album',
			'never.mp3'
		]);
	});

	it('ignores a directory\'s own size and breaks ties by name', () => {
		const list = [
			entry('b.mp3', { size: 10 }),
			entry('a.mp3', { size: 10 }),
			entry('big', { isDirectory: true, size: 4096 }),
			entry('alpha', { isDirectory: true, size: 8192 })
		];
		expect(names(sortEntries(list, 'size', 'desc'))).toEqual(['alpha', 'big', 'a.mp3', 'b.mp3']);
	});

	it('sorts by modification date', () => {
		const list = [
			entry('mid.mp3', { modifiedAt: new Date('2026-02-01') }),
			entry('new.mp3', { modifiedAt: new Date('2026-03-01') }),
			entry('old.mp3', { modifiedAt: new Date('2026-01-01') })
		];
		expect(names(sortEntries(list, 'modifiedAt', 'desc'))).toEqual(['new.mp3', 'mid.mp3', 'old.mp3']);
		expect(names(sortEntries(list, 'modifiedAt', 'asc'))).toEqual(['old.mp3', 'mid.mp3', 'new.mp3']);
	});

	it('does not mutate its input', () => {
		const list = [entry('b.mp3'), entry('a.mp3')];
		sortEntries(list, 'name', 'asc');
		expect(names(list)).toEqual(['b.mp3', 'a.mp3']);
	});
});
