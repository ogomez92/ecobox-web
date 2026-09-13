/**
 * A short, valid, silent MP3 — the answer for a synthesis unit with nothing to say.
 *
 * Books are full of units that carry no pronounceable content: a paragraph that is
 * just an em-dash or an ellipsis (a scene break), a stray zero-width space left by
 * the converter, a heading stripped down to punctuation. `groupChunks` flushes at
 * every paragraph boundary, so each of those becomes a unit of its own and gets sent
 * to a provider.
 *
 * The instinct is to reject them — HTTP 400, or transcode the engine's empty WAV into
 * what turns out to be a 45-byte MP3 holding an ID3 tag and *zero audio frames*. Both
 * break the reader in the same way: the browser can't decode a frameless MP3, <audio>
 * fires `error`, and the reader reads any failure as "this provider is dead" and
 * silently downgrades the whole session to Web Speech until the book is closed and
 * reopened. One em-dash paragraph would end ELF playback for the rest of the book.
 *
 * Real silence keeps the pipeline uniform instead: the element loads it, fires
 * `ended`, and the reader advances to the next unit as if the sentence had been
 * spoken — leaving a brief pause exactly where the separator was, which is what a
 * scene break should sound like anyway. It caches on disk like any other unit.
 *
 * Generated once per process; the memo is dropped on failure so a transient ffmpeg
 * hiccup isn't remembered forever.
 */
import { spawn } from 'child_process';
import { TtsError } from './errors';

let silentMp3Promise: Promise<Buffer> | null = null;

export function silentMp3(): Promise<Buffer> {
	silentMp3Promise ??= new Promise<Buffer>((resolve, reject) => {
		const child = spawn(
			'ffmpeg',
			// prettier-ignore
			['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=22050:cl=mono',
			 '-t', '0.08', '-f', 'mp3', '-b:a', '64k', 'pipe:1'],
			{ stdio: ['ignore', 'pipe', 'pipe'] }
		);
		const out: Buffer[] = [];
		let errText = '';
		child.stdout.on('data', (c: Buffer) => out.push(c));
		child.stderr.on('data', (c: Buffer) => (errText += c.toString()));
		child.on('error', (e) => reject(new TtsError(500, `cannot run ffmpeg (${e.message})`)));
		child.on('close', (code) => {
			const buf = Buffer.concat(out);
			if (code === 0 && buf.length > 0) resolve(buf);
			else reject(new TtsError(500, errText.trim() || 'silent MP3 generation failed'));
		});
	}).catch((e) => {
		silentMp3Promise = null;
		throw e;
	});
	return silentMp3Promise;
}
