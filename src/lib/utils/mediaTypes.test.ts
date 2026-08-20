import { describe, it, expect } from 'vitest';
import {
	extensionOf,
	isAudioExtension,
	isVideoExtension,
	isPlayableVideoExtension,
	needsAudioExtraction,
	isPlayableMedia
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
