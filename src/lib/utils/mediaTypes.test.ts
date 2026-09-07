import { describe, it, expect } from 'vitest';
import {
	extensionOf,
	isAudioExtension,
	isVideoExtension,
	isPlayableVideoExtension,
	needsAudioExtraction,
	isPlayableMedia,
	isBrowserPlayableAudioCodec,
	isReencodableVideoExtension
} from './mediaTypes';

describe('extensionOf', () => {
	it('lowercases and keeps the dot', () => {
		expect(extensionOf('Movie.MP4')).toBe('.mp4');
		expect(extensionOf('a/b/c.mkv')).toBe('.mkv');
		expect(extensionOf('a\\b\\c.mkv')).toBe('.mkv');
	});

	it('has no extension for a bare or dot-leading name', () => {
		expect(extensionOf('README')).toBe('');
		// A leading dot marks a hidden file, not an extension.
		expect(extensionOf('.CHAPTERED')).toBe('');
		expect(extensionOf('folder.name/file')).toBe('');
	});
});

describe('classification', () => {
	it('recognizes audio', () => {
		expect(isAudioExtension('track.mp3')).toBe(true);
		expect(isAudioExtension('book.m4b')).toBe(true);
		expect(isAudioExtension('clip.mp4')).toBe(false);
	});

	it('recognizes video in both families', () => {
		expect(isVideoExtension('clip.mp4')).toBe(true);
		expect(isVideoExtension('rip.mkv')).toBe(true);
		expect(isVideoExtension('track.mp3')).toBe(false);
		expect(isVideoExtension('notes.txt')).toBe(false);
	});

	it('splits video by whether a browser can demux it', () => {
		expect(isPlayableVideoExtension('clip.mp4')).toBe(true);
		expect(needsAudioExtraction('clip.mp4')).toBe(false);

		expect(isPlayableVideoExtension('rip.mkv')).toBe(false);
		expect(needsAudioExtraction('rip.mkv')).toBe(true);
		expect(needsAudioExtraction('old.avi')).toBe(true);
	});

	it('never asks to extract audio from something that is not a video', () => {
		expect(needsAudioExtraction('track.mp3')).toBe(false);
		expect(needsAudioExtraction('book.epub')).toBe(false);
	});

	it('counts audio and playable video as playable, nothing else', () => {
		expect(isPlayableMedia('track.flac')).toBe(true);
		expect(isPlayableMedia('clip.webm')).toBe(true);
		expect(isPlayableMedia('rip.mkv')).toBe(false); // needs extraction first
		expect(isPlayableMedia('subs.srt')).toBe(false);
		expect(isPlayableMedia('station.radio')).toBe(false);
	});
});

describe('isBrowserPlayableAudioCodec', () => {
	it('accepts the codecs every browser decodes', () => {
		expect(isBrowserPlayableAudioCodec('aac')).toBe(true);
		expect(isBrowserPlayableAudioCodec('mp3')).toBe(true);
		expect(isBrowserPlayableAudioCodec('opus')).toBe(true);
		expect(isBrowserPlayableAudioCodec('vorbis')).toBe(true);
		expect(isBrowserPlayableAudioCodec('flac')).toBe(true);
	});

	it('rejects the licensed codecs that make an .mp4 play silence', () => {
		// The whole reason this predicate exists: these demux fine and decode to nothing.
		expect(isBrowserPlayableAudioCodec('eac3')).toBe(false);
		expect(isBrowserPlayableAudioCodec('ac3')).toBe(false);
		expect(isBrowserPlayableAudioCodec('dts')).toBe(false);
		expect(isBrowserPlayableAudioCodec('truehd')).toBe(false);
		expect(isBrowserPlayableAudioCodec('wmav2')).toBe(false);
	});

	it('errs towards re-encoding when the codec is unknown or absent', () => {
		expect(isBrowserPlayableAudioCodec(undefined)).toBe(false);
		expect(isBrowserPlayableAudioCodec(null)).toBe(false);
		expect(isBrowserPlayableAudioCodec('')).toBe(false);
		expect(isBrowserPlayableAudioCodec('alac')).toBe(false); // Safari-only
	});

	it('takes ffprobe output as it comes', () => {
		expect(isBrowserPlayableAudioCodec('AAC')).toBe(true);
		expect(isBrowserPlayableAudioCodec('  eac3 ')).toBe(false);
	});
});

describe('isReencodableVideoExtension', () => {
	it('is the MP4 family, which is where AAC can go', () => {
		expect(isReencodableVideoExtension('ep.mp4')).toBe(true);
		expect(isReencodableVideoExtension('ep.m4v')).toBe(true);
		expect(isReencodableVideoExtension('ep.MOV')).toBe(true);
	});

	it('excludes WebM, which has nowhere to put an AAC track', () => {
		expect(isReencodableVideoExtension('clip.webm')).toBe(false);
	});

	it('excludes containers that must be extracted instead, and non-videos', () => {
		expect(isReencodableVideoExtension('rip.mkv')).toBe(false);
		expect(isReencodableVideoExtension('track.mp3')).toBe(false);
	});
});
