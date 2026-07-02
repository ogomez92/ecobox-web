import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { env } from '$env/dynamic/private';
import type { FileEntry, StorageInfo } from '$lib/types';
import { isBookExtension } from '$lib/utils/bookChunks';
export { isBookExtension, BOOK_EXTENSIONS } from '$lib/utils/bookChunks';
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.wav', '.flac'];
const DAISY_MARKERS = ['ncc.html', 'ncc.xml', 'Navigation.xml'];
const CHAPTERED_MARKER = '.CHAPTERED';
const RADIO_EXTENSION = '.radio';
// Marker file written into a converted-book folder (alongside book.md / book.chunks.json).
export const BOOK_MARKER = '.BOOK';

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

/**
 * Resolve a relative path to its REAL on-disk form, tolerating Unicode
 * normalization differences (NFC vs NFD) between the requested name and the
 * actual directory entry.
 *
 * Accented filenames are frequently stored decomposed (NFD — e.g. "encontraré"
 * as `e` + U+0301) on disk, while browsers/clients send the precomposed (NFC,
 * U+00E9) form. The filesystem matches bytes exactly, so an NFC request misses an
 * NFD file and pandoc/readFile report "does not exist". This walks each path
 * segment from MEDIA_ROOT and matches by NFC-normalized comparison, returning the
 * bytes that actually exist on disk.
 *
 * If the path already exists as given, or no normalization-equal entry exists for
 * some segment (e.g. a not-yet-created write target), the plain resolved path is
 * returned unchanged — so callers still get the normal ENOENT. Goes through
 * resolvePath, so the traversal gate always applies.
 */
export function resolveExistingPath(relativePath: string): string {
	const resolved = resolvePath(relativePath);
	if (fsSync.existsSync(resolved)) return resolved;

	const mediaRoot = path.resolve(getMediaRoot());
	const rel = path.relative(mediaRoot, resolved);
	if (rel === '' || rel.startsWith('..')) return resolved;

	const segments = rel.split(path.sep);
	let current = mediaRoot;
	for (let i = 0; i < segments.length; i++) {
		const segment = segments[i];
		const direct = path.join(current, segment);
		if (fsSync.existsSync(direct)) {
			current = direct;
			continue;
		}
		let match: string | undefined;
		try {
			const wanted = segment.normalize('NFC');
			match = fsSync.readdirSync(current).find((e) => e.normalize('NFC') === wanted);
		} catch {
			match = undefined; // `current` isn't a readable directory
		}
		if (match === undefined) {
			// No on-disk match for this segment (e.g. a not-yet-created write target):
			// keep the canonicalized prefix and append the requested remainder, so a write
			// into an accented parent dir still lands in the real (NFD) directory.
			return path.join(current, ...segments.slice(i));
		}
		current = path.join(current, match);
	}
	return current;
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
				// Check for converted book folder first (cheap marker check).
				fileEntry.isBookFolder = await isBookFolder(entryPath);
				if (fileEntry.isBookFolder) {
					fileEntry.bookVerified = await isBookVerified(entryPath);
				}
				if (!fileEntry.isBookFolder) {
					// Check for DAISY book
					fileEntry.isDaisyBook = await isDaisyBook(entryPath);
					// Check for chaptered folder
					fileEntry.isChapteredFolder = await isChapteredFolder(entryPath);
				}
			} else {
				// Check for radio file
				if (entry.name.endsWith(RADIO_EXTENSION)) {
					fileEntry.isRadioFile = true;
				}
				// Check for a raw, not-yet-converted book source file.
				if (isBookExtension(entry.name)) {
					fileEntry.isRawBook = true;
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

			// Treat book folders as opaque units (like DAISY/chaptered) — never descend
			// into them, or upload-negotiate would list book.md/book.chunks.json as extras.
			if (entry.isDirectory && !entry.isDaisyBook && !entry.isChapteredFolder && !entry.isBookFolder) {
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

export async function isBookFolder(dirPath: string): Promise<boolean> {
	try {
		await fs.access(path.join(dirPath, BOOK_MARKER));
		return true;
	} catch {
		return false;
	}
}

/** Read the .BOOK marker's `verified` flag (defaults to true if the marker is legacy/unparsable). */
export async function isBookVerified(dirPath: string): Promise<boolean> {
	try {
		const raw = await fs.readFile(path.join(dirPath, BOOK_MARKER), 'utf-8');
		const marker = JSON.parse(raw) as { verified?: boolean };
		return marker.verified !== false;
	} catch {
		return true;
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

export async function deleteFile(relativePath: string): Promise<{ isDirectory: boolean }> {
	const filePath = resolvePath(relativePath);
	const stats = await fs.stat(filePath);

	if (stats.isDirectory()) {
		await fs.rm(filePath, { recursive: true });
		return { isDirectory: true };
	} else {
		await fs.unlink(filePath);
		return { isDirectory: false };
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
