/**
 * Background queue for the post-upload playability check.
 *
 * The check used to be driven by the upload dialog: after the last byte it POSTed
 * `/api/media/ensure-playable` for each video, one blocking request at a time —
 * about a minute per E-AC-3 episode. Closing the tab after "Upload complete" was
 * heard silently dropped every one of them, leaving a season of videos that play
 * silence. Now the upload route enqueues each video the moment it is on disk, and
 * the server finishes the work whether or not anyone is still watching. The client
 * only polls `getPlayabilityStatus` to announce what happened.
 *
 * Checks run one at a time: a re-encode is CPU-bound ffmpeg, and running sixteen
 * at once would starve playback on the same box. State is in memory only — a
 * restart mid-queue loses the pending entries (the manual ⋮ actions remain).
 */
import { ensureVideoPlayable, type EnsurePlayableResult } from './videoConvert';

export type PlayabilityState = 'queued' | 'running' | 'done';

export interface PlayabilityStatus {
	state: PlayabilityState;
	result?: EnsurePlayableResult;
}

/** Finished results are kept this long so a polling client can still read them. */
const RESULT_TTL_MS = 60 * 60 * 1000;

const statuses = new Map<string, PlayabilityStatus & { finishedAt?: number }>();
const pending: string[] = [];
let running = false;

function pruneFinished(now = Date.now()) {
	for (const [path, status] of statuses) {
		if (status.finishedAt !== undefined && now - status.finishedAt > RESULT_TTL_MS) {
			statuses.delete(path);
		}
	}
}

/**
 * Queue a check for a media-root-relative video path. A path that is already
 * waiting is not queued twice; one that already finished (a re-upload) is
 * checked again, since the bytes may differ.
 */
export function enqueuePlayabilityCheck(relPath: string): void {
	const existing = statuses.get(relPath);
	if (existing && existing.state !== 'done') return;
	statuses.set(relPath, { state: 'queued' });
	pending.push(relPath);
	void drain();
}

async function drain(): Promise<void> {
	if (running) return;
	running = true;
	try {
		let relPath: string | undefined;
		while ((relPath = pending.shift()) !== undefined) {
			statuses.set(relPath, { state: 'running' });
			let result: EnsurePlayableResult;
			try {
				result = await ensureVideoPlayable(relPath);
			} catch (err) {
				console.error('Playability check error:', relPath, err);
				result = { action: 'failed', reason: 'the check could not run' };
			}
			if (result.action !== 'skipped') {
				console.log(
					`Playability check ${result.action}: ${relPath}` +
						(result.audioCodec ? ` (was ${result.audioCodec})` : '') +
						(result.reason ? ` — ${result.reason}` : '')
				);
			}
			statuses.set(relPath, { state: 'done', result, finishedAt: Date.now() });
		}
	} finally {
		running = false;
		pruneFinished();
	}
}

/** Status for one path, or null when it was never queued (or expired). */
export function getPlayabilityStatus(relPath: string): PlayabilityStatus | null {
	const status = statuses.get(relPath);
	if (!status) return null;
	return { state: status.state, result: status.result };
}
