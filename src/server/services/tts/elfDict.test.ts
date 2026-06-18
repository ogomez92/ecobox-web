import { describe, it, expect } from 'vitest';
import { langidForVoiceId, parseDict, buildReplacer } from './elfDict';

describe('langidForVoiceId', () => {
	it('maps full IETF tags to langids', () => {
		expect(langidForVoiceId('Reed-en-US')).toBe('enu');
		expect(langidForVoiceId('Reed-en-GB')).toBe('eng');
		expect(langidForVoiceId('Shelley-es-ES')).toBe('esp');
		expect(langidForVoiceId('Reed-es-MX')).toBe('esm');
		expect(langidForVoiceId('Reed-pt-BR')).toBe('ptb');
		expect(langidForVoiceId('Reed-fr-CA')).toBe('frc');
	});

	it('accepts region-less primaries', () => {
		expect(langidForVoiceId('Reed-en')).toBe('enu');
		expect(langidForVoiceId('Reed-es')).toBe('esp');
	});

	it('is case-insensitive on the tag', () => {
		expect(langidForVoiceId('Reed-EN-us')).toBe('enu');
	});

	it('returns null for unknown / malformed / empty ids', () => {
		expect(langidForVoiceId('Reed-en-AU')).toBeNull(); // no Australian dict
		expect(langidForVoiceId('Reed-ja-JP')).toBeNull(); // CJK gated out
		expect(langidForVoiceId('NoDashHere')).toBeNull();
		expect(langidForVoiceId('')).toBeNull();
	});
});

describe('parseDict', () => {
	it('splits on the first tab and tolerates CRLF', () => {
		const m = parseDict('SNES\ts n e s\r\nAirbnb\tAir BNB\r\n');
		expect(m.get('SNES')).toBe('s n e s');
		expect(m.get('Airbnb')).toBe('Air BNB');
		expect(m.size).toBe(2);
	});

	it('preserves backtick annotations and internal spaces in the value', () => {
		const m = parseDict('AKA\t`1 A K A\nfacepalm\tface `0 palm\nfoobar\t`[f1ub2ar]\n');
		expect(m.get('AKA')).toBe('`1 A K A');
		expect(m.get('facepalm')).toBe('face `0 palm');
		expect(m.get('foobar')).toBe('`[f1ub2ar]');
	});

	it('keeps a value that itself contains a tab past the first', () => {
		const m = parseDict('key\tval\twith tab');
		expect(m.get('key')).toBe('val\twith tab');
	});

	it('skips blank lines, lines without a tab, and empty keys/values', () => {
		const m = parseDict('\nnotabhere\n\tno key\nkey\t\nGovt\tGovernment\n');
		expect(m.size).toBe(1);
		expect(m.get('Govt')).toBe('Government');
	});
});

describe('buildReplacer', () => {
	it('replaces only whole words', () => {
		const r = buildReplacer(new Map([['St', 'Street']]));
		expect(r('Start the St now')).toBe('Start the Street now');
	});

	it('is case-sensitive', () => {
		const r = buildReplacer(new Map([['facepalm', 'face palm']]));
		expect(r('facepalm Facepalm')).toBe('face palm Facepalm');
	});

	it('matches keys adjacent to punctuation', () => {
		const r = buildReplacer(new Map([['Govt', 'Government']]));
		expect(r('The Govt. acted')).toBe('The Government. acted');
	});

	it('matches keys that contain punctuation', () => {
		const r = buildReplacer(new Map([['P!nk', 'pink']]));
		expect(r('I like P!nk!')).toBe('I like pink!');
	});

	it('passes backtick-annotated replacements through verbatim', () => {
		const r = buildReplacer(new Map([['foobar', '`[f1ub2ar]']]));
		expect(r('a foobar b')).toBe('a `[f1ub2ar] b');
	});

	it('does not interpret $ in replacement values', () => {
		const r = buildReplacer(new Map([['x', '$1 $& done']]));
		expect(r('x')).toBe('$1 $& done');
	});

	it('prefers the longest matching key', () => {
		const r = buildReplacer(
			new Map([
				['Airbnb', 'Air BNB'],
				['Airbnbs', 'Air BNBs']
			])
		);
		expect(r('two Airbnbs here')).toBe('two Air BNBs here');
	});

	it('is a no-op for an empty dictionary', () => {
		const r = buildReplacer(new Map());
		expect(r('untouched text')).toBe('untouched text');
	});

	it('leaves non-dictionary words unchanged', () => {
		const r = buildReplacer(new Map([['SNES', 's n e s']]));
		expect(r('the console')).toBe('the console');
	});
});
