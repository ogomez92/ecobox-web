import type { FileEntry, StorageInfo } from '$lib/types';

export type SortField = 'name' | 'duration' | 'lastPlayed' | 'size' | 'modifiedAt';
export type SortDirection = 'asc' | 'desc';

class FilesStore {
	files = $state<FileEntry[]>([]);
	currentPath = $state<string>('');
	isLoading = $state<boolean>(false);
	error = $state<string | null>(null);
	searchQuery = $state<string>('');
	sortField = $state<SortField>('name');
	sortDirection = $state<SortDirection>('asc');
	storage = $state<StorageInfo | null>(null);
	unlocked = $state<boolean>(false);

	get sortedFiles() {
		let filtered = this.files;

		// Apply search filter
		if (this.searchQuery.trim()) {
			const query = this.searchQuery.toLowerCase();
			filtered = filtered.filter(f => f.name.toLowerCase().includes(query));
		}

		// Apply sorting
		return [...filtered].sort((a, b) => {
			// Directories always first
			if (a.isDirectory !== b.isDirectory) {
				return a.isDirectory ? -1 : 1;
			}

			let comparison = 0;
			switch (this.sortField) {
				case 'name':
					comparison = a.name.localeCompare(b.name, undefined, { numeric: true });
					break;
				case 'size':
					comparison = a.size - b.size;
					break;
				case 'modifiedAt':
					comparison = new Date(a.modifiedAt).getTime() - new Date(b.modifiedAt).getTime();
					break;
				case 'duration':
					comparison = (a.duration || 0) - (b.duration || 0);
					break;
				default:
					comparison = 0;
			}

			return this.sortDirection === 'asc' ? comparison : -comparison;
		});
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

	setSort(field: SortField) {
		if (this.sortField === field) {
			this.sortDirection = this.sortDirection === 'asc' ? 'desc' : 'asc';
		} else {
			this.sortField = field;
			this.sortDirection = 'asc';
		}
	}

	setSearch(query: string) {
		this.searchQuery = query;
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
