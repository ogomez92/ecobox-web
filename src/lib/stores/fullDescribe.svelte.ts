/**
 * The whole-video description track for whatever video the player has loaded.
 *
 * Shape and behaviour follow `subtitles.svelte.ts`: the cues are timed on the
 * file's own clock, the whole track lives in memory, and "what is being
 * described now" is a binary search per tick. What is different is that the
 * track may still be *being written* — the server produces it chunk by chunk in
 * the background — so while a run is going this store polls for progress and the
 * cues done so far, and the player can already play them back.
 *
 * Whether the track is spoken during playback is a per-device preference
 * (`localStorage`), like the seek unit: it is a choice about this listener's
 * screen reader, not about the library.
 */
import type {
	DescribeErrorCode,
	DescribeFailure,
	FullDescribeCue,
	FullDescribeEstimate,
	FullDescribeState,
	FullDescribeStatus
} from '$lib/types';

const ENABLED_KEY = 'ecobox-descriptions-enabled';
/** How often progress is fetched while a run is going. A chunk takes a few seconds. */
const POLL_MS = 4000;

class FullDescribeStore {
	state = $state<FullDescribeState>('idle');
	cues = $state<FullDescribeCue[]>([]);
	totalChunks = $state(0);
	doneChunks = $state(0);
	model = $state<string | null>(null);
	/** Where the track is saved next to the video, once it exists. */
	sidecar = $state<string | null>(null);
	errorCode = $state<DescribeErrorCode | null>(null);
	errorDetail = $state<string | null>(null);
	/** A start/cancel request is in flight. */
	isBusy = $state(false);
	/** Whether cues are shown and announced during playback (per device). */
	enabled = $state(true);

	private loadedFor: string | null = null;
	private requestId = 0;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;

	constructor() {
		try {
			const saved = localStorage.getItem(ENABLED_KEY);
			if (saved !== null) this.enabled = saved !== '0';
		} catch {
			// SSR or blocked storage: the default stands.
		}
	}

	get available(): boolean {
		return this.cues.length > 0;
	}

	get isRunning(): boolean {
		return this.state === 'running';
	}

	/** Chunks done as a share of the whole, for the progress bar. */
	get progress(): number {
		return this.totalChunks > 0 ? this.doneChunks / this.totalChunks : 0;
	}

	setEnabled(value: boolean) {
		this.enabled = value;
		try {
			localStorage.setItem(ENABLED_KEY, value ? '1' : '0');
		} catch {
			// Ignore storage errors
		}
	}

	/** Point the store at `mediaPath`, fetching its track; a repeat is a no-op. */
	async load(mediaPath: string) {
		if (this.loadedFor === mediaPath) return;
		this.clear();
		this.loadedFor = mediaPath;
		await this.refresh();
	}

	clear() {
		this.requestId++;
		this.stopPolling();
		this.loadedFor = null;
		this.state = 'idle';
		this.cues = [];
		this.totalChunks = 0;
		this.doneChunks = 0;
		this.model = null;
		this.sidecar = null;
		this.errorCode = null;
		this.errorDetail = null;
	}

	/** Fetch the current status; keeps polling while the server is still working. */
	async refresh(): Promise<void> {
		const file = this.loadedFor;
		if (!file) return;
		const id = ++this.requestId;
		try {
			const response = await fetch(`/api/describe/full?path=${encodeURIComponent(file)}`);
			if (id !== this.requestId) return;
			if (response.ok) this.apply((await response.json()) as FullDescribeStatus);
		} catch {
			// A missed poll is not an error; the next one will catch up.
		}
		if (id !== this.requestId) return;
		if (this.state === 'running') this.schedulePoll();
		else this.stopPolling();
	}

	/**
	 * Start (or resume) describing the whole file. Resolves to true when the run is
	 * going or already finished; otherwise `errorCode` says why it could not begin.
	 */
	async start(language: string, restart = false): Promise<boolean> {
		return this.post(restart ? 'restart' : 'start', language);
	}

