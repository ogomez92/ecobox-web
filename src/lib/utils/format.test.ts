import { describe, it, expect } from 'vitest';
import { formatBytes, formatDuration, formatDurationAccessible } from './format';

describe('formatBytes', () => {
	it('formats zero bytes', () => {
		expect(formatBytes(0)).toBe('0 B');
	});

	it('formats bytes', () => {
		expect(formatBytes(500)).toBe('500 B');
	});

	it('formats kilobytes', () => {
		expect(formatBytes(1024)).toBe('1.0 KB');
		expect(formatBytes(1536)).toBe('1.5 KB');
	});

	it('formats megabytes', () => {
		expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
		expect(formatBytes(1024 * 1024 * 2.5)).toBe('2.5 MB');
	});

	it('formats gigabytes', () => {
		expect(formatBytes(1024 * 1024 * 1024)).toBe('1.0 GB');
	});
});

describe('formatDuration', () => {
	it('returns placeholder for invalid input', () => {
		expect(formatDuration(0)).toBe('--:--');
		expect(formatDuration(NaN)).toBe('--:--');
		expect(formatDuration(Infinity)).toBe('--:--');
	});

	it('formats seconds only', () => {
		expect(formatDuration(45)).toBe('0:45');
	});

	it('formats minutes and seconds', () => {
		expect(formatDuration(125)).toBe('2:05');
		expect(formatDuration(600)).toBe('10:00');
	});

	it('formats hours, minutes and seconds', () => {
		expect(formatDuration(3661)).toBe('1:01:01');
		expect(formatDuration(7325)).toBe('2:02:05');
	});

	it('pads correctly', () => {
		expect(formatDuration(5)).toBe('0:05');
		expect(formatDuration(65)).toBe('1:05');
		expect(formatDuration(3605)).toBe('1:00:05');
	});
});

describe('formatDurationAccessible', () => {
	it('returns placeholder for invalid input', () => {
		expect(formatDurationAccessible(0)).toBe('Unknown duration');
		expect(formatDurationAccessible(NaN)).toBe('Unknown duration');
	});

	it('formats singular units correctly', () => {
		expect(formatDurationAccessible(1)).toBe('1 second');
		expect(formatDurationAccessible(60)).toBe('1 minute');
		expect(formatDurationAccessible(3600)).toBe('1 hour');
	});

	it('formats plural units correctly', () => {
		expect(formatDurationAccessible(45)).toBe('45 seconds');
		expect(formatDurationAccessible(120)).toBe('2 minutes');
		expect(formatDurationAccessible(7200)).toBe('2 hours');
	});

	it('combines multiple units', () => {
		expect(formatDurationAccessible(125)).toBe('2 minutes, 5 seconds');
		expect(formatDurationAccessible(3661)).toBe('1 hour, 1 minute');
	});

	it('omits seconds when hours are present', () => {
		expect(formatDurationAccessible(3605)).toBe('1 hour');
	});
});
