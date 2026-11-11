import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';

const mockEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>);
vi.mock('$env/dynamic/private', () => ({ env: mockEnv }));

import {
	looksLikeSafetensors,
	isValidStem,
	phononVoices,
	savePhononVoice,
	listPhononCustomVoices,
	deletePhononVoice
} from './phonon';

/** A minimal valid safetensors buffer: u64 LE header length + JSON header + data. */
function safetensors(header: object = { speaker_wavs: { dtype: 'F32', shape: [1], data_offsets: [0, 4] } }) {
	const json = Buffer.from(JSON.stringify(header));
	const len = Buffer.alloc(8);
	len.writeBigUInt64LE(BigInt(json.length));
	return Buffer.concat([len, json, Buffer.alloc(4)]);
}

describe('looksLikeSafetensors', () => {
	it('accepts a well-formed header', () => {
		expect(looksLikeSafetensors(safetensors())).toBe(true);
	});
	it('rejects junk, truncation and absurd header lengths', () => {
		expect(looksLikeSafetensors(Buffer.from('junk\n'))).toBe(false);
		expect(looksLikeSafetensors(safetensors().subarray(0, 20))).toBe(false);
		const huge = Buffer.alloc(32);
		huge.writeBigUInt64LE(BigInt(1e12));
		expect(looksLikeSafetensors(huge)).toBe(false);
	});
	it('rejects a header that is not JSON', () => {
		const b = safetensors();
		b.write('}', 8);
		expect(looksLikeSafetensors(b)).toBe(false);
	});
});

describe('isValidStem', () => {
	it('allows bare file names only', () => {
		expect(isValidStem('oriol')).toBe(true);
		expect(isValidStem('my-voice_2.v1')).toBe(true);
		expect(isValidStem('')).toBe(false);
		expect(isValidStem('../x')).toBe(false);
		expect(isValidStem('a/b')).toBe(false);
		expect(isValidStem('a..b')).toBe(false);
		expect(isValidStem('mi voz')).toBe(false);
	});
});

describe('voice listing', () => {
	let root: string;
	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), 'phonon-test-'));
		mockEnv.PHONON_DIR = path.join(root, 'engine');
		mockEnv.PHONON_VOICES_DIR = path.join(root, 'voices');
		mockEnv.PHONON_MULTILINGUAL_DIR = path.join(root, 'multi');
		delete mockEnv.HF_TOKEN;
	});
	afterEach(async () => {
		await fs.rm(root, { recursive: true, force: true });
	});

	it('lists only English catalog voices without the multilingual model', async () => {
		const voices = await phononVoices();
		expect(voices).toHaveLength(8);
		expect(voices.every((v) => v.lang.startsWith('en-'))).toBe(true);
	});

	it('lists two female and two male voices per locale once the model is installed', async () => {
		await fs.mkdir(mockEnv.PHONON_MULTILINGUAL_DIR!, { recursive: true });
		await fs.writeFile(path.join(mockEnv.PHONON_MULTILINGUAL_DIR!, 'config.json'), '{}');
		await fs.writeFile(path.join(mockEnv.PHONON_MULTILINGUAL_DIR!, 'model.safetensors'), '');
		const voices = await phononVoices();
		expect(voices).toHaveLength(28);
		const byLocale = new Map<string, string[]>();
		for (const v of voices) byLocale.set(v.lang, [...(byLocale.get(v.lang) ?? []), v.name]);
		expect([...byLocale.keys()].sort()).toEqual(
			['de-DE', 'en-GB', 'en-US', 'es-ES', 'es-MX', 'fr-FR', 'pt-BR'].sort()
		);
		for (const names of byLocale.values()) {
			expect(names.filter((n) => n.endsWith('female'))).toHaveLength(2);
			expect(names.filter((n) => n.endsWith(', male'))).toHaveLength(2);
		}
	});

	it('round-trips an uploaded voice through save, list and delete', async () => {
		await savePhononVoice('oriol', safetensors(), { name: 'Oriol', lang: 'es' });
		const rows = await listPhononCustomVoices();
		expect(rows).toMatchObject([{ stem: 'oriol', name: 'Oriol', lang: 'es' }]);
		const listed = (await phononVoices()).find((v) => v.id === 'custom:oriol');
		expect(listed).toMatchObject({ name: 'Oriol — Spanish, uploaded', lang: 'es' });
		await deletePhononVoice('oriol');
		expect(await listPhononCustomVoices()).toEqual([]);
	});

	it('refuses to save under an unsafe name', async () => {
		await expect(savePhononVoice('../evil', safetensors(), { name: 'x', lang: 'en' })).rejects.toThrow();
	});
});
