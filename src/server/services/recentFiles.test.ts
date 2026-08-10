import { describe, it, expect, vi } from 'vitest';

// The service imports `$server/db` (which opens SQLite) and `$env/dynamic/private`
// at module load. Stub both so the pure resolution logic can be tested on its own.
vi.mock('$env/dynamic/private', () => ({ env: { MEDIA_ROOT: '/nonexistent' } }));
vi.mock('$server/db', () => ({ db: {}, schema: {} }));

import { resolveRecentTarget, hrefFor, parentOf, nameOf } from './recentFiles';
import type { RecentKind } from '$lib/types';

/**
 * A fake media tree: a map of path → kind. Anything not in the map does not
 * exist, which is how a deleted file/folder is expressed.
 */
function treeDescribe(tree: Record<string, RecentKind>) {
	return async (p: string) => tree[p] ?? null;
}

// The example from the feature request: a show, a season, and its episodes.
const FULL_TREE: Record<string, RecentKind> = {
	'': 'folder',
	'Stranger Things': 'folder',
	'Stranger Things/Season 01': 'folder',
	'Stranger Things/Season 01/ep08.mp3': 'file',
	'Stranger Things/Season 01/ep10.mp3': 'file'
};

describe('resolveRecentTarget', () => {
	it('opens the file itself when it still exists', async () => {
		const target = await resolveRecentTarget('Stranger Things/Season 01/ep10.mp3', {
			describe: treeDescribe(FULL_TREE)
		});
		expect(target.exists).toBe(true);
		expect(target.path).toBe('Stranger Things/Season 01/ep10.mp3');
		expect(target.href).toBe('/play/Stranger Things/Season 01/ep10.mp3');
	});

	it('falls back to the containing folder when only the file is gone', async () => {
		const { 'Stranger Things/Season 01/ep08.mp3': _gone, ...tree } = FULL_TREE;
		const target = await resolveRecentTarget('Stranger Things/Season 01/ep08.mp3', {
			describe: treeDescribe(tree)
		});
		expect(target.exists).toBe(false);
		expect(target.path).toBe('Stranger Things/Season 01');
		expect(target.href).toBe('/browse/Stranger Things/Season 01');
		expect(target.name).toBe('Season 01');
	});

	it('walks further up when the folder is gone too (the show folder survives)', async () => {
		const target = await resolveRecentTarget('Stranger Things/Season 01/ep08.mp3', {
			describe: treeDescribe({ '': 'folder', 'Stranger Things': 'folder' })
		});
		expect(target.exists).toBe(false);
		expect(target.path).toBe('Stranger Things');
		expect(target.href).toBe('/browse/Stranger Things');
	});

	it('lands on the media root when the whole tree above it is gone', async () => {
		const target = await resolveRecentTarget('Stranger Things/Season 01/ep08.mp3', {
			describe: treeDescribe({ '': 'folder' })
		});
		expect(target.exists).toBe(false);
		expect(target.path).toBe('');
		expect(target.href).toBe('/');
	});

	it('routes a surviving ancestor by what it is now, not by what was recorded', async () => {
		// The season folder was turned into a converted book folder in the meantime.
		const target = await resolveRecentTarget('Stranger Things/Season 01/ep08.mp3', {
			describe: treeDescribe({
				'': 'folder',
				'Stranger Things': 'folder',
				'Stranger Things/Season 01': 'book'
			})
		});
		expect(target.kind).toBe('book');
		expect(target.href).toBe('/read/Stranger Things/Season 01');
	});

	it('skips ancestors this session may not see and keeps walking up', async () => {
		const target = await resolveRecentTarget('Shows/Secret/ep01.mp3', {
			describe: treeDescribe({ '': 'folder', Shows: 'folder', 'Shows/Secret': 'folder' }),
			isHidden: (p) => p === 'Shows/Secret'
		});
		expect(target.path).toBe('Shows');
	});

	it('tolerates stray slashes in a recorded path', async () => {
		const target = await resolveRecentTarget('/Stranger Things//Season 01/', {
			describe: treeDescribe(FULL_TREE)
		});
		expect(target.exists).toBe(true);
		expect(target.path).toBe('Stranger Things/Season 01');
	});
});

describe('hrefFor', () => {
	it('sends each kind to the route that can open it', () => {
		expect(hrefFor('book', 'Books/Dune')).toBe('/read/Books/Dune');
		expect(hrefFor('daisy', 'Books/Daisy')).toBe('/play/Books/Daisy');
		expect(hrefFor('chaptered', 'Books/Split')).toBe('/play/Books/Split');
		expect(hrefFor('file', 'a/b.mp3')).toBe('/play/a/b.mp3');
		expect(hrefFor('radio', 'a/b.radio')).toBe('/play/a/b.radio');
		expect(hrefFor('folder', 'a/b')).toBe('/browse/a/b');
		expect(hrefFor('folder', '')).toBe('/');
	});

	it('opens an unconverted book in its folder, focused, where Convert lives', () => {
		expect(hrefFor('rawbook', 'Books/Dune.epub')).toBe('/browse/Books?focus=Dune.epub');
		expect(hrefFor('rawbook', 'Dune.epub')).toBe('/?focus=Dune.epub');
	});
});

describe('path helpers', () => {
	it('parentOf walks one level up and bottoms out at the root', () => {
		expect(parentOf('a/b/c.mp3')).toBe('a/b');
		expect(parentOf('a')).toBe('');
		expect(parentOf('')).toBe('');
	});

	it('nameOf returns the last segment', () => {
		expect(nameOf('a/b/c.mp3')).toBe('c.mp3');
		expect(nameOf('')).toBe('');
	});
});
