import { describe, it, expect, vi } from 'vitest';

// files.ts reads env.MEDIA_ROOT at import time through $env/dynamic/private, and
// the key lookup pulls in the sqlite connection — neither belongs in a unit test
// of the pure planning/prompt helpers.
vi.mock('$env/dynamic/private', () => ({ env: { MEDIA_ROOT: '/tmp/ecobox-test-media' } }));
vi.mock('$server/db', () => ({ db: {}, schema: {} }));

import {
	buildClosingPrompt,
	buildSystemPrompt,
	buildUserPrompt,
	formatTimestamp,
	frameTimes,
	languageName,
	planFrames,
	subtitleContext
} from './videoDescribe';
import { MAX_DESCRIBE_FRAMES } from '$lib/types';

describe('planFrames', () => {
	it('samples once a second up to the cap', () => {
		expect(planFrames(10)).toEqual({ count: 10, interval: 1, sampled: false });
		expect(planFrames(MAX_DESCRIBE_FRAMES)).toEqual({
			count: MAX_DESCRIBE_FRAMES,
			interval: 1,
			sampled: false
		});
	});

	it('rounds a fractional segment up so its last second is still seen', () => {
		expect(planFrames(10.4)).toEqual({ count: 11, interval: 1, sampled: false });
	});

	it('never plans fewer than one frame', () => {
		expect(planFrames(0.3).count).toBe(1);
		expect(planFrames(0).count).toBe(1);
		expect(planFrames(NaN).count).toBe(1);
	});

	it('spreads the cap over a long segment and flags it as sampled', () => {
		const plan = planFrames(300);
		expect(plan.count).toBe(MAX_DESCRIBE_FRAMES);
		expect(plan.interval).toBeCloseTo(6);
		expect(plan.sampled).toBe(true);
	});

	it('costs the same fifty frames for a whole film', () => {
		const plan = planFrames(2 * 3600);
		expect(plan.count).toBe(MAX_DESCRIBE_FRAMES);
		expect(plan.interval).toBeCloseTo(144);
		expect(plan.sampled).toBe(true);
	});

	it('never exceeds the cap for any duration', () => {
		for (const duration of [0.5, 1, 7, 49.9, 50.1, 90, 200, 3000, 7200]) {
			expect(planFrames(duration).count).toBeLessThanOrEqual(MAX_DESCRIBE_FRAMES);
		}
	});
});

describe('frameTimes', () => {
	it('starts at the mark and steps by the interval', () => {
		expect(frameTimes(600, { count: 3, interval: 1, sampled: false })).toEqual([600, 601, 602]);
		expect(frameTimes(10, { count: 3, interval: 6, sampled: true })).toEqual([10, 16, 22]);
	});
});

describe('formatTimestamp', () => {
	it('drops the hour until there is one', () => {
		expect(formatTimestamp(0)).toBe('0:00');
		expect(formatTimestamp(65)).toBe('1:05');
		expect(formatTimestamp(3600)).toBe('1:00:00');
		expect(formatTimestamp(3725)).toBe('1:02:05');
	});

	it('never renders a negative time', () => {
		expect(formatTimestamp(-5)).toBe('0:00');
	});
});

describe('languageName', () => {
	it('maps the UI locales onto a language the model can be asked for', () => {
		expect(languageName('es')).toBe('Spanish');
		expect(languageName('pt-BR')).toBe('English'); // unsupported → the default
		expect(languageName('ja')).toBe('Japanese');
		expect(languageName(undefined)).toBe('English');
	});
});

describe('buildSystemPrompt', () => {
	it('asks for the requested language', () => {
		expect(buildSystemPrompt('Spanish', true)).toContain('Write in Spanish.');
	});

	it('states the rules the feature lives on', () => {
		const prompt = buildSystemPrompt('English', true);
		// The listener hears the film: repeating the dialogue is the failure mode.
		expect(prompt).toMatch(/never restate/i);
		// On-screen text is the information they cannot get any other way.
		expect(prompt).toMatch(/text that appears on screen/i);
		// Motion between samples is what stills lose; the model must infer it.
		expect(prompt).toMatch(/CHANGES as the segment runs/);
		// The model must not talk about the frames it was shown.
		expect(prompt).toMatch(/never mention frames/i);
	});

	it('explains the subtitles only when there are some to explain', () => {
		expect(buildSystemPrompt('English', true)).toMatch(/subtitles for the segment are included/i);
		expect(buildSystemPrompt('English', false)).toMatch(/no subtitles are available/i);
	});

	it('guards against tag leakage, since thinking is off for this call', () => {
		expect(buildSystemPrompt('English', false)).toMatch(/XML tags/);
	});
});

describe('buildUserPrompt', () => {
	it('places the segment in the film and says how it was sampled', () => {
		const prompt = buildUserPrompt({
			fileName: 'Episode 4',
			start: 600,
			end: 610,
			plan: planFrames(10)
		});
		expect(prompt).toContain('"Episode 4"');
		expect(prompt).toContain('from 10:00 to 10:10');
		expect(prompt).toContain('10 frames');
		expect(prompt).toContain('one frame per second');
		expect(prompt).not.toMatch(/sparse/);
	});

	it('warns the model when the frames are sparse', () => {
		const prompt = buildUserPrompt({
			fileName: 'Film',
			start: 0,
			end: 300,
			plan: planFrames(300)
		});
		expect(prompt).toContain('one frame every 6.0 seconds');
		expect(prompt).toMatch(/sparse/);
	});
});

describe('subtitleContext', () => {
	const cues = [
		{ start: 5, end: 8, text: 'Before the segment.' },
		{ start: 9, end: 12, text: 'Overlaps the start.' },
		{ start: 14, end: 16, text: 'Inside,\nsplit over two lines.' },
		{ start: 19, end: 22, text: 'Overlaps the end.' },
		{ start: 25, end: 27, text: 'After the segment.' }
	];

	it('keeps only the cues that overlap the segment, one per line with its time', () => {
		expect(subtitleContext(cues, 10, 20)).toBe(
			['[0:09] Overlaps the start.', '[0:14] Inside, split over two lines.', '[0:19] Overlaps the end.'].join(
				'\n'
			)
		);
	});

	it('is null when nothing is said in the segment', () => {
		expect(subtitleContext(cues, 30, 40)).toBeNull();
		expect(subtitleContext([], 0, 10)).toBeNull();
	});

	it('stops adding cues once the cap is reached rather than failing', () => {
		const chatty = Array.from({ length: 500 }, (_, i) => ({
			start: i,
			end: i + 1,
			text: 'x'.repeat(50)
		}));
		const context = subtitleContext(chatty, 0, 500) ?? '';
		expect(context.length).toBeLessThanOrEqual(4000);
		expect(context.length).toBeGreaterThan(3000);
	});
});

describe('buildClosingPrompt', () => {
	it('hands the subtitles over marked as already heard, or asks plainly without them', () => {
		expect(buildClosingPrompt('[0:01] Hello')).toMatch(/must not repeat:\n\[0:01\] Hello/);
		expect(buildClosingPrompt(null)).toBe('Describe what is visible across the segment.');
	});
});
