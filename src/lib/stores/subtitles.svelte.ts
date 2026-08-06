import type { SubtitleCue } from '$lib/types';

/**
 * Sidecar subtitles for whatever file the player currently has loaded.
 *
 * The whole track is fetched once per file (a .srt is a few dozen KB at most),
 * so looking up "what line is showing now" is a binary search in memory rather
 * than a request per tick. Cues are file-relative, so a chaptered/DAISY book
 * simply reloads the track whenever playback moves to another file.
 */
class SubtitlesStore {
	cues = $state<SubtitleCue[]>([]);
	/** Path of the .srt behind `cues`, relative to MEDIA_ROOT. */
	sourcePath = $state<string | null>(null);

	// The media path `cues` belongs to, and a token so a slow response for the
	// previous file can never overwrite the current one.
	private loadedFor: string | null = null;
	private requestId = 0;

	get available(): boolean {
		return this.cues.length > 0;
	}

	async load(mediaPath: string) {
		if (this.loadedFor === mediaPath) return;
		this.loadedFor = mediaPath;

		const id = ++this.requestId;
		this.cues = [];
		this.sourcePath = null;

		try {
			const response = await fetch(`/api/media/subtitles?path=${encodeURIComponent(mediaPath)}`);
			if (!response.ok) return;
			const data = await response.json();
			if (id !== this.requestId) return; // another file won the race
			this.cues = data.cues ?? [];
			this.sourcePath = data.path ?? null;
		} catch {
			// Having no subtitles is the normal case — never surface it as an error.
		}
	}

	clear() {
		this.requestId++;
		this.loadedFor = null;
		this.cues = [];
		this.sourcePath = null;
	}

	/**
	 * The cue covering `time`, or null in the gaps between cues. Where cues
	 * overlap — common in dubbed tracks — the one that started last wins.
	 */
	cueAt(time: number): SubtitleCue | null {
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
		return time <= cue.end ? cue : null;
	}
}

export const subtitlesStore = new SubtitlesStore();
