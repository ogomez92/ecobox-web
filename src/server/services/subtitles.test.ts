import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

// getMediaRoot() reads env.MEDIA_ROOT lazily, so a mutable mocked env lets the
// lookup tests run against a throwaway media tree.
const { mockEnv } = vi.hoisted(() => ({ mockEnv: { MEDIA_ROOT: '' } as { MEDIA_ROOT: string } }));
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

import { parseSrt, findSubtitleFile, getSubtitles } from './subtitles';

const SIMPLE = `1
00:00:01,000 --> 00:00:04,000
Hello there

2
00:00:05,500 --> 00:00:07,250
Second line
split in two
`;

describe('parseSrt', () => {
	it('parses a well-formed file', () => {
		expect(parseSrt(SIMPLE)).toEqual([
			{ start: 1, end: 4, text: 'Hello there' },
			{ start: 5.5, end: 7.25, text: 'Second line\nsplit in two' }
		]);
	});

	it('accepts CRLF line endings and a UTF-8 BOM', () => {
		const cues = parseSrt('﻿' + SIMPLE.replace(/\n/g, '\r\n'));
		expect(cues).toHaveLength(2);
		expect(cues[0].text).toBe('Hello there');
	});

	it('handles hours beyond a day and a dot as the decimal separator', () => {
		const cues = parseSrt('1\n25:00:00.500 --> 25:00:02.000\nLate\n');
		expect(cues[0].start).toBeCloseTo(90000.5, 3);
		expect(cues[0].end).toBeCloseTo(90002, 3);
	});

	it('accepts the MM:SS form some tools emit', () => {
		const cues = parseSrt('01:02,000 --> 01:05,000\nNo hours\n');
		expect(cues[0]).toEqual({ start: 62, end: 65, text: 'No hours' });
	});

	it('pads short millisecond fields', () => {
		const cues = parseSrt('00:00:01,5 --> 00:00:02,25\nPadded\n');
		expect(cues[0].start).toBeCloseTo(1.5, 3);
		expect(cues[0].end).toBeCloseTo(2.25, 3);
	});

	it('parses cues with no index numbers', () => {
		const cues = parseSrt('00:00:01,000 --> 00:00:02,000\nOne\n\n00:00:03,000 --> 00:00:04,000\nTwo\n');
		expect(cues.map((c) => c.text)).toEqual(['One', 'Two']);
	});

	it('splits cues that are missing the blank separator', () => {
		const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,000\nOne\n2\n00:00:03,000 --> 00:00:04,000\nTwo\n');
		expect(cues.map((c) => c.text)).toEqual(['One', 'Two']);
	});

	it('keeps a number that is genuinely the cue text', () => {
		const cues = parseSrt('1\n00:00:01,000 --> 00:00:02,000\n42\n\n');
		expect(cues[0].text).toBe('42');
	});

	it('strips HTML tags, ASS overrides and entities', () => {
		const cues = parseSrt(
			'1\n00:00:01,000 --> 00:00:02,000\n{\\an8}<i>Bond</i> &amp; <font color="#fff">Q</font> &#39;93\n'
		);
		expect(cues[0].text).toBe("Bond & Q '93");
	});

	it('drops cues whose text is empty after cleaning', () => {
		expect(parseSrt('1\n00:00:01,000 --> 00:00:02,000\n<i></i>\n\n')).toEqual([]);
	});

	it('orders cues by start time', () => {
		const cues = parseSrt(
			'1\n00:00:09,000 --> 00:00:10,000\nLater\n\n2\n00:00:01,000 --> 00:00:02,000\nEarlier\n'
		);
		expect(cues.map((c) => c.text)).toEqual(['Earlier', 'Later']);
	});

	it('never lets end precede start', () => {
		const cues = parseSrt('1\n00:00:05,000 --> 00:00:02,000\nBackwards\n');
		expect(cues[0].end).toBe(cues[0].start);
	});

	it('returns nothing for text that is not a subtitle file', () => {
		expect(parseSrt('just some notes\nwith no timings at all')).toEqual([]);
		expect(parseSrt('')).toEqual([]);
	});
});

describe('subtitle file lookup', () => {
	let root: string;

	beforeAll(() => {
		root = fs.mkdtempSync(path.join(os.tmpdir(), 'ecobox-srt-'));
		mockEnv.MEDIA_ROOT = root;

		fs.writeFileSync(path.join(root, 'Alone.mp3'), 'audio');

		fs.mkdirSync(path.join(root, 'Book'));
		fs.writeFileSync(path.join(root, 'Book', 'Chapter 1.mp3'), 'audio');
		fs.writeFileSync(path.join(root, 'Book', 'Chapter 1.srt'), SIMPLE);
		// Some rippers keep the media extension: "movie.mp4.srt".
		fs.writeFileSync(path.join(root, 'Book', 'Chapter 2.mp3'), 'audio');
		fs.writeFileSync(path.join(root, 'Book', 'Chapter 2.mp3.SRT'), SIMPLE);
		// A latin-1 track, which is what most Spanish/French .srt files are.
		fs.writeFileSync(path.join(root, 'Book', 'Chapter 3.mp3'), 'audio');
		fs.writeFileSync(
			path.join(root, 'Book', 'Chapter 3.srt'),
			Buffer.from('1\n00:00:01,000 --> 00:00:02,000\nCapítulo\n', 'latin1')
		);
	});

	afterAll(() => {
		fs.rmSync(root, { recursive: true, force: true });
	});

	it('finds the sibling track named after the media file', async () => {
		expect(await findSubtitleFile('Book/Chapter 1.mp3')).toBe('Book/Chapter 1.srt');
	});

	it('accepts the "<name>.<ext>.srt" form, case-insensitively', async () => {
		expect(await findSubtitleFile('Book/Chapter 2.mp3')).toBe('Book/Chapter 2.mp3.SRT');
	});

	it('finds a track at the media root', async () => {
		fs.writeFileSync(path.join(root, 'Alone.srt'), SIMPLE);
		expect(await findSubtitleFile('Alone.mp3')).toBe('Alone.srt');
	});

	it('returns null when there is no track, or the folder is gone', async () => {
		expect(await findSubtitleFile('Book/Chapter 9.mp3')).toBeNull();
		expect(await findSubtitleFile('Nowhere/Chapter 1.mp3')).toBeNull();
	});

	it('reads and parses the track a media file points at', async () => {
		const track = await getSubtitles('Book/Chapter 1.mp3');
		expect(track?.path).toBe('Book/Chapter 1.srt');
		expect(track?.cues).toHaveLength(2);
	});

	it('rescues a windows-1252 track', async () => {
		const track = await getSubtitles('Book/Chapter 3.mp3');
		expect(track?.cues[0].text).toBe('Capítulo');
	});

	it('answers null for media with no subtitles', async () => {
		expect(await getSubtitles('Book/Chapter 9.mp3')).toBeNull();
	});

	it('refuses to escape the media root', async () => {
		await expect(findSubtitleFile('../../etc/passwd')).rejects.toThrow(/traversal/);
	});
});
