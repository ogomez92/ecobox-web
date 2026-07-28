import { describe, it, expect } from 'vitest';
import { ifRangeMatches, parseRangeHeader } from './httpRange';

const SIZE = 184744381; // the mp3 that surfaced the If-Range bug
const ETAG = '"ec20a7f5aa7d51c7"';
const MTIME = new Date('2026-07-28T17:16:28.325Z');

describe('ifRangeMatches', () => {
	it('matches an identical strong entity-tag', () => {
		expect(ifRangeMatches(ETAG, ETAG, MTIME)).toBe(true);
		expect(ifRangeMatches(` ${ETAG} `, ETAG, MTIME)).toBe(true);
	});

	it('rejects a stale entity-tag (the delete-and-re-upload case)', () => {
		expect(ifRangeMatches('"0000000000000000"', ETAG, MTIME)).toBe(false);
	});

	it('never matches a weak validator', () => {
		expect(ifRangeMatches(`W/${ETAG}`, ETAG, MTIME)).toBe(false);
	});

	it('matches a date validator at second granularity', () => {
		// The Last-Modified we emit floors the sub-second part, so the value the
		// client echoes back must still count as a match.
		expect(ifRangeMatches(MTIME.toUTCString(), ETAG, MTIME)).toBe(true);
	});

	it('rejects a different or unparseable date', () => {
		expect(ifRangeMatches(new Date('2026-07-28T17:16:27.000Z').toUTCString(), ETAG, MTIME)).toBe(false);
		expect(ifRangeMatches('not a date', ETAG, MTIME)).toBe(false);
		expect(ifRangeMatches('', ETAG, MTIME)).toBe(false);
	});
});

describe('parseRangeHeader', () => {
	it('parses an explicit range', () => {
		expect(parseRangeHeader('bytes=0-1', SIZE)).toEqual({ start: 0, end: 1 });
		expect(parseRangeHeader('bytes=54720445-54730000', SIZE)).toEqual({
			start: 54720445,
			end: 54730000
		});
	});

	it('parses an open-ended range to the last byte', () => {
		expect(parseRangeHeader('bytes=54720445-', SIZE)).toEqual({
			start: 54720445,
			end: SIZE - 1
		});
	});

	it('clamps an end past EOF instead of rejecting it', () => {
		// This used to 416 internally and surface as a 500.
		expect(parseRangeHeader('bytes=184744000-999999999', SIZE)).toEqual({
			start: 184744000,
			end: SIZE - 1
		});
	});

	it('parses a suffix range', () => {
		expect(parseRangeHeader('bytes=-500', SIZE)).toEqual({ start: SIZE - 500, end: SIZE - 1 });
	});

	it('treats an oversized suffix as the whole representation', () => {
		expect(parseRangeHeader('bytes=-999999999', SIZE)).toEqual({ start: 0, end: SIZE - 1 });
	});

	it('reports unsatisfiable ranges as null', () => {
		expect(parseRangeHeader(`bytes=${SIZE}-`, SIZE)).toBeNull();
		expect(parseRangeHeader('bytes=100-50', SIZE)).toBeNull();
		expect(parseRangeHeader('bytes=-0', SIZE)).toBeNull();
		expect(parseRangeHeader('bytes=0-', 0)).toBeNull();
	});

	it('reports an unusable header as undefined so the full body is sent', () => {
		expect(parseRangeHeader('items=0-1', SIZE)).toBeUndefined();
		expect(parseRangeHeader('bytes=-', SIZE)).toBeUndefined();
		expect(parseRangeHeader('garbage', SIZE)).toBeUndefined();
	});

	it('serves the first range of a multi-range request', () => {
		expect(parseRangeHeader('bytes=0-9,20-29', SIZE)).toEqual({ start: 0, end: 9 });
	});
});
