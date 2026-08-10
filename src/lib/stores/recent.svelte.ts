import type { RecentEntry, RecentKind } from '$lib/types';

/**
 * Client side of the Recent tab.
 *
 * `load()` is called every time the tab is activated, because the list changes
 * behind the user's back (playing a file elsewhere in the app reorders it, and a
 * deletion changes where an entry points). `record()` is fire-and-forget on
 * purpose: it is called from the player and the reader while they are opening
 * media, and bookkeeping must never surface an error there.
 */
class RecentStore {
	entries = $state<RecentEntry[]>([]);
	isLoading = $state(false);
	error = $state<string | null>(null);
	/** True once a load has completed at least once (so "empty" isn't shown too early). */
	loaded = $state(false);

	// Guards against a slow earlier request overwriting a newer one's results.
	private seq = 0;

	async load(): Promise<void> {
		const seq = ++this.seq;
		this.isLoading = true;
		this.error = null;
		try {
			const res = await fetch('/api/recent');
			if (!res.ok) throw new Error(`HTTP ${res.status}`);
			const data = (await res.json()) as { recent: RecentEntry[] };
			if (seq !== this.seq) return;
			this.entries = data.recent ?? [];
			this.loaded = true;
		} catch (err) {
			if (seq !== this.seq) return;
			this.error = (err as Error).message;
			this.entries = [];
			this.loaded = true;
		} finally {
			if (seq === this.seq) this.isLoading = false;
		}
	}

	/** Record an opened media path. Never throws, never blocks the caller. */
	record(path: string, kind: RecentKind): void {
		if (!path) return;
		fetch('/api/recent', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({ path, kind })
		}).catch(() => {
			// Opening media must not fail because the recent list didn't update.
		});
	}
}

export const recentStore = new RecentStore();
