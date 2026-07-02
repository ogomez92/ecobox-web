import { describe, it, expect, beforeEach } from 'vitest';
import { retryAfter, recordFailure, recordSuccess, clientKey, _reset } from './rateLimit';

const KEY = '1.2.3.4';

describe('rateLimit', () => {
	beforeEach(() => _reset());

	it('allows the first 5 wrong guesses without locking out', () => {
		let now = 0;
		for (let i = 0; i < 5; i++) {
			expect(retryAfter(KEY, now)).toBe(0);
			recordFailure(KEY, now);
			now += 100;
		}
		// Still open right after the 5th failure.
		expect(retryAfter(KEY, now)).toBe(0);
	});

	it('locks out on the 6th guess and backs off exponentially', () => {
		const now = 0;
		for (let i = 0; i < 6; i++) recordFailure(KEY, now);
		// 6th failure → 5s lockout.
		expect(retryAfter(KEY, now)).toBe(5);

		recordFailure(KEY, 5_000); // after the lockout expires, guess again → 10s
		expect(retryAfter(KEY, 5_000)).toBe(10);

		recordFailure(KEY, 15_000); // → 20s
		expect(retryAfter(KEY, 15_000)).toBe(20);
	});

	it('caps the lockout at 15 minutes', () => {
		let now = 0;
		for (let i = 0; i < 40; i++) {
			recordFailure(KEY, now);
			now += 16 * 60_000; // always wait past any lockout before the next guess
		}
		expect(retryAfter(KEY, now)).toBeLessThanOrEqual(15 * 60);
	});

	it('a correct password (recordSuccess) clears the lockout immediately', () => {
		for (let i = 0; i < 6; i++) recordFailure(KEY, 0);
		expect(retryAfter(KEY, 0)).toBeGreaterThan(0);
		recordSuccess(KEY);
		expect(retryAfter(KEY, 0)).toBe(0);
	});

	it('forgets a key after 15 minutes of no failures', () => {
		for (let i = 0; i < 5; i++) recordFailure(KEY, 0);
		// 20 min later the window has decayed: the next failure starts from 1.
		const later = 20 * 60_000;
		recordFailure(KEY, later);
		expect(retryAfter(KEY, later)).toBe(0); // only 1 fail in the fresh window
	});

	it('keys separate IPs independently', () => {
		for (let i = 0; i < 6; i++) recordFailure('10.0.0.1', 0);
		expect(retryAfter('10.0.0.1', 0)).toBeGreaterThan(0);
		expect(retryAfter('10.0.0.2', 0)).toBe(0);
	});

	it('clientKey prefers the first X-Forwarded-For hop', () => {
		const req = new Request('https://x/', {
			headers: { 'x-forwarded-for': '203.0.113.7, 127.0.0.1' }
		});
		expect(clientKey(req, () => '127.0.0.1')).toBe('203.0.113.7');
	});

	it('clientKey falls back to getClientAddress when no header', () => {
		const req = new Request('https://x/');
		expect(clientKey(req, () => '198.51.100.9')).toBe('198.51.100.9');
	});
});
