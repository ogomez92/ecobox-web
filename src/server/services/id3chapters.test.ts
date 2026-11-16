import { describe, it, expect, afterAll } from 'vitest';
import { execFileSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { extractID3Chapters } from './id3chapters';

function hasFfmpeg(): boolean {
	try {
		execFileSync('ffmpeg', ['-version'], { stdio: 'ignore' });
		return true;
	} catch {
		return false;
	}
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ecobox-id3-'));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe.skipIf(!hasFfmpeg())('extractID3Chapters', () => {
	it('reads the CHAP frames ffmpeg writes, without the UTF-16 BOM in titles', () => {
		const audio = path.join(dir, 'a.mp3');
		const meta = path.join(dir, 'm.txt');
		const out = path.join(dir, 'out.mp3');
		execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'lavfi', '-i', 'sine=d=3', '-c:a', 'libmp3lame', audio]);
		fs.writeFileSync(
			meta,
			';FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=1500\ntitle=Capítulo uno\n' +
				'[CHAPTER]\nTIMEBASE=1/1000\nSTART=1500\nEND=3000\ntitle=Two\n'
		);
		execFileSync('ffmpeg', [
			'-loglevel', 'error', '-y', '-i', audio, '-i', meta,
			'-map', '0:a', '-map_chapters', '1', '-c', 'copy', '-id3v2_version', '3', out
		]);
		expect(extractID3Chapters(out)).toEqual([
			{ title: 'Capítulo uno', startTime: 0 },
			{ title: 'Two', startTime: 1.5 }
		]);
	});
});
