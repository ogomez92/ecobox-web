import { describe, it, expect } from 'vitest';
import { parseRadioFile, buildStreamUrl } from './radio';

describe('parseRadioFile', () => {
	it('parses basic URL', () => {
		const content = 'url=https://stream.example.com/live';
		const result = parseRadioFile(content);

		expect(result.url).toBe('https://stream.example.com/live');
		expect(result.name).toBeUndefined();
		expect(result.auth).toBeUndefined();
	});

	it('parses URL with name', () => {
		const content = `url=https://stream.example.com/live
name=My Radio Station`;
		const result = parseRadioFile(content);

		expect(result.url).toBe('https://stream.example.com/live');
		expect(result.name).toBe('My Radio Station');
	});

	it('parses URL with auth credentials', () => {
		const content = `url=https://stream.example.com/live
username=myuser
password=mypass`;
		const result = parseRadioFile(content);

		expect(result.url).toBe('https://stream.example.com/live');
		expect(result.auth).toEqual({
			username: 'myuser',
			password: 'mypass'
		});
	});

	it('parses full config', () => {
		const content = `# My favorite radio station
url=https://stream.example.com/live
name=Jazz FM
username=listener
password=secret123`;
		const result = parseRadioFile(content);

		expect(result.url).toBe('https://stream.example.com/live');
		expect(result.name).toBe('Jazz FM');
		expect(result.auth?.username).toBe('listener');
		expect(result.auth?.password).toBe('secret123');
	});

	it('ignores empty lines and comments', () => {
		const content = `
# This is a comment
url=https://stream.example.com/live

# Another comment
name=Test Station
`;
		const result = parseRadioFile(content);

		expect(result.url).toBe('https://stream.example.com/live');
		expect(result.name).toBe('Test Station');
	});

	it('requires both username and password for auth', () => {
		const content = `url=https://stream.example.com/live
username=onlyuser`;
		const result = parseRadioFile(content);

		expect(result.auth).toBeUndefined();
	});
});

describe('buildStreamUrl', () => {
	it('returns URL as-is without auth', () => {
		const station = { url: 'https://stream.example.com/live' };
		expect(buildStreamUrl(station)).toBe('https://stream.example.com/live');
	});

	it('embeds credentials in URL with auth', () => {
		const station = {
			url: 'https://stream.example.com/live',
			auth: { username: 'user', password: 'pass' }
		};
		const result = buildStreamUrl(station);
		expect(result).toBe('https://user:pass@stream.example.com/live');
	});

	it('handles special characters in credentials', () => {
		const station = {
			url: 'https://stream.example.com/live',
			auth: { username: 'user@email.com', password: 'p@ss:word' }
		};
		const result = buildStreamUrl(station);
		expect(result).toContain('stream.example.com');
	});

	it('returns original URL on parse error', () => {
		const station = {
			url: 'not-a-valid-url',
			auth: { username: 'user', password: 'pass' }
		};
		expect(buildStreamUrl(station)).toBe('not-a-valid-url');
	});
});
