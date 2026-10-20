import { describe, it, expect, vi } from 'vitest';

// The runner pulls in the sqlite connection and files.ts reads MEDIA_ROOT at
// import time; neither belongs in a unit test of the pure planning/prompt code.
vi.mock('$env/dynamic/private', () => ({ env: { MEDIA_ROOT: '/tmp/ecobox-test-media' } }));
vi.mock('$server/db', () => ({ db: {}, schema: {} }));

import {
	EMPTY_MEMORY,
	buildFullClosingPrompt,
	buildFullSystemPrompt,
	buildFullUserPrompt,
	chunkFrameCount,
	normalizeMemory,
	parseChunkAnswer,
	planChunks,
	cuesToVtt,
	sidecarPathFor,
	vttLanguage,
	vttTimestamp,
	estimateUsd,
	frameTokens,
	priceFor
} from './videoDescribeFull';
import { parseSubtitles, pickSubtitleFile } from './subtitles';
import { FULL_DESCRIBE_CHUNK_SECONDS } from '$lib/types';

describe('planChunks', () => {
	it('walks the file in ten-second windows with a shorter last one', () => {
		const chunks = planChunks(25);
		expect(chunks).toEqual([
			{ index: 0, start: 0, end: 10 },
			{ index: 1, start: 10, end: 20 },
			{ index: 2, start: 20, end: 25 }
		]);
	});

	it('divides evenly without an empty tail', () => {
		const chunks = planChunks(30);
		expect(chunks).toHaveLength(3);
		expect(chunks[2]).toEqual({ index: 2, start: 20, end: 30 });
	});

	it('folds a sub-second remainder into the previous chunk', () => {
		const chunks = planChunks(20.4);
		expect(chunks).toHaveLength(2);
		expect(chunks[1]).toEqual({ index: 1, start: 10, end: 20.4 });
	});

	it('keeps a remainder of at least a second as its own chunk', () => {
		const chunks = planChunks(21);
		expect(chunks).toHaveLength(3);
		expect(chunks[2]).toEqual({ index: 2, start: 20, end: 21 });
	});

	it('handles a file shorter than one chunk, and nothing at all', () => {
		expect(planChunks(4)).toEqual([{ index: 0, start: 0, end: 4 }]);
		expect(planChunks(0)).toEqual([]);
		expect(planChunks(NaN)).toEqual([]);
	});

	it('uses the shared chunk length by default', () => {
		expect(planChunks(100)[0].end).toBe(FULL_DESCRIBE_CHUNK_SECONDS);
	});
});

describe('chunkFrameCount', () => {
	it('is one frame per second, rounding a partial second up', () => {
		expect(chunkFrameCount({ index: 0, start: 0, end: 10 })).toBe(10);
		expect(chunkFrameCount({ index: 2, start: 20, end: 23.4 })).toBe(4);
		expect(chunkFrameCount({ index: 0, start: 0, end: 0.2 })).toBe(1);
	});
});

describe('normalizeMemory', () => {
	it('fills in a complete memory from nothing', () => {
		expect(normalizeMemory(undefined)).toEqual(EMPTY_MEMORY);
		expect(normalizeMemory('junk')).toEqual(EMPTY_MEMORY);
	});

	it('keeps the fields and drops nameless characters', () => {
		const m = normalizeMemory({
			summary: 'Two people argue in a kitchen.',
			characters: [
				{ name: 'Kim', appearance: 'blonde, ponytail', lastSeen: 'at the sink, 0:08' },
				{ appearance: 'no name' }
			],
			setting: 'a kitchen',
			onScreenText: ['ALBUQUERQUE, 2004'],
			openThreads: ['phone ringing']
		});
		expect(m.characters).toHaveLength(1);
		expect(m.characters[0].name).toBe('Kim');
		expect(m.onScreenText).toEqual(['ALBUQUERQUE, 2004']);
	});

	it('bounds the lists, keeping the newest entries', () => {
		const m = normalizeMemory({
			characters: Array.from({ length: 40 }, (_, i) => ({ name: `p${i}`, appearance: '', lastSeen: '' })),
			openThreads: Array.from({ length: 20 }, (_, i) => `t${i}`)
		});
		expect(m.characters).toHaveLength(30);
		expect(m.characters[0].name).toBe('p10');
		expect(m.openThreads).toHaveLength(12);
		expect(m.openThreads[0]).toBe('t8');
	});

	it('clips runaway text', () => {
		const m = normalizeMemory({ setting: 'x'.repeat(1000) });
		expect(m.setting.length).toBe(300);
	});
});

describe('parseChunkAnswer', () => {
	const previous = normalizeMemory({ summary: 'before', setting: 'a bar' });

	it('reads the structured answer', () => {
		const answer = parseChunkAnswer(
			JSON.stringify({ description: 'Kim walks in.', memory: { summary: 'after', characters: [] } }),
			previous
		);
		expect(answer.description).toBe('Kim walks in.');
		expect(answer.memory.summary).toBe('after');
	});

	it('tolerates a fenced answer', () => {
		const answer = parseChunkAnswer('```json\n{"description":"A door opens.","memory":{}}\n```', previous);
		expect(answer.description).toBe('A door opens.');
	});

	it('falls back to prose and carries the memory over', () => {
		const answer = parseChunkAnswer('A man crosses the street.', previous);
		expect(answer.description).toBe('A man crosses the street.');
		expect(answer.memory).toBe(previous);
	});

	it('keeps the previous memory when the answer has none', () => {
		const answer = parseChunkAnswer('{"description":"Nothing changes."}', previous);
		expect(answer.memory).toBe(previous);
	});
});

