import { describe, it, expect } from 'vitest';
import { findOrphanPaths } from './dbCleanup';

// `findOrphanPaths` is exactly the set of paths the cleanup will delete rows for.
// These tests pin down the safety guarantee: a path that still exists on disk can
// never end up in that set, so live media is never pruned.
describe('findOrphanPaths', () => {
	const existing = new Set(['a/book', 'b/file.mp3', 'kept folder']);
	const exists = (p: string) => existing.has(p);

	it('returns only the paths that do not exist', () => {
		expect(findOrphanPaths(['a/book', 'gone', 'b/file.mp3', 'also/gone'], exists)).toEqual([
			'gone',
			'also/gone'
		]);
	});

	it('NEVER returns a path that exists (the core safety guarantee)', () => {
		const allExisting = ['a/book', 'b/file.mp3', 'kept folder'];
		expect(findOrphanPaths(allExisting, exists)).toEqual([]);
	});

	it('keeps a path when the existence check throws (ambiguous → keep, never delete)', () => {
		const throwingExists = (p: string) => {
			if (p === 'boom') throw new Error('directory traversal attempt');
			return false;
		};
		// 'boom' is kept despite the fallback, 'gone' is still pruned.
		expect(findOrphanPaths(['boom', 'gone'], throwingExists)).toEqual(['gone']);
	});

	it('skips blank and whitespace-only paths (never deletes the media root)', () => {
		expect(findOrphanPaths(['', '   ', 'gone'], () => false)).toEqual(['gone']);
	});

	it('returns an empty array for empty input', () => {
		expect(findOrphanPaths([], () => false)).toEqual([]);
	});

	it('prunes everything when nothing exists', () => {
		expect(findOrphanPaths(['x', 'y/z'], () => false)).toEqual(['x', 'y/z']);
	});

	it('preserves accented paths that exist (NFC-stored folder names)', () => {
		const accented = new Set(['música/disco']);
		expect(findOrphanPaths(['música/disco', 'música/borrado'], (p) => accented.has(p))).toEqual([
			'música/borrado'
		]);
	});
});
