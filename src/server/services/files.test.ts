import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// getMediaRoot() reads env.MEDIA_ROOT lazily, so a mutable mocked env lets each
// test point the resolver at a throwaway media tree.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: { MEDIA_ROOT: '' } as { MEDIA_ROOT: string } }));
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

import { resolveExistingPath } from './files';

// "cafe" + acute accent, built from escapes so the source file's own Unicode
// normalization can't collapse the two forms into one.
const NFC = 'café'; // precomposed: é = U+00E9
const NFD = 'café'; // decomposed: e + combining acute U+0301

let root: string;
beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecobox-nfd-'));
	mockEnv.MEDIA_ROOT = root;
	// A file stored DECOMPOSED on disk (the "Te encontraré" case).
	fs.writeFileSync(path.join(root, `${NFD}.epub`), 'x');
	// A nested tree with a DECOMPOSED directory holding a PRECOMPOSED file.
	fs.mkdirSync(path.join(root, `${NFD} dir`));
	fs.writeFileSync(path.join(root, `${NFD} dir`, `${NFC}.md`), 'y');
});
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('resolveExistingPath', () => {
	it('finds an NFD-on-disk file when the client sends NFC', () => {
		const abs = resolveExistingPath(`${NFC}.epub`);
		expect(fs.existsSync(abs)).toBe(true);
		expect(path.basename(abs)).toBe(`${NFD}.epub`); // returns the real on-disk bytes
	});

	it('finds an NFC-on-disk file when the client sends NFD', () => {
		const abs = resolveExistingPath(path.join(`${NFD} dir`, `${NFD}.md`));
		expect(fs.existsSync(abs)).toBe(true);
		expect(path.basename(abs)).toBe(`${NFC}.md`);
	});

	it('canonicalizes every segment of a nested all-NFC request', () => {
		const abs = resolveExistingPath(path.join(`${NFC} dir`, `${NFC}.md`));
		expect(fs.existsSync(abs)).toBe(true);
		expect(abs).toBe(path.join(root, `${NFD} dir`, `${NFC}.md`));
	});

	it('returns the plain resolved path for a not-yet-created leaf (write target)', () => {
		// Parent dir exists (NFD); the new leaf does not — its requested bytes are kept.
		const abs = resolveExistingPath(path.join(`${NFC} dir`, 'new-book'));
		expect(abs).toBe(path.join(root, `${NFD} dir`, 'new-book'));
		expect(fs.existsSync(abs)).toBe(false);
	});

	it('returns an exact existing path untouched', () => {
		const abs = resolveExistingPath(`${NFD}.epub`);
		expect(abs).toBe(path.join(root, `${NFD}.epub`));
	});

	it('still rejects directory traversal', () => {
		expect(() => resolveExistingPath('../../etc/passwd')).toThrow(/traversal/);
	});
});
