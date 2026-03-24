import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { env } from '$env/dynamic/private';
import type { FileEntry, StorageInfo } from '$lib/types';
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.wav', '.flac'];
const DAISY_MARKERS = ['ncc.html', 'ncc.xml', 'Navigation.xml'];
const CHAPTERED_MARKER = '.CHAPTERED';
const RADIO_EXTENSION = '.radio';

export function getMediaRoot(): string {
	return env.MEDIA_ROOT || './media';
}

export function resolvePath(relativePath: string): string {
	const mediaRoot = getMediaRoot();
	const resolved = path.resolve(mediaRoot, relativePath);

	// Security: ensure the resolved path is within media root
	if (!resolved.startsWith(path.resolve(mediaRoot))) {
		throw new Error('Invalid path: directory traversal attempt');
	}

	return resolved;
}

export function getRelativePath(absolutePath: string): string {
	const mediaRoot = getMediaRoot();
	return path.relative(mediaRoot, absolutePath);
}

export async function listDirectory(relativePath: string = ''): Promise<FileEntry[]> {
	const dirPath = resolvePath(relativePath);

	try {
		const entries = await fs.readdir(dirPath, { withFileTypes: true });
		const files: FileEntry[] = [];

		for (const entry of entries) {
			// Skip hidden files
			if (entry.name.startsWith('.') && entry.name !== CHAPTERED_MARKER) {
				continue;
			}

			const entryPath = path.join(dirPath, entry.name);
			let stats;
			try {
				stats = await fs.stat(entryPath);
			} catch {
				// Skip broken symlinks or inaccessible entries
				continue;
			}
			const fileRelPath = path.join(relativePath, entry.name);

			const fileEntry: FileEntry = {
				name: entry.name,
				path: fileRelPath,
				isDirectory: stats.isDirectory(),
				size: stats.size,
				modifiedAt: stats.mtime
			};

			if (entry.isDirectory()) {
				// Check for DAISY book
				fileEntry.isDaisyBook = await isDaisyBook(entryPath);
				// Check for chaptered folder
				fileEntry.isChapteredFolder = await isChapteredFolder(entryPath);
			} else {
				// Check for radio file
				if (entry.name.endsWith(RADIO_EXTENSION)) {
					fileEntry.isRadioFile = true;
				}
			}

			files.push(fileEntry);
		}

		return files;
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new Error('Directory not found');
		}
		throw error;
	}
}

export async function listDirectoryRecursive(relativePath: string = ''): Promise<FileEntry[]> {
	const files: FileEntry[] = [];

	async function recurse(currentPath: string): Promise<void> {
		const entries = await listDirectory(currentPath);

		for (const entry of entries) {
			files.push(entry);

			if (entry.isDirectory && !entry.isDaisyBook && !entry.isChapteredFolder) {
				await recurse(entry.path);
			}
		}
	}

	await recurse(relativePath);
	return files;
}

export async function isDaisyBook(dirPath: string): Promise<boolean> {
	try {
		const entries = await fs.readdir(dirPath);
		return entries.some(name =>
			DAISY_MARKERS.includes(name.toLowerCase()) ||
			DAISY_MARKERS.includes(name)
		);
	} catch {
		return false;
	}
}

export async function isChapteredFolder(dirPath: string): Promise<boolean> {
	try {
		await fs.access(path.join(dirPath, CHAPTERED_MARKER));
		return true;
	} catch {
		return false;
	}
}

export async function getStorageInfo(): Promise<StorageInfo> {
	const mediaRoot = getMediaRoot();

	// Ensure media root exists
	await fs.mkdir(mediaRoot, { recursive: true });

	// Get disk space info (platform-specific)
	const stats = fsSync.statfsSync(mediaRoot);
	const blockSize = stats.bsize;
	const total = stats.blocks * blockSize;
	const free = stats.bfree * blockSize;
	const used = total - free;

	return { used, free, total };
}

export async function deleteFile(relativePath: string): Promise<void> {
	const filePath = resolvePath(relativePath);
	const stats = await fs.stat(filePath);

	if (stats.isDirectory()) {
		await fs.rm(filePath, { recursive: true });
	} else {
		await fs.unlink(filePath);
	}
}

export async function ensureDirectory(relativePath: string): Promise<void> {
	const dirPath = resolvePath(relativePath);
	await fs.mkdir(dirPath, { recursive: true });
}

export function isAudioFile(filename: string): boolean {
	const ext = path.extname(filename).toLowerCase();
	return AUDIO_EXTENSIONS.includes(ext);
}

export async function getFileStats(relativePath: string): Promise<{ size: number; mtime: Date }> {
	const filePath = resolvePath(relativePath);
	const stats = await fs.stat(filePath);
	return { size: stats.size, mtime: stats.mtime };
}

export function createReadStream(relativePath: string, options?: { start?: number; end?: number }) {
	const filePath = resolvePath(relativePath);
	return fsSync.createReadStream(filePath, options);
}

export function createWriteStream(relativePath: string) {
	const filePath = resolvePath(relativePath);
	return fsSync.createWriteStream(filePath);
}