	/** Stop the run, keeping the chunks done so far. */
	async cancel(): Promise<boolean> {
		return this.post('cancel');
	}

	/**
	 * What a run would cost, for the confirmation dialog. Null when the server
	 * could not say; the dialog then shows the job size without a price.
	 */
	async estimate(language: string): Promise<FullDescribeEstimate | null> {
		const file = this.loadedFor;
		if (!file) return null;
		try {
			const response = await fetch(
				`/api/describe/full/estimate?path=${encodeURIComponent(file)}&language=${encodeURIComponent(language)}`
			);
			if (!response.ok) return null;
			const data = (await response.json()) as FullDescribeEstimate;
			return typeof data?.inputTokens === 'number' ? data : null;
		} catch {
			return null;
		}
	}

	/** Forget the track on the server and here. */
	async remove(): Promise<void> {
		const file = this.loadedFor;
		if (!file || this.isBusy) return;
		this.isBusy = true;
		try {
			await fetch(`/api/describe/full?path=${encodeURIComponent(file)}`, { method: 'DELETE' });
		} catch {
			// Best effort; the next load tells the truth either way.
		} finally {
			this.isBusy = false;
		}
		const keep = this.loadedFor;
		this.clear();
		this.loadedFor = keep;
	}

	private async post(action: 'start' | 'restart' | 'cancel', language?: string): Promise<boolean> {
		const file = this.loadedFor;
		if (!file || this.isBusy) return false;
		this.isBusy = true;
		this.errorCode = null;
		this.errorDetail = null;
		const id = ++this.requestId;
		try {
			const response = await fetch('/api/describe/full', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: file, language, action })
			});
			const data = (await response.json().catch(() => null)) as
				| FullDescribeStatus
				| DescribeFailure
				| null;
			if (id !== this.requestId) return false;
			if (data && 'state' in data) {
				this.apply(data);
				if (this.state === 'running') this.schedulePoll();
				else this.stopPolling();
				return true;
			}
			if (data && 'ok' in data && data.ok === false) {
				this.fail(data.code, data.detail);
			} else if (response.status === 401) {
				this.fail('noKey');
			} else if (response.status === 403) {
				this.fail('notFound');
			} else {
				this.fail('server', `HTTP ${response.status}`);
			}
			return false;
		} catch {
			if (id === this.requestId) this.fail('network');
			return false;
		} finally {
			this.isBusy = false;
		}
	}

	private apply(status: FullDescribeStatus) {
		this.state = status.state;
		this.cues = status.cues ?? [];
		this.totalChunks = status.totalChunks;
		this.doneChunks = status.doneChunks;
		this.model = status.model;
		this.sidecar = status.sidecar ?? null;
		this.errorCode = status.errorCode;
		this.errorDetail = status.errorDetail;
	}

	private fail(code: DescribeErrorCode, detail?: string) {
		this.errorCode = code;
		this.errorDetail = detail ?? null;
	}

	private schedulePoll() {
		this.stopPolling();
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			void this.refresh();
		}, POLL_MS);
	}

	private stopPolling() {
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/**
	 * The cue covering `time`, or null between cues and for chunks whose
	 * description was empty (nothing changed on screen).
	 */
	cueAt(time: number): FullDescribeCue | null {
		const cues = this.cues;
		if (cues.length === 0) return null;
		let low = 0;
		let high = cues.length - 1;
		let candidate = -1;
		while (low <= high) {
			const mid = (low + high) >> 1;
			if (cues[mid].start <= time) {
				candidate = mid;
				low = mid + 1;
			} else {
				high = mid - 1;
			}
		}
		if (candidate < 0) return null;
		const cue = cues[candidate];
		return time < cue.end && cue.text ? cue : null;
	}
}

export const fullDescribeStore = new FullDescribeStore();
