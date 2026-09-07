import { describe, it, expect, vi } from 'vitest';

// files.ts reads env.MEDIA_ROOT at import time through $env/dynamic/private, and
// the key lookup pulls in the sqlite connection — neither belongs in a unit test
// of the pure planning/prompt helpers.
vi.mock('$env/dynamic/private', () => ({ env: { MEDIA_ROOT: '/tmp/ecobox-test-media' } }));
vi.mock('$server/db', () => ({ db: {}, schema: {} }));

import {
	buildSystemPrompt,
	buildUserPrompt,
	formatTimestamp,
	languageName,
	planVideoFps
} from './videoDescribe';
import { MAX_DESCRIBE_SECONDS } from '$lib/types';

describe('planVideoFps', () => {
	it('samples a short mark finely — that is where the detail is wanted', () => {
		expect(planVideoFps(3)).toBe(2);
		expect(planVideoFps(20)).toBe(2);
	});

	it('thins out as the segment grows, so a long mark stays affordable', () => {
		expect(planVideoFps(21)).toBe(1);
		expect(planVideoFps(60)).toBe(1);
		expect(planVideoFps(120)).toBe(0.5);
		expect(planVideoFps(MAX_DESCRIBE_SECONDS)).toBe(0.25);
	});

	it('always stays inside the rate the API accepts', () => {
		for (const duration of [0.5, 1, 7, 20, 45, 90, 200, MAX_DESCRIBE_SECONDS]) {
			const fps = planVideoFps(duration);
			expect(fps).toBeGreaterThan(0);
			expect(fps).toBeLessThanOrEqual(24);
		}
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
		// Motion is what stills would have lost, and why this sends video at all.
		expect(prompt).toMatch(/CHANGES as the segment runs/);
	});

	it('tells the model it can hear the clip only when there is audio to hear', () => {
		expect(buildSystemPrompt('English', true)).toMatch(/You can hear this clip/);
		expect(buildSystemPrompt('English', false)).toMatch(/no audio track/);
		expect(buildSystemPrompt('English', false)).not.toMatch(/You can hear this clip/);
	});
});

describe('buildUserPrompt', () => {
	it('states the segment in the same clock the player shows', () => {
		const prompt = buildUserPrompt({ fileName: 'Episode 1', start: 61, end: 75.5 });
		expect(prompt).toContain('from 1:01 to 1:15');
		expect(prompt).toContain('14.5 seconds');
		expect(prompt).toContain('Episode 1');
	});
});
