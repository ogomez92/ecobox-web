import { describe, it, expect, vi, beforeAll, beforeEach, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs/promises';
import fsSync from 'fs';
import os from 'os';
import path from 'path';

/**
 * End to end over a real temp media tree and real ffmpeg, with the TTS provider,
 * credentials and database mocked: plan → synthesize → encode → chapters → place.
 */

const root = fsSync.mkdtempSync(path.join(os.tmpdir(), 'ecobox-audiobook-'));
const mockEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

const state = vi.hoisted(() => ({
	position: null as number | null,
	quota: null as null | { used: number; limit: number; remaining: number },
	voices: [{ id: 'v1', name: 'Rachel', lang: 'en' }] as { id: string; name: string; lang: string }[],
	savedVoice: 'v1',
	mp3: null as Buffer | null,
	/** Called before each synthesis; may throw to simulate a provider failure. */
	beforeSynth: null as null | ((text: string) => void | Promise<void>)
}));
const synthesize = vi.hoisted(() => vi.fn());

vi.mock('$server/db', () => ({
	db: {
		query: {
			bookMetadata: {
				findFirst: async () => (state.position === null ? undefined : { currentChunkIndex: state.position })
			}
		}
	},
	schema: { bookMetadata: { bookFolderPath: {} } }
}));

vi.mock('./tts', async () => {
	const { TtsError } = await import('./tts/errors');
	return {
		TtsError,
		synthesize: async (input: { text: string }) => {
			synthesize(input);
			await state.beforeSynth?.(input.text);
			const b = state.mp3!;
			return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength);
		},
		listVoices: async () => state.voices,
		getQuota: async () => state.quota
	};
});

vi.mock('./tts/credentials', () => ({
	resolveCredential: async (service: string) => ({
		service,
		apiKey: 'k',
		region: '',
		model: '',
		voiceId: state.savedVoice,
		enabled: true,
		voiceSettings: { stability: 0.5, similarityBoost: 0.75, style: 0, useSpeakerBoost: true }
	}),
	getCredentialRow: async () => null
}));

import {
	estimateAudiobook,
	startAudiobook,
	cancelAudiobook,
	getAudiobookStatus,
	classifyTtsFailure,
	parseRate,
	AudiobookError,
	RETRY_DELAYS_MS
} from './audiobookExport';
import { TtsError } from './tts/errors';
import { extractID3Chapters } from './id3chapters';

function hasFfmpeg(): boolean {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}
const ffmpeg = hasFfmpeg();

const BOOK = 'Shelf/My Book';
const media = path.join(root, 'media');

const chunks = [
	{ i: 0, text: 'Chapter One', para: 0, type: 'heading' },
	{ i: 1, text: 'It was a dark night.', para: 1, type: 'paragraph' },
	{ i: 2, text: 'Rain fell.', para: 1, type: 'paragraph' },
	{ i: 3, text: 'Chapter Two', para: 2, type: 'heading' },
	{ i: 4, text: 'Morning came.', para: 3, type: 'paragraph' },
	{ i: 5, text: 'The end.', para: 4, type: 'paragraph' }
];
const totalChars = ['Chapter One', 'It was a dark night. Rain fell.', 'Chapter Two', 'Morning came.', 'The end.'].join('').length;

async function waitForEnd(relPath = BOOK) {
	for (let i = 0; i < 400; i++) {
		const s = getAudiobookStatus(relPath);
		if (s && !['queued', 'running', 'finishing'].includes(s.state)) return s;
		await new Promise((r) => setTimeout(r, 25));
	}
	throw new Error('export did not finish');
}

async function shelf(): Promise<string[]> {
	return (await fs.readdir(path.join(media, 'Shelf'))).sort();
}

beforeAll(async () => {
	mockEnv.MEDIA_ROOT = media;
	mockEnv.TTS_CACHE_DIR = path.join(root, 'cache');
	mockEnv.AUDIOBOOK_WORK_DIR = path.join(root, 'work');
	RETRY_DELAYS_MS.splice(0, RETRY_DELAYS_MS.length, 0, 0, 0);
	if (ffmpeg) {
		const out = path.join(root, 'unit.mp3');
		execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=0.4', '-ac', '1', '-c:a', 'libmp3lame', out]);
		state.mp3 = await fs.readFile(out);
	}
});

afterAll(async () => {
	await fs.rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
	await fs.rm(media, { recursive: true, force: true });
	await fs.rm(mockEnv.TTS_CACHE_DIR!, { recursive: true, force: true });
	await fs.mkdir(path.join(media, BOOK), { recursive: true });
	await fs.writeFile(path.join(media, BOOK, '.BOOK'), '{}');
	await fs.writeFile(
		path.join(media, BOOK, 'book.chunks.json'),
		JSON.stringify({ title: 'My Book', locale: 'en', chunks })
	);
	state.position = null;
	state.quota = null;
	state.savedVoice = 'v1';
	state.voices = [{ id: 'v1', name: 'Rachel', lang: 'en' }];
	state.beforeSynth = null;
	synthesize.mockClear();
});

