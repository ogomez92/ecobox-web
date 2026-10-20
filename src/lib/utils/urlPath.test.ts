import { describe, it, expect } from 'vitest';
import { encodePathSegments } from './urlPath';

describe('encodePathSegments', () => {
	it('keeps slashes and encodes each segment', () => {
		expect(encodePathSegments('Show/Al 50 %.mp3')).toBe('Show/Al%2050%20%25.mp3');
	});
	it('encodes # and ? so they are not taken as fragment / query', () => {
		expect(encodePathSegments('a#b/c?d.mp3')).toBe('a%23b/c%3Fd.mp3');
	});
	it('round-trips through decodeURIComponent per segment', () => {
		const p = 'Música/Capítulo 1 & 2 (50%).mp3';
		expect(encodePathSegments(p).split('/').map(decodeURIComponent).join('/')).toBe(p);
	});
	it('leaves an empty path empty', () => {
		expect(encodePathSegments('')).toBe('');
	});
});
