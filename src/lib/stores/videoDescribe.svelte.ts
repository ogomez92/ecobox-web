/**
 * Marks and descriptions for the video description feature.
 *
 * The player marks a start (`d`) and an end (`Shift+D`) on the current video, then
 * asks the server to describe what happens between them (`Ctrl+Shift+D`). This
 * store owns that little state machine so `PlaybackView` only has to bind buttons
 * and shortcuts to it.
 *
 * Two rules shape it. Marks belong to *one file*: `resetFor()` drops them the
 * moment playback moves to another track, because a mark at 3:20 means nothing in
 * the next episode. And every failure ends up as a `DescribeErrorCode`, never a
 * server-worded string — the view translates it, so the same message reaches a
 * screen reader in the user's own language.
 */
import type { DescribeErrorCode, DescribeKeyStatus, DescribeResult } from '$lib/types';

class VideoDescribeStore {
	/** Seconds into the current file, or null when unmarked. */
	startMark = $state<number | null>(null);
	endMark = $state<number | null>(null);

	/** A request is in flight; the button is disabled and the status region says so. */
	isDescribing = $state(false);
	/** The last description received, '' when there is none to show. */
	description = $state('');
	/** The segment `description` covers, for the heading above it. */
	describedStart = $state<number | null>(null);
	describedEnd = $state<number | null>(null);

	errorCode = $state<DescribeErrorCode | null>(null);
	/** Server-supplied technical detail, shown alongside the translated message. */
	errorDetail = $state<string | null>(null);

	/** Whether the server has an Anthropic key. null until it has been asked. */
	keyStatus = $state<DescribeKeyStatus | null>(null);

	/** Which file the current marks belong to. */
	private markedFile: string | null = null;
	private inFlight: AbortController | null = null;

	get hasStart(): boolean {
		return this.startMark !== null;
	}

	get hasEnd(): boolean {
		return this.endMark !== null;
	}

	/** A complete, forward-running segment — the only state `describe()` will send. */
	get hasSegment(): boolean {
		return this.startMark !== null && this.endMark !== null && this.endMark > this.startMark;
	}

	/**
	 * Point the store at `file`. Marks and results survive re-entering the same
	 * file (a re-render must not lose them) and are dropped for a different one.
	 */
	resetFor(file: string | null) {
		if (file === this.markedFile) return;
		this.markedFile = file;
		this.clear();
	}

	/** Forget marks, description and error alike. */
	clear() {
		this.startMark = null;
		this.endMark = null;
		this.description = '';
		this.describedStart = null;
		this.describedEnd = null;
		this.errorCode = null;
		this.errorDetail = null;
	}

	markStart(time: number) {
		this.startMark = Math.max(0, time);
		this.errorCode = null;
		this.errorDetail = null;
		// A start after the existing end would leave an inverted segment behind.
		if (this.endMark !== null && this.endMark <= this.startMark) this.endMark = null;
	}

	markEnd(time: number) {
		this.endMark = Math.max(0, time);
		this.errorCode = null;
		this.errorDetail = null;
	}

	/**
	 * What is wrong with the current marks, or null when they describe a real
	 * segment. Public because the view checks it *before* offering the key dialog:
	 * asking for an API key to describe an unmarked segment would be nonsense.
	 */
	markError(): DescribeErrorCode | null {
		if (this.startMark === null) return 'noStart';
		if (this.endMark === null) return 'noEnd';
		if (this.endMark <= this.startMark) return 'badRange';
		return null;
	}

	/** Surface a failure the view detected itself (an unmarked segment, say). */
	reportError(code: DescribeErrorCode, detail?: string) {
		this.fail(code, detail);
	}

	private fail(code: DescribeErrorCode, detail?: string) {
		this.errorCode = code;
		this.errorDetail = detail ?? null;
	}

	/** Ask the server whether a key exists. Cheap, and only the status comes back. */
	async loadKeyStatus(): Promise<DescribeKeyStatus> {
		try {
			const response = await fetch('/api/describe/key');
			if (response.ok) {
				this.keyStatus = (await response.json()) as DescribeKeyStatus;
				return this.keyStatus;
			}
		} catch {
			// Treat an unreachable status as "not configured": the dialog is the
			// recoverable path, and a wrong "configured" would hide it.
		}
		this.keyStatus = { configured: false, source: null };
		return this.keyStatus;
	}

	/**
	 * Store a key server-side. Returns a machine code on refusal (`malformed` for a
	 * paste that is not an `sk-ant-…` key) so the dialog can localize it.
	 */
	async saveKey(apiKey: string): Promise<{ ok: boolean; code?: string }> {
		try {
			const response = await fetch('/api/describe/key', {
				method: 'PUT',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ apiKey })
			});
			const data = (await response.json().catch(() => null)) as
				| { ok?: boolean; code?: string; configured?: boolean; source?: DescribeKeyStatus['source'] }
				| null;
			if (response.ok && data?.ok) {
				this.keyStatus = {
					configured: !!data.configured,
					source: data.source ?? 'stored'
				};
				return { ok: true };
			}
			return { ok: false, code: data?.code ?? 'saveFailed' };
		} catch {
			return { ok: false, code: 'saveFailed' };
		}
	}

	/**
	 * Describe the marked segment of `file`. Resolves to true when a description
	 * arrived; on failure `errorCode` says why (and `noKey`/`badKey` are the view's
	 * cue to open the key dialog).
	 */
	async describe(file: string, language: string): Promise<boolean> {
		if (this.isDescribing) return false;

		// Local validation first: these never need a round trip, and the user gets
		// the answer while their finger is still on the key.
		const problem = this.markError();
		if (problem) {
			this.fail(problem);
			return false;
		}

		const start = this.startMark as number;
		const end = this.endMark as number;

		this.isDescribing = true;
		this.errorCode = null;
		this.errorDetail = null;
		const controller = new AbortController();
		this.inFlight = controller;

		try {
			const response = await fetch('/api/describe', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path: file, start, end, language }),
				signal: controller.signal
			});

			const data = (await response.json().catch(() => null)) as DescribeResult | null;

			if (data && data.ok) {
				this.description = data.description;
				this.describedStart = data.start;
				this.describedEnd = data.end;
				return true;
			}

			if (data && data.ok === false) {
				this.fail(data.code, data.detail);
			} else if (response.status === 401) {
				// The app password gate answers 401 with its own body shape.
				this.fail('noKey');
			} else if (response.status === 403) {
				this.fail('notFound');
			} else {
				this.fail('server', `HTTP ${response.status}`);
			}
			return false;
		} catch (err) {
			if ((err as Error)?.name === 'AbortError') return false;
			this.fail('network');
			return false;
		} finally {
			if (this.inFlight === controller) this.inFlight = null;
			this.isDescribing = false;
		}
	}

	/** Drop an in-flight request (leaving the player). */
	cancel() {
		this.inFlight?.abort();
		this.inFlight = null;
		this.isDescribing = false;
	}
}

export const videoDescribeStore = new VideoDescribeStore();
