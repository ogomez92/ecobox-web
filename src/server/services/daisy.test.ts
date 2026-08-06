import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// getMediaRoot() reads env.MEDIA_ROOT lazily, so a mutable mocked env lets the
// suite point the resolver at a throwaway media tree.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: { MEDIA_ROOT: '' } as { MEDIA_ROOT: string } }));
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

// Duration probing is the one part that reads real audio (and the SQLite cache).
// DAISY books never reach it — their clip times carry the lengths — so a stub
// both keeps the DB out of the suite and proves the no-decode path.
const { mockDurations } = vi.hoisted(() => ({ mockDurations: new Map<string, number>() }));
vi.mock('./audioDuration', () => ({
	getDurations: vi.fn(async (paths: string[]) => new Map(paths.map((p) => [p, mockDurations.get(p) ?? 0])))
}));

import { getChapteredBook, parseDaisyBook, isDaisyBook } from './daisy';
import { getDurations } from './audioDuration';

let root: string;

/** DAISY 2.02 SMIL with `<par>`-addressable phrases, as LpStudio and friends emit. */
function smil(options: {
	title: string;
	elapsed: string;
	inThisSmil: string;
	clips: { id: string; file: string; begin: number; end: number }[];
}): string {
	const pars = options.clips
		.map(
			(clip) => `<par endsync="last">
<text src="book.html#${clip.id}" id="${clip.id}" />
<seq>
<audio src="${clip.file}" clip-begin="npt=${clip.begin.toFixed(3)}s" clip-end="npt=${clip.end.toFixed(3)}s" id="a_${clip.id}" />
</seq>
</par>`
		)
		.join('\n');

	return `<?xml version="1.0" encoding="windows-1252"?>
<smil>
<head>
<meta name="dc:format" content="Daisy 2.02" />
<meta name="title" content="${options.title}" />
<meta name="ncc:totalElapsedTime" content="${options.elapsed}" />
<meta name="ncc:timeInThisSmil" content="${options.inThisSmil}" />
</head>
<body>
<seq dur="${options.inThisSmil}">
${pars}
</seq>
</body>
</smil>`;
}

beforeAll(() => {
	root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecobox-daisy-'));
	mockEnv.MEDIA_ROOT = root;

	// --- A single-volume DAISY 2.02 book, windows-1252, where two chapters SHARE
	// one MP3 (the case that makes clip times load-bearing) and a third has its own.
	const book = path.join(root, 'libro');
	fs.mkdirSync(book);
	fs.writeFileSync(
		path.join(book, 'ncc.html'),
		Buffer.from(
			`<?xml version="1.0" encoding="windows-1252"?>
<html>
<head>
<title>Donde los ángeles no duermen</title>
<meta name="dc:title" content="Donde los ángeles no duermen" />
<meta name="dc:creator" content="María Teresa Colominas" />
<meta name="ncc:charset" content="windows-1252" />
<meta name="ncc:totalTime" content="00:02:30" />
</head>
<body>
<h1><a href="uno.smil#p1">Prólogo</a></h1>
<h2><a href="uno.smil#p2">Capítulo 1</a></h2>
<h1><a href="dos.smil#p3">Capítulo 2</a></h1>
</body>
</html>`,
			'latin1'
		)
	);
	// uno.smil: 0–60s of parte1.mp3, two chapters inside it (0s and 25s).
	fs.writeFileSync(
		path.join(book, 'uno.smil'),
		Buffer.from(
			smil({
				title: 'Prólogo',
				elapsed: '00:00:00',
				inThisSmil: '00:01:00',
				clips: [
					{ id: 'p1', file: 'parte1.mp3', begin: 0, end: 25 },
					{ id: 'p2', file: 'parte1.mp3', begin: 25, end: 60 }
				]
			}),
			'latin1'
		)
	);
	// dos.smil: a different file, starting 60s into the book.
	fs.writeFileSync(
		path.join(book, 'dos.smil'),
		Buffer.from(
			smil({
				title: 'Capítulo 2',
				elapsed: '00:01:00',
				inThisSmil: '00:01:30',
				clips: [{ id: 'p3', file: 'parte2.mp3', begin: 0, end: 90 }]
			}),
			'latin1'
		)
	);
	fs.writeFileSync(path.join(book, 'parte1.mp3'), '');
	fs.writeFileSync(path.join(book, 'parte2.mp3'), '');

	// --- A plain .CHAPTERED folder: no navigation, durations come from probing.
	const plain = path.join(root, 'carpeta');
	fs.mkdirSync(plain);
	fs.writeFileSync(path.join(plain, '.CHAPTERED'), '');
	for (const name of ['pista1.mp3', 'pista2.mp3', 'pista10.mp3']) {
		fs.writeFileSync(path.join(plain, name), '');
	}
	// Keyed with forward slashes, like every relative path the services emit —
	// see toPosixPath in files.ts. Using path.join here would key the mock with
	// backslashes on Windows and never match the lookup.
	mockDurations.set('carpeta/pista1.mp3', 10);
	mockDurations.set('carpeta/pista2.mp3', 20);
	mockDurations.set('carpeta/pista10.mp3', 30);
});

afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

describe('parseDaisyBook', () => {
	it('reads a windows-1252 book without mangling accents', async () => {
		const book = await parseDaisyBook(path.join(root, 'libro'));
		expect(book?.title).toBe('Donde los ángeles no duermen');
		expect(book?.author).toBe('María Teresa Colominas');
		expect(book?.chapters.map((c) => c.title)).toEqual(['Prólogo', 'Capítulo 1', 'Capítulo 2']);
	});

	it('gives chapters sharing one file distinct in-file offsets', async () => {
		const book = await parseDaisyBook(path.join(root, 'libro'));
		const [prologo, uno, dos] = book!.chapters;

		// Same file, different clip-begin — the whole point of parsing SMIL times.
		expect(prologo.filePath).toBe('libro/parte1.mp3');
		expect(uno.filePath).toBe('libro/parte1.mp3');
		expect(prologo.fileStartTime).toBe(0);
		expect(uno.fileStartTime).toBe(25);

		// startTime stays absolute across the book…
		expect(prologo.startTime).toBe(0);
		expect(uno.startTime).toBe(25);
		expect(dos.startTime).toBe(60);
		// …and the second file starts where the first ends.
		expect(dos.fileStartTime).toBe(0);
	});

	it('keeps startTime = file.startTime + fileStartTime for every chapter', async () => {
		const book = await parseDaisyBook(path.join(root, 'libro'));
		const starts = new Map(book!.files.map((f) => [f.path, f.startTime]));

		for (const chapter of book!.chapters) {
			expect(starts.get(chapter.filePath!)! + chapter.fileStartTime!).toBeCloseTo(chapter.startTime, 5);
		}
	});

	it('derives file durations and the book total from clip times alone', async () => {
		vi.mocked(getDurations).mockClear();
		const book = await parseDaisyBook(path.join(root, 'libro') + path.sep.repeat(0)); // same folder, fresh call

		expect(book!.files).toEqual([
			{ path: 'libro/parte1.mp3', duration: 60, startTime: 0 },
			{ path: 'libro/parte2.mp3', duration: 90, startTime: 60 }
		]);
		// ncc:totalTime (00:02:30) matches the measured 150s.
		expect(book!.totalDuration).toBe(150);
	});

	it('never decodes audio for a DAISY book', async () => {
		vi.mocked(getDurations).mockClear();
		// Force a re-parse: the cache is keyed on the navigation file's size+mtime.
		fs.utimesSync(path.join(root, 'libro', 'ncc.html'), new Date(), new Date(Date.now() + 1000));
		await parseDaisyBook(path.join(root, 'libro'));
		expect(getDurations).not.toHaveBeenCalled();
	});

	it('marks chapter ends with the next chapter start', async () => {
		const book = await parseDaisyBook(path.join(root, 'libro'));
		expect(book!.chapters.map((c) => c.endTime)).toEqual([25, 60, 150]);
	});

	it('caches a parsed book until its navigation changes', async () => {
		const first = await parseDaisyBook(path.join(root, 'libro'));
		const second = await parseDaisyBook(path.join(root, 'libro'));
		expect(second).toBe(first); // same object → no re-read

		fs.utimesSync(path.join(root, 'libro', 'ncc.html'), new Date(), new Date(Date.now() + 5000));
		const third = await parseDaisyBook(path.join(root, 'libro'));
		expect(third).not.toBe(first);
		expect(third).toEqual(first);
	});
});

describe('getChapteredBook', () => {
	it('reports DAISY books with navigation-derived chapters', async () => {
		const book = await getChapteredBook(path.join(root, 'libro'));
		expect(book?.type).toBe('daisy');
		expect(book?.chapters).toHaveLength(3);
		expect(book?.files).toHaveLength(2);
	});

	it('lays a plain chaptered folder out in natural order with probed durations', async () => {
		const book = await getChapteredBook(path.join(root, 'carpeta'));

		expect(book?.type).toBe('chaptered');
		expect(book?.files).toEqual([
			{ path: 'carpeta/pista1.mp3', duration: 10, startTime: 0 },
			{ path: 'carpeta/pista2.mp3', duration: 20, startTime: 10 },
			// natural sort: pista10 after pista2, not after pista1
			{ path: 'carpeta/pista10.mp3', duration: 30, startTime: 30 }
		]);
		expect(book?.totalDuration).toBe(60);
		expect(book?.chapters.map((c) => c.fileStartTime)).toEqual([0, 0, 0]);
	});

	it('returns null for a folder with no audio at all', async () => {
		const empty = fs.mkdtempSync(path.join(root, 'vacia-'));
		expect(await getChapteredBook(empty)).toBeNull();
	});
});

describe('isDaisyBook', () => {
	it('accepts a folder with ncc.html and rejects a plain one', async () => {
		expect(await isDaisyBook(path.join(root, 'libro'))).toBe(true);
		expect(await isDaisyBook(path.join(root, 'carpeta'))).toBe(false);
	});
});
