import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// getMediaRoot() reads env.MEDIA_ROOT lazily, so a mocked env lets the tests
// point the resolver at a throwaway media tree.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: { MEDIA_ROOT: '' } as { MEDIA_ROOT: string } }));
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

import { searchDirectory } from './files';

let root: string;

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecobox-search-'));
	mockEnv.MEDIA_ROOT = root;

	const mk = (...parts: string[]) => fs.mkdirSync(path.join(root, ...parts), { recursive: true });
	const write = (rel: string) => fs.writeFileSync(path.join(root, rel), 'x');

	// a/ — the folder searches are scoped to, with a nested hit.
	mk('a', 'b');
	write('a/target-shallow.mp3');
	write('a/b/target-deep.mp3');
	write('a/Cadáver exquisito.mp3');

	// c/ — a sibling of a/, holding a name that must never leak into an a/ search.
	mk('c', 'd');
	write('c/d/target-elsewhere.mp3');
	write('target-at-root.mp3');

	// Opaque playable units: matched by folder name, never descended into.
	mk('target-book');
	write('target-book/.BOOK');
	write('target-book/target-inside-book.mp3');

	mk('target-chaptered');
	write('target-chaptered/.CHAPTERED');
	write('target-chaptered/target-inside-chaptered.mp3');
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const names = (r: { results: { path: string }[] }) => r.results.map((e) => e.path).sort();

describe('searchDirectory', () => {
	it('searches the scoped folder and everything below it', async () => {
		const r = await searchDirectory('a', 'target');
		expect(names(r)).toEqual(['a/b/target-deep.mp3', 'a/target-shallow.mp3']);
		expect(r.total).toBe(2);
	});

	it('never escapes upward to a parent or sibling folder', async () => {
		const r = await searchDirectory('a', 'target');
		expect(r.results.every((e) => e.path.startsWith('a/'))).toBe(true);
		// The identically-named hits in c/d and at the root stay invisible.
		expect(names(r)).not.toContain('c/d/target-elsewhere.mp3');
		expect(names(r)).not.toContain('target-at-root.mp3');
	});

	it('finds a deep hit only reachable from the scoped folder', async () => {
		expect(names(await searchDirectory('c', 'target'))).toEqual(['c/d/target-elsewhere.mp3']);
	});

	it('matches case- and accent-insensitively', async () => {
		expect(names(await searchDirectory('a', 'cadaver'))).toEqual(['a/Cadáver exquisito.mp3']);
		expect(names(await searchDirectory('a', 'CADÁVER'))).toEqual(['a/Cadáver exquisito.mp3']);
	});

	it('matches a substring anywhere in the name, not just the start', async () => {
		expect(names(await searchDirectory('a', 'deep'))).toEqual(['a/b/target-deep.mp3']);
	});

	it('treats book and chaptered folders as opaque units', async () => {
		const r = await searchDirectory('', 'target-inside');
		// Their contents are never listed separately...
		expect(r.total).toBe(0);
		// ...but the folders themselves match by name, flagged for the right route.
		const units = await searchDirectory('', 'target-');
		const book = units.results.find((e) => e.name === 'target-book');
		const chaptered = units.results.find((e) => e.name === 'target-chaptered');
		expect(book?.isBookFolder).toBe(true);
		expect(chaptered?.isChapteredFolder).toBe(true);
	});

	it('never returns the .CHAPTERED marker, even when scoped inside the folder', async () => {
		const r = await searchDirectory('target-chaptered', 'chaptered');
		expect(names(r)).toEqual(['target-chaptered/target-inside-chaptered.mp3']);
	});

	it('returns nothing for an empty or whitespace query', async () => {
		expect(await searchDirectory('', '')).toEqual({ results: [], total: 0 });
		expect(await searchDirectory('', '   ')).toEqual({ results: [], total: 0 });
	});

	it('caps results at the limit while still reporting the full total', async () => {
		const r = await searchDirectory('', 'target', 2);
		expect(r.results).toHaveLength(2);
		expect(r.total).toBeGreaterThan(2);
		// The cap is applied after sorting, so directories come first.
		expect(r.results.every((e) => e.isDirectory)).toBe(true);
	});

	it('sorts directories first, then by name', async () => {
		const r = await searchDirectory('', 'target');
		const firstFileIdx = r.results.findIndex((e) => !e.isDirectory);
		expect(r.results.slice(0, firstFileIdx).every((e) => e.isDirectory)).toBe(true);
		expect(r.results.slice(firstFileIdx).every((e) => !e.isDirectory)).toBe(true);
	});

	it('rejects directory traversal in the scope path', async () => {
		await expect(searchDirectory('../../etc', 'passwd')).rejects.toThrow(/traversal/);
	});
});
