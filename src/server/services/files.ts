import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import { env } from '$env/dynamic/private';
import type { FileEntry, StorageInfo } from '$lib/types';
import { isBookExtension } from '$lib/utils/bookChunks';
import { isAudioExtension, isVideoExtension } from '$lib/utils/mediaTypes';
import { foldForSearch } from '$lib/utils/text';
export { isBookExtension, BOOK_EXTENSIONS } from '$lib/utils/bookChunks';
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

/**
 * Normalize a relative path to forward slashes.
 *
 * Relative paths are this app's public identifiers for media: they travel to
 * clients, become URL segments, and are stored as primary keys in
 * `media_metadata`, `bookmarks`, `book_metadata` and friends. On Windows,
 * `path.join`/`path.relative` yield backslashes, which would give one file two
 * identities — `Books\a.mp3` from a directory listing versus `Books/a.mp3` from
 * a URL — and silently split its saved position and bookmarks across two rows.
 *
 * So every relative path leaving this module is emitted POSIX-style, the form
 * the rest of the app and every URL already assume. The reverse direction needs
 * no work: `path.resolve()` accepts both separators on Windows, so
 * `resolvePath()` takes either.
 */
export function toPosixPath(relativePath: string): string {
	return path.sep === '/' ? relativePath : relativePath.split(path.sep).join('/');
}

export function getRelativePath(absolutePath: string): string {
	const mediaRoot = getMediaRoot();
	return toPosixPath(path.relative(mediaRoot, absolutePath));
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
			const fileRelPath = toPosixPath(path.join(relativePath, entry.name));

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
				// Video plays audio-only, but the row says so — and it's what the
				// "Extract audio" action keys off.
				if (isVideoExtension(entry.name)) {
					fileEntry.isVideoFile = true;
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

/**
 * Search a folder and everything below it for entries whose *name* matches.
 *
 * Scoped deliberately: the walk starts at `relativePath` and only ever descends,
 * so a search made inside `a/` can never surface `c/d` from a sibling or parent
 * folder. Matching is case- and accent-insensitive (same folding as the reader's
 * find), substring anywhere in the name.
 *
 * Playable units (DAISY / .CHAPTERED / .BOOK folders) are opaque, exactly as in
 * listDirectoryRecursive — a book matches by its folder name and its internal
 * files are never listed separately. Unreadable subdirectories are skipped rather
 * than failing the whole search.
 *
 * `total` counts every match; `results` is capped at `limit` after sorting, so
 * the cap is stable (best-sorted first) rather than dependent on walk order.
 */
export async function searchDirectory(
	relativePath: string = '',
	query: string,
	limit: number = 200
): Promise<{ results: FileEntry[]; total: number }> {
	const folded = foldForSearch(query.trim());
	if (!folded) return { results: [], total: 0 };

	const matches: FileEntry[] = [];

	async function recurse(currentPath: string, depth: number): Promise<void> {
		const entries = await listDirectory(currentPath);

		for (const entry of entries) {
			// The chaptered marker is bookkeeping, not a file a user searches for.
			if (entry.name === CHAPTERED_MARKER) continue;

			if (foldForSearch(entry.name).includes(folded)) {
				matches.push(entry);
			}

			if (entry.isDirectory && !entry.isDaisyBook && !entry.isChapteredFolder && !entry.isBookFolder) {
				try {
					await recurse(entry.path, depth + 1);
				} catch {
					// A folder that vanished or can't be read mid-walk shouldn't sink the search.
				}
			}
		}
	}

	await recurse(relativePath, 0);

	matches.sort((a, b) => {
		// Directories (books, folders) first, then by name — mirrors the file list.
		if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
		const byName = a.name.localeCompare(b.name, undefined, { numeric: true });
		return byName !== 0 ? byName : a.path.localeCompare(b.path, undefined, { numeric: true });
	});

	return { results: matches.slice(0, limit), total: matches.length };
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

/**
 * Names a user-created folder may not have.
 *
 * The separators are the security-relevant ones (a name is a single segment, so
 * `a/b` or `..` would silently place the folder somewhere else), the rest are
 * portability: Windows is a supported target and rejects `<>:"|?*`, control
 * characters, trailing dots/spaces, and the legacy device names — a folder made
 * here must still be creatable on a Windows install of the same library.
 */
const INVALID_FOLDER_CHARS = /[\\/:*?"<>|\x00-\x1f]/;
const RESERVED_FOLDER_NAMES = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(\.|$)/i;
const MAX_FOLDER_NAME_LENGTH = 255;

export type FolderNameError = 'empty' | 'invalidChars' | 'reserved' | 'tooLong';

/**
 * Validate a single folder-name segment, returning the trimmed name to create or
 * the reason it was refused. Pure, so the rules are unit-testable without a disk.
 */
export function validateFolderName(raw: string): { name: string } | { error: FolderNameError } {
	const name = raw.trim();
	if (!name || name === '.' || name === '..') return { error: 'empty' };
	if (INVALID_FOLDER_CHARS.test(name)) return { error: 'invalidChars' };
	// Trailing dots/spaces are silently stripped by Windows, so "a." and "a" would
	// be the same folder there but not here.
	if (/[. ]$/.test(name)) return { error: 'invalidChars' };
	if (RESERVED_FOLDER_NAMES.test(name)) return { error: 'reserved' };
	if (Buffer.byteLength(name, 'utf-8') > MAX_FOLDER_NAME_LENGTH) return { error: 'tooLong' };
	return { name };
}

/**
 * Create one folder named `name` inside `parentPath`. Returns its relative path.
 *
 * mkdir is deliberately NOT recursive: the caller wants to know when the name is
 * already taken (EEXIST) or the parent has since disappeared (ENOENT), rather
 * than have either quietly succeed. The parent is resolved through
 * `resolveExistingPath` so an accented (NFD-on-disk) folder is found from the NFC
 * path a browser sends.
 */
export async function createFolder(parentPath: string, name: string): Promise<string> {
	const relative = toPosixPath(parentPath ? `${parentPath}/${name}` : name);
	await fs.mkdir(resolveExistingPath(relative));
	return relative;
}

export function isAudioFile(filename: string): boolean {
	return isAudioExtension(filename);
}

/**
 * Video is played through the same `<audio>` element as everything else, so the
 * whole "is this playable" question stays in one shared module.
 */
export {
	isPlayableMedia,
	isVideoExtension,
	needsAudioExtraction,
	AUDIO_EXTENSIONS,
	VIDEO_EXTENSIONS
} from '$lib/utils/mediaTypes';

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
