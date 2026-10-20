import type { FileEntry, StorageInfo } from '$lib/types';
import { isPlayableMedia } from '$lib/utils/mediaTypes';
import {
	DEFAULT_DIRECTION,
	SORT_FIELDS,
	sortEntries,
	type SortDirection,
	type SortField
} from '$lib/utils/fileSort';

export type { SortDirection, SortField };

/** The sort choice is a per-device preference, like the player's seek unit. */
const SORT_STORAGE_KEY = 'ecobox-file-sort';

function loadSavedSort(): { field: SortField; direction: SortDirection } | null {
	try {
		if (typeof localStorage === 'undefined') return null;
		const raw = localStorage.getItem(SORT_STORAGE_KEY);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as { field?: unknown; direction?: unknown };
		if (!(SORT_FIELDS as readonly string[]).includes(parsed.field as string)) return null;
		const direction = parsed.direction === 'desc' ? 'desc' : 'asc';
		return { field: parsed.field as SortField, direction };
	} catch {
		return null;
	}
}

class FilesStore {
	files = $state<FileEntry[]>([]);
	currentPath = $state<string>('');
	isLoading = $state<boolean>(false);
	error = $state<string | null>(null);
	sortField = $state<SortField>('name');
	sortDirection = $state<SortDirection>('asc');
	/** True while `/api/files/durations` is computing the current folder's durations. */
	durationsLoading = $state<boolean>(false);
	/** True when the last durations request for this folder failed. */
	durationsFailed = $state<boolean>(false);
	storage = $state<StorageInfo | null>(null);
	unlocked = $state<boolean>(false);
	private durationsRequest: Promise<boolean> | null = null;

	constructor() {
		const saved = loadSavedSort();
		if (saved) {
			this.sortField = saved.field;
			this.sortDirection = saved.direction;
		}
	}

	get sortedFiles() {
		// Sorted view of the folder as listed. Searching is a separate, recursive
		// concern (the Ctrl+F dialog / /api/search) and never filters this list.
		return sortEntries(this.files, this.sortField, this.sortDirection);
	}

	/** Playable files in this folder whose duration the listing didn't know. */
	get missingDurationCount(): number {
		return this.files.filter(
			(f) => !f.isDirectory && isPlayableMedia(f.name) && f.duration === undefined
		).length;
	}

	get breadcrumbs() {
		if (!this.currentPath) return [{ name: 'Home', path: '' }];

		const parts = this.currentPath.split('/').filter(Boolean);
		const crumbs = [{ name: 'Home', path: '' }];

		let currentPath = '';
		for (const part of parts) {
			currentPath += (currentPath ? '/' : '') + part;
			crumbs.push({ name: part, path: currentPath });
		}

		return crumbs;
	}

	async loadFiles(path: string = '') {
		this.isLoading = true;
		this.error = null;
		this.currentPath = path;

		try {
			const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`);
			if (!response.ok) {
				throw new Error('Failed to load files');
			}
			const data = await response.json();
			this.files = data.files;
			this.unlocked = data.unlocked;
		} catch (err) {
			this.error = (err as Error).message;
			this.files = [];
		} finally {
			this.isLoading = false;
		}
		// A folder opened while sorted by duration should end up actually sorted
		// by duration, not by whichever files happened to be cached.
		if (this.sortField === 'duration') void this.ensureDurations();
	}

	/**
	 * Fill in the durations the listing didn't have, so the "duration" sort is
	 * complete. Only this folder's own files are measured — never subfolders —
	 * and the server caches each answer, so a folder costs its parse once.
	 * Resolves to true when every file got an answer, false on failure. Calls
	 * while a request is in flight share it; a request for a folder the user
	 * has since left is discarded.
	 */
	ensureDurations(): Promise<boolean> {
		if (this.missingDurationCount === 0) return Promise.resolve(true);
		if (this.durationsRequest) return this.durationsRequest;

		const path = this.currentPath;
		this.durationsLoading = true;
		this.durationsFailed = false;
		this.durationsRequest = (async () => {
			let ok = false;
			try {
				const response = await fetch(`/api/files/durations?path=${encodeURIComponent(path)}`);
				if (!response.ok) return false;
				const data = (await response.json()) as { durations: Record<string, number> };
				if (this.currentPath !== path) return false;
				this.files = this.files.map((f) =>
					f.duration === undefined && data.durations[f.path] !== undefined
						? { ...f, duration: data.durations[f.path] }
						: f
				);
				ok = true;
				return true;
			} catch {
				return false;
			} finally {
				this.durationsFailed = !ok;
				this.durationsLoading = false;
				this.durationsRequest = null;
			}
		})();
		return this.durationsRequest;
	}

	async loadStorage() {
		try {
			const response = await fetch('/api/storage');
			if (response.ok) {
				this.storage = await response.json();
			}
		} catch {
			// Ignore storage errors
		}
	}

	async deleteFile(path: string) {
		try {
			const response = await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
				method: 'DELETE'
			});
			if (!response.ok) {
				throw new Error('Failed to delete file');
			}
			// Reload files
			await this.loadFiles(this.currentPath);
			await this.loadStorage();
		} catch (err) {
			this.error = (err as Error).message;
		}
	}

	/**
	 * Choose a sort field. Choosing the current field again flips the direction
	 * (the column-header convention); a new field starts in its natural direction
	 * (`DEFAULT_DIRECTION`). `toggle: false` selects without ever flipping, for
	 * controls where re-selecting the same option means "keep it" (the sort bar's
	 * radios).
	 */
	setSort(field: SortField, options: { toggle?: boolean } = {}) {
		const toggle = options.toggle ?? true;
		if (this.sortField === field) {
			if (toggle) this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			this.sortField = field;
			this.sortDirection = DEFAULT_DIRECTION[field];
		}
		this.persistSort();
		if (field === 'duration') void this.ensureDurations();
	}

	toggleSortDirection() {
		this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
		this.persistSort();
	}

	private persistSort() {
		try {
			localStorage.setItem(
				SORT_STORAGE_KEY,
				JSON.stringify({ field: this.sortField, direction: this.sortDirection })
			);
		} catch {
			// Private mode / blocked storage: the choice simply lasts for this page.
		}
	}

	async toggleProtection(path: string) {
		try {
			const response = await fetch('/api/protect', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path })
			});
			if (!response.ok) {
				throw new Error('Failed to toggle protection');
			}
			// Reload files to reflect changes
			await this.loadFiles(this.currentPath);
		} catch (err) {
			this.error = (err as Error).message;
		}
	}
}

export const filesStore = new FilesStore();
