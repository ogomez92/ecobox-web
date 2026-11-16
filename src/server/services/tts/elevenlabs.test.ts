import { describe, it, expect, vi, afterEach } from 'vitest';
import { elevenSynthesize } from './elevenlabs';

function respond(status: number, body: string) {
	vi.stubGlobal('fetch', vi.fn(async () => new Response(body, { status })));
}

afterEach(() => vi.unstubAllGlobals());

describe('elevenSynthesize errors', () => {
	const call = () => elevenSynthesize({ apiKey: 'k', voiceId: 'v', text: 'Hi' });

	it('tells an exhausted quota apart from a bad key (both arrive as 401)', async () => {
		respond(401, JSON.stringify({ detail: { status: 'quota_exceeded', message: 'You have 3 credits left' } }));
		await expect(call()).rejects.toMatchObject({ status: 402 });
		respond(401, JSON.stringify({ detail: { status: 'invalid_api_key' } }));
		await expect(call()).rejects.toMatchObject({ status: 401 });
	});

	it('keeps a rate limit retryable', async () => {
		respond(429, '{}');
		await expect(call()).rejects.toMatchObject({ status: 429 });
	});
});
