import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// getMediaRoot() reads env.MEDIA_ROOT lazily, so a mutable mocked env lets each
// test point the resolver at a throwaway media tree.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: { MEDIA_ROOT: '' } as { MEDIA_ROOT: string } }));
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

import { resolveExistingPath, createFolder, validateFolderName } from './files';

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

describe('validateFolderName', () => {
	it('accepts an ordinary name and trims it', () => {
		expect(validateFolderName('  Audiolibros  ')).toEqual({ name: 'Audiolibros' });
	});

	it('accepts accents, spaces and inner dots', () => {
		expect(validateFolderName('Cuentos de Perrault vol. 2')).toEqual({
			name: 'Cuentos de Perrault vol. 2'
		});
	});

	it('rejects an empty or whitespace-only name', () => {
		expect(validateFolderName('')).toEqual({ error: 'empty' });
		expect(validateFolderName('   ')).toEqual({ error: 'empty' });
	});

	it('rejects the relative-path names', () => {
		expect(validateFolderName('.')).toEqual({ error: 'empty' });
		expect(validateFolderName('..')).toEqual({ error: 'empty' });
	});

	it('rejects a name that would span directories', () => {
		expect(validateFolderName('a/b')).toEqual({ error: 'invalidChars' });
		expect(validateFolderName('a\\b')).toEqual({ error: 'invalidChars' });
		expect(validateFolderName('../escape')).toEqual({ error: 'invalidChars' });
	});

	it('rejects characters Windows cannot store', () => {
		for (const bad of ['a:b', 'a*b', 'a?b', 'a"b', 'a<b', 'a>b', 'a|b', 'a\u0001b']) {
			expect(validateFolderName(bad)).toEqual({ error: 'invalidChars' });
		}
	});

	it('rejects a trailing dot (Windows would strip it and collide)', () => {
		expect(validateFolderName('Books.')).toEqual({ error: 'invalidChars' });
	});

	it('rejects the legacy device names, with or without an extension', () => {
		expect(validateFolderName('CON')).toEqual({ error: 'reserved' });
		expect(validateFolderName('com1')).toEqual({ error: 'reserved' });
		expect(validateFolderName('nul.txt')).toEqual({ error: 'reserved' });
		expect(validateFolderName('Conan')).toEqual({ name: 'Conan' }); // only the exact names
	});

	it('rejects a name past the 255-byte limit, counting bytes not characters', () => {
		expect(validateFolderName('a'.repeat(255))).toEqual({ name: 'a'.repeat(255) });
		expect(validateFolderName('a'.repeat(256))).toEqual({ error: 'tooLong' });
		// 128 two-byte characters: only 128 characters long, but 256 bytes on disk.
		expect(validateFolderName('é'.repeat(128))).toEqual({ error: 'tooLong' });
	});
});

describe('createFolder', () => {
	it('creates a folder at the media root and returns its relative path', async () => {
		const rel = await createFolder('', 'Nuevos');
		expect(rel).toBe('Nuevos');
		expect(fs.statSync(path.join(root, 'Nuevos')).isDirectory()).toBe(true);
	});

	it('creates inside an accented parent stored NFD on disk', async () => {
		// The client sends the precomposed form; the folder must land in the real dir.
		const rel = await createFolder(`${NFC} dir`, 'sub');
		expect(rel).toBe(`${NFC} dir/sub`);
		expect(fs.statSync(path.join(root, `${NFD} dir`, 'sub')).isDirectory()).toBe(true);
	});

	it('fails with EEXIST rather than silently reusing an existing folder', async () => {
		await createFolder('', 'Taken');
		await expect(createFolder('', 'Taken')).rejects.toMatchObject({ code: 'EEXIST' });
	});

	it('fails with ENOENT when the parent is gone', async () => {
		await expect(createFolder('no-such-parent', 'child')).rejects.toMatchObject({
			code: 'ENOENT'
		});
	});
});
