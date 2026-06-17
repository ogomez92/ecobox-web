import { describe, it, expect } from 'vitest';
import { countWords, verifyPass, VERIFY_MIN_RATIO } from './bookVerify';

describe('countWords', () => {
	it('counts unicode letter/number tokens', () => {
		expect(countWords('Hello, world!')).toBe(2);
		expect(countWords('one two three four')).toBe(4);
		expect(countWords('   ')).toBe(0);
		expect(countWords('café déjà 42')).toBe(3);
	});
});

describe('verifyPass', () => {
	it('passes when md is at least the ratio of source words', () => {
		expect(verifyPass({ mdWords: 95, sourceWords: 100, pandocOk: true })).toBe(true);
		expect(verifyPass({ mdWords: 90, sourceWords: 100, pandocOk: true })).toBe(true);
	});

	it('fails on truncation (md well below source)', () => {
		expect(verifyPass({ mdWords: 50, sourceWords: 100, pandocOk: true })).toBe(false);
	});

	it('fails when pandoc errored, md empty, or source unknown', () => {
		expect(verifyPass({ mdWords: 100, sourceWords: 100, pandocOk: false })).toBe(false);
		expect(verifyPass({ mdWords: 0, sourceWords: 100, pandocOk: true })).toBe(false);
		expect(verifyPass({ mdWords: 100, sourceWords: 0, pandocOk: true })).toBe(false);
	});

	it('uses a 0.9 lower bound', () => {
		expect(VERIFY_MIN_RATIO).toBe(0.9);
		const justUnder = Math.floor(0.9 * 100) - 1;
		expect(verifyPass({ mdWords: justUnder, sourceWords: 100, pandocOk: true })).toBe(false);
	});
});
