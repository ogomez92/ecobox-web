import { describe, it, expect, vi } from 'vitest';

// files.ts reads env.MEDIA_ROOT at import time through $env/dynamic/private.
vi.mock('$env/dynamic/private', () => ({ env: { MEDIA_ROOT: '/tmp/ecobox-test-media' } }));

import { chooseAudioTarget } from './videoConvert';

describe('chooseAudioTarget', () => {
	it('copies a codec browsers already play, into its natural container', () => {
		expect(chooseAudioTarget('aac')).toEqual({ extension: '.m4a', copy: true });
		expect(chooseAudioTarget('alac')).toEqual({ extension: '.m4a', copy: true });
		expect(chooseAudioTarget('mp3')).toEqual({ extension: '.mp3', copy: true });
		expect(chooseAudioTarget('flac')).toEqual({ extension: '.flac', copy: true });
		expect(chooseAudioTarget('opus')).toEqual({ extension: '.opus', copy: true });
		expect(chooseAudioTarget('vorbis')).toEqual({ extension: '.ogg', copy: true });
	});

	it('transcodes anything else to AAC', () => {
		// The codecs that actually turn up in video rips and that no browser decodes.
		for (const codec of ['ac3', 'eac3', 'dts', 'truehd', 'pcm_s16le', 'wmav2', 'cook']) {
			expect(chooseAudioTarget(codec)).toEqual({ extension: '.m4a', copy: false });
		}
	});

	it('is case-insensitive and safe on a missing codec name', () => {
		expect(chooseAudioTarget('AAC')).toEqual({ extension: '.m4a', copy: true });
		expect(chooseAudioTarget(undefined)).toEqual({ extension: '.m4a', copy: false });
	});
});