describe('classifyTtsFailure', () => {
	it('maps provider statuses to codes, retrying only what can recover', () => {
		expect(classifyTtsFailure(new TtsError(401, 'x'))).toMatchObject({ code: 'badKey', transient: false });
		expect(classifyTtsFailure(new TtsError(402, 'x'))).toMatchObject({ code: 'quotaExceeded', transient: false });
		expect(classifyTtsFailure(new TtsError(400, 'No voice'))).toMatchObject({ code: 'misconfigured', detail: 'No voice' });
		expect(classifyTtsFailure(new TtsError(404, 'x'))).toMatchObject({ code: 'misconfigured', transient: false });
		expect(classifyTtsFailure(new TtsError(503, 'x'))).toMatchObject({ code: 'unreachable', transient: true });
		expect(classifyTtsFailure(new TtsError(429, 'x'))).toMatchObject({ code: 'upstream', transient: true });
		expect(classifyTtsFailure(new TtsError(502, 'x'))).toMatchObject({ code: 'upstream', transient: true });
		expect(classifyTtsFailure(new Error('socket hang up'))).toMatchObject({ code: 'unreachable', transient: true });
		expect(classifyTtsFailure(new AudiobookError('ffmpeg', 'd'))).toMatchObject({ code: 'ffmpeg', transient: false });
	});

	it('clamps the reading speed to the reader’s range', () => {
		expect(parseRate(undefined)).toBe(1);
		expect(parseRate('1.5')).toBe(1.5);
		expect(parseRate(9)).toBe(5);
		expect(parseRate(0.1)).toBe(0.5);
		expect(parseRate('nope')).toBe(1);
	});
});

describe('estimateAudiobook', () => {
	it('refuses the browser-only service', async () => {
		await expect(estimateAudiobook(BOOK, 'webspeech')).rejects.toMatchObject({ code: 'clientOnly' });
	});

	it('refuses something that is not a converted book', async () => {
		await fs.mkdir(path.join(media, 'Shelf/Plain'), { recursive: true });
		await expect(estimateAudiobook('Shelf/Plain', 'elevenlabs')).rejects.toMatchObject({ code: 'notBook' });
		await expect(estimateAudiobook('Shelf/Missing', 'elevenlabs')).rejects.toMatchObject({ code: 'notBook' });
	});

	it('counts the whole book and offers no position before reading starts', async () => {
		state.quota = { used: 0, limit: 10000, remaining: 10000 };
		const est = await estimateAudiobook(BOOK, 'elevenlabs');
		expect(est.whole).toEqual({ chars: totalChars, billableChars: totalChars, fileName: 'My Book.mp3' });
		expect(est.fromPosition).toBeNull();
		expect(est.voiceName).toBe('Rachel');
		expect(est.billed).toBe(true);
		expect(est.rate).toBeNull();
		expect(est.quota?.remaining).toBe(10000);
	});

	it('offers "from your position" once reading has started', async () => {
		state.position = 4;
		const est = await estimateAudiobook(BOOK, 'elevenlabs');
		expect(est.fromPosition).toMatchObject({
			chunkIndex: 4,
			percent: 66,
			chapter: 'Chapter Two',
			chars: 'Morning came.The end.'.length,
			fileName: 'My Book (from 66%).mp3'
		});
	});

	it('picks a voice in the book’s language when none is saved', async () => {
		state.savedVoice = '';
		state.voices = [
			{ id: 'fr', name: 'Amélie', lang: 'fr-FR' },
			{ id: 'en', name: 'Jenny', lang: 'en-US' }
		];
		expect((await estimateAudiobook(BOOK, 'azure')).voiceId).toBe('en');
		state.voices = [];
		await expect(estimateAudiobook(BOOK, 'azure')).rejects.toMatchObject({ code: 'noVoice' });
	});

	it('reports the speed baked in for ELF/Piper only', async () => {
		expect((await estimateAudiobook(BOOK, 'piper', 1.5)).rate).toBe(1.5);
		expect((await estimateAudiobook(BOOK, 'piper', 1.5)).billed).toBe(false);
		expect((await estimateAudiobook(BOOK, 'google', 1.5)).rate).toBeNull();
	});
});