describe('prompts', () => {
	it('the system prompt carries the rules that make it a track', () => {
		const prompt = buildFullSystemPrompt('Spanish', true);
		expect(prompt).toContain('Describe only what can be SEEN');
		expect(prompt).toContain('Say what is NEW');
		expect(prompt).toContain('Use a name for a person only once it has been established');
		expect(prompt).toContain('Write the description in Spanish');
		expect(prompt).toContain('subtitles for the chunk are included');
		expect(buildFullSystemPrompt('English', false)).toContain('No subtitles are available');
	});

	it('the opening carries the memory and recent descriptions as JSON', () => {
		const memory = normalizeMemory({ summary: 'Kim is at the sink.', characters: [] });
		const prompt = buildFullUserPrompt({
			fileName: 'ep1',
			chunk: { index: 3, start: 30, end: 40 },
			totalChunks: 12,
			frameCount: 10,
			memory,
			recent: [{ start: 20, end: 30, text: 'She turns off the tap.' }]
		});
		expect(prompt).toContain('chunk 4 of 12');
		expect(prompt).toContain('from 0:30 to 0:40');
		expect(prompt).toContain('Continue the track');
		const json = JSON.parse(prompt.slice(prompt.indexOf('{')));
		expect(json.memory.summary).toBe('Kim is at the sink.');
		expect(json.previousDescriptions).toEqual([{ from: '0:20', to: '0:30', text: 'She turns off the tap.' }]);
	});

	it('the first chunk is told to establish the scene', () => {
		const prompt = buildFullUserPrompt({
			fileName: 'ep1',
			chunk: { index: 0, start: 0, end: 10 },
			totalChunks: 12,
			frameCount: 10,
			memory: EMPTY_MEMORY,
			recent: []
		});
		expect(prompt).toContain('very first chunk');
	});

	it('the closing carries subtitles only when there are some', () => {
		expect(buildFullClosingPrompt(null)).not.toContain('Subtitles');
		expect(buildFullClosingPrompt('[0:01] Hi')).toContain('[0:01] Hi');
	});
});

describe('sidecar (.description.vtt)', () => {
	const cues = [
		{ start: 0, end: 10, text: 'A man in glasses crosses the mall.' },
		{ start: 10, end: 20, text: '' },
		{ start: 20, end: 25.25, text: 'He dials a payphone & waits.\n\nText on screen: <OPEN>.' }
	];

	it('formats WebVTT timestamps', () => {
		expect(vttTimestamp(0)).toBe('00:00:00.000');
		expect(vttTimestamp(25.25)).toBe('00:00:25.250');
		expect(vttTimestamp(3725.5)).toBe('01:02:05.500');
	});

	it('writes a descriptions-kind track, skipping empty cues and escaping text', () => {
		const vtt = cuesToVtt(cues, { language: 'en', title: 'clip' });
		expect(vtt.startsWith('WEBVTT\nKind: descriptions\nLanguage: en\n')).toBe(true);
		expect(vtt).toContain('00:00:00.000 --> 00:00:10.000\nA man in glasses crosses the mall.');
		expect(vtt).not.toContain('00:00:10.000 -->');
		expect(vtt).toContain('&amp; waits.\nText on screen: &lt;OPEN&gt;.');
		expect(vttLanguage(vtt)).toBe('en');
	});

	it('round-trips through the subtitle parser', () => {
		const parsed = parseSubtitles(cuesToVtt(cues, { language: 'es', title: 'clip' }), 'vtt');
		expect(parsed).toHaveLength(2);
		expect(parsed[0]).toEqual({ start: 0, end: 10, text: 'A man in glasses crosses the mall.' });
		expect(parsed[1].start).toBeCloseTo(20);
		expect(parsed[1].end).toBeCloseTo(25.25);
		expect(parsed[1].text).toBe('He dials a payphone & waits.\nText on screen: <OPEN>.');
	});

	it('names the file so the caption picker leaves it alone', () => {
		const sidecar = sidecarPathFor('/media/Show/ep1.mkv');
		expect(sidecar).toBe('/media/Show/ep1.description.vtt');
		expect(pickSubtitleFile('ep1.mkv', ['ep1.mkv', 'ep1.description.vtt'])).toBeNull();
	});
});

describe('cost estimate', () => {
	it('prices known models by longest prefix and nothing else', () => {
		expect(priceFor('claude-opus-5')).toEqual({ input: 5, output: 25 });
		expect(priceFor('claude-sonnet-4-6')).toEqual({ input: 3, output: 15 });
		expect(priceFor('claude-fable-5-1')).toEqual({ input: 10, output: 50 });
		expect(priceFor('some-future-model')).toBeNull();
	});

	it('sizes a frame after the send-time downscale', () => {
		expect(frameTokens(768, 432)).toBe(Math.ceil((768 * 432) / 750));
		// A 1080p source is sent at 1280 wide.
		expect(frameTokens(1920, 1080)).toBe(Math.ceil((1280 * 720) / 750));
		expect(frameTokens(0, 0)).toBeGreaterThan(0);
	});

	it('turns tokens into dollars, or null for an unpriced model', () => {
		expect(estimateUsd('claude-opus-5', 1_000_000, 100_000)).toBeCloseTo(7.5);
		expect(estimateUsd('mystery', 1, 1)).toBeNull();
	});
});
