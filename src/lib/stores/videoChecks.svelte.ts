import { t } from '$lib/i18n/index.svelte';

/**
 * Client side of the background post-upload video check.
 *
 * The server queues the check itself as each video finishes uploading
 * (`$server/services/playabilityQueue.ts`), so the work no longer depends on the
 * upload dialog — or the tab — staying open. This store only follows along: the
 * dialog hands it the uploaded video paths, it polls their status, and it
 * announces what happened through the layout's polite live region, which outlives
 * the dialog and survives navigation within the app.
 */

const POLL_MS = 3000;

interface PlayabilityResult {
	action: 'reencoded' | 'extracted' | 'skipped' | 'failed';
	subtitlePaths?: string[];
	reason?: string;
}

interface PlayabilityStatus {
	state: 'queued' | 'running' | 'done';
	result?: PlayabilityResult;
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

class VideoChecksStore {
	/** Text for the layout's polite live region. */
	announcement = $state('');
	/** Bumped whenever a check changed files on disk, so listings can reload. */
	changes = $state(0);

	// path → whether "Checking …" has been said for it yet
	private tracked = new Map<string, boolean>();
	private batchTotal = 0;
	private timer: ReturnType<typeof setTimeout> | null = null;

	/** Start following checks the upload route queued for these paths. */
	track(paths: string[]): void {
		if (paths.length === 0) return;
		for (const path of paths) this.tracked.set(path, false);
		this.batchTotal += paths.length;
		this.announce(
			t(paths.length === 1 ? 'upload.videosQueuedOne' : 'upload.videosQueuedOther', {
				n: paths.length
			})
		);
		this.schedule();
	}

	private announce(message: string) {
		this.announcement = '';
		// Force the live region to re-fire even if the message repeats
		setTimeout(() => {
			this.announcement = message;
		}, 10);
	}

	private schedule() {
		if (this.timer === null) this.timer = setTimeout(() => void this.poll(), POLL_MS);
	}

	private async poll(): Promise<void> {
		this.timer = null;
		const params = new URLSearchParams();
		for (const path of this.tracked.keys()) params.append('path', path);

		let statuses: Record<string, PlayabilityStatus | null>;
		try {
			const res = await fetch(`/api/media/ensure-playable?${params}`);
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			statuses = ((await res.json()) as { statuses: typeof statuses }).statuses ?? {};
		} catch {
			// The server keeps working regardless; just ask again.
			this.schedule();
			return;
		}

		// Several checks can move in one poll; say them all in one announcement
		// rather than letting each overwrite the last.
		const messages: string[] = [];
		for (const [path, announcedRunning] of this.tracked) {
			const status = statuses[path];
			const name = baseName(path);
			if (!status) {
				// Never queued or long expired (e.g. the server restarted): nothing to wait for.
				this.tracked.delete(path);
			} else if (status.state === 'running' && !announcedRunning) {
				this.tracked.set(path, true);
				messages.push(t('upload.checkingVideo', { name }));
			} else if (status.state === 'done') {
				this.tracked.delete(path);
				const message = this.resultMessage(name, status.result);
				if (message) messages.push(message);
				if (status.result?.action === 'reencoded' || status.result?.action === 'extracted') {
					this.changes++;
				}
			}
		}

		if (this.tracked.size === 0) {
			messages.push(
				t(this.batchTotal === 1 ? 'upload.videoChecksDoneOne' : 'upload.videoChecksDoneOther', {
					n: this.batchTotal
				})
			);
			this.batchTotal = 0;
		} else {
			this.schedule();
		}
		if (messages.length > 0) this.announce(messages.join('. '));
	}

	private resultMessage(name: string, result: PlayabilityResult | undefined): string | null {
		switch (result?.action) {
			case 'reencoded':
				return t('upload.reencoded', { name });
			case 'extracted': {
				const n = result.subtitlePaths?.length ?? 0;
				return n > 0 ? t('upload.extractedWithSubtitles', { name, n }) : t('upload.extracted', { name });
			}
			case 'failed': {
				const base = t('upload.convertVideoFailed', { name });
				return result.reason ? `${base} — ${result.reason}` : base;
			}
			default:
				// 'skipped' is the common, happy case: the file already plays. Saying
				// so for every video would bury the announcements that matter.
				return null;
		}
	}
}

export const videoChecksStore = new VideoChecksStore();