describe.skipIf(!ffmpeg)('an export run', () => {
	it('writes one MP3 with a chapter per heading next to the book, keeping the book', async () => {
		const started = await startAudiobook(BOOK, 'elevenlabs', false);
		expect(started.totalChars).toBe(totalChars);
		const done = await waitForEnd();
		expect(done).toMatchObject({ state: 'done', error: null, outputPath: 'Shelf/My Book.mp3' });
		expect(done.doneChars).toBe(done.totalChars);
		expect(done.doneUnits).toBe(5);

		expect(await shelf()).toEqual(['My Book', 'My Book.mp3']);
		expect((await fs.readdir(path.join(media, BOOK))).sort()).toEqual(['.BOOK', 'book.chunks.json']);

		const chapters = extractID3Chapters(path.join(media, 'Shelf/My Book.mp3'));
		expect(chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
		expect(chapters[0].startTime).toBe(0);
		// heading + paragraph unit + two paragraph gaps + heading gap ≈ 0.4·2 + 0.25 + 0.9
		expect(chapters[1].startTime).toBeGreaterThan(1.5);
		expect(chapters[1].startTime).toBeLessThan(2.5);

		// The scratch work directory is cleaned up.
		expect(await fs.readdir(mockEnv.AUDIOBOOK_WORK_DIR!)).toEqual([]);
	});

	it('reuses cached audio: a second run synthesizes nothing and never overwrites', async () => {
		await startAudiobook(BOOK, 'elevenlabs', false);
		await waitForEnd();
		expect(synthesize).toHaveBeenCalledTimes(5);

		const est = await estimateAudiobook(BOOK, 'elevenlabs');
		expect(est.whole.billableChars).toBe(0);

		synthesize.mockClear();
		await startAudiobook(BOOK, 'elevenlabs', false);
		const second = await waitForEnd();
		expect(synthesize).not.toHaveBeenCalled();
		expect(second.outputPath).toBe('Shelf/My Book (2).mp3');
	});

	it('cache keys follow the speed for engines that bake it in', async () => {
		await startAudiobook(BOOK, 'piper', false, 1);
		await waitForEnd();
		expect((await estimateAudiobook(BOOK, 'piper', 1)).whole.billableChars).toBe(0);
		expect((await estimateAudiobook(BOOK, 'piper', 1.5)).whole.billableChars).toBe(totalChars);
		// Speed doesn't change a stretch service's audio, so its key ignores it.
		await startAudiobook(BOOK, 'google', false, 1);
		await waitForEnd();
		expect((await estimateAudiobook(BOOK, 'google', 2)).whole.billableChars).toBe(0);
	});

	it('converts from the reading position, naming the file and first chapter', async () => {
		state.position = 2;
		await startAudiobook(BOOK, 'elevenlabs', true);
		const done = await waitForEnd();
		expect(done.outputPath).toBe('Shelf/My Book (from 33%).mp3');
		expect(done.totalUnits).toBe(4);
		const chapters = extractID3Chapters(path.join(media, 'Shelf/My Book (from 33%).mp3'));
		expect(chapters.map((c) => c.title)).toEqual(['Chapter One', 'Chapter Two']);
	});

	it('refuses to start a run the quota cannot cover, before synthesizing anything', async () => {
		state.quota = { used: 9990, limit: 10000, remaining: 10 };
		await startAudiobook(BOOK, 'elevenlabs', false);
		const s = await waitForEnd();
		expect(s).toMatchObject({ state: 'failed', error: 'quotaExceeded' });
		expect(synthesize).not.toHaveBeenCalled();
		expect(await shelf()).toEqual(['My Book']);
	});

	it('retries transient provider failures', async () => {
		let failures = 2;
		state.beforeSynth = () => {
			if (failures-- > 0) throw new TtsError(503, 'ElevenLabs unreachable');
		};
		await startAudiobook(BOOK, 'elevenlabs', false);
		expect(await waitForEnd()).toMatchObject({ state: 'done' });
	});

	it('fails at once on a bad key, keeping what was already paid for', async () => {
		let calls = 0;
		state.beforeSynth = () => {
			if (++calls > 2) throw new TtsError(401, 'ElevenLabs error 401');
		};
		await startAudiobook(BOOK, 'elevenlabs', false);
		const s = await waitForEnd();
		expect(s).toMatchObject({ state: 'failed', error: 'badKey' });
		expect(await shelf()).toEqual(['My Book']);
		// The units synthesized before the failure are cached: the next estimate is cheaper.
		state.beforeSynth = null;
		expect((await estimateAudiobook(BOOK, 'elevenlabs')).whole.billableChars).toBeLessThan(totalChars);
	});

	it('refuses a second run of the same book while one is active', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		state.beforeSynth = () => gate;
		await startAudiobook(BOOK, 'elevenlabs', false);
		await expect(startAudiobook(BOOK, 'elevenlabs', false)).rejects.toMatchObject({ code: 'busy' });
		release();
		await waitForEnd();
	});

	it('can be stopped, leaving no file behind', async () => {
		let release!: () => void;
		const gate = new Promise<void>((r) => (release = r));
		state.beforeSynth = () => gate;
		await startAudiobook(BOOK, 'elevenlabs', false);
		await new Promise((r) => setTimeout(r, 20));
		expect(cancelAudiobook(BOOK)?.state).toBe('running');
		release();
		expect(await waitForEnd()).toMatchObject({ state: 'cancelled', error: null });
		expect(await shelf()).toEqual(['My Book']);
	});
});
