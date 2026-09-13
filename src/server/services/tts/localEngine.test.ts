import { describe, it, expect } from 'vitest';
import { wavSampleBytes } from './localEngine';

/**
 * Builds a RIFF/WAVE buffer with the given chunks, so the "empty synthesis" shape can
 * be asserted without spawning an engine.
 */
function wav(chunks: Array<[string, Buffer]>): Buffer {
	const body = Buffer.concat(
		chunks.map(([id, data]) => {
			const header = Buffer.alloc(8);
			header.write(id, 0, 'latin1');
			header.writeUInt32LE(data.length, 4);
			const pad = data.length % 2 ? Buffer.alloc(1) : Buffer.alloc(0);
			return Buffer.concat([header, data, pad]);
		})
	);
	const head = Buffer.alloc(12);
	head.write('RIFF', 0, 'latin1');
	head.writeUInt32LE(4 + body.length, 4);
	head.write('WAVE', 8, 'latin1');
	return Buffer.concat([head, body]);
}

const FMT: [string, Buffer] = ['fmt ', Buffer.alloc(16)];

describe('wavSampleBytes', () => {
	it('reports the data chunk length', () => {
		expect(wavSampleBytes(wav([FMT, ['data', Buffer.alloc(2048)]]))).toBe(2048);
	});

	// The case that matters: ECI answers unpronounceable text ("—", "…", a zero-width
	// space) with exit 0 and a well-formed, empty 44-byte WAV.
	it('reports 0 for the engine’s empty 44-byte WAV', () => {
		const empty = wav([FMT, ['data', Buffer.alloc(0)]]);
		expect(empty.length).toBe(44);
		expect(wavSampleBytes(empty)).toBe(0);
	});

	it('skips chunks that precede data', () => {
		expect(wavSampleBytes(wav([FMT, ['LIST', Buffer.alloc(9)], ['data', Buffer.alloc(64)]]))).toBe(64);
	});

	it('trusts the buffer over a data size that overruns it', () => {
		const b = wav([FMT, ['data', Buffer.alloc(100)]]);
		b.writeUInt32LE(1_000_000, b.length - 100 - 4);
		expect(wavSampleBytes(b)).toBe(100);
	});

	it('returns 0 for empty, truncated and non-RIFF input', () => {
		expect(wavSampleBytes(Buffer.alloc(0))).toBe(0);
		expect(wavSampleBytes(Buffer.from('RIFF', 'latin1'))).toBe(0);
		expect(wavSampleBytes(Buffer.from('not audio at all', 'latin1'))).toBe(0);
		expect(wavSampleBytes(wav([FMT]))).toBe(0); // no data chunk
	});
});
