/**
 * Database hygiene: drop rows that point at media paths which no longer exist on
 * disk — saved playback positions, bookmarks and favorites left behind when a
 * file or folder was removed outside the app (or before orphan-cleanup existed).
 *
 * The safety-critical decision — WHICH paths are orphaned — lives in the pure
 * `findOrphanPaths` function so it can be unit-tested without a database or a
 * filesystem. By construction it can never return a path that still exists, which
 * is the guarantee that protects live media from being pruned.
 *
 * `$server/db` is imported lazily inside `cleanupOrphanedRecords` so that merely
 * importing this module (e.g. from a unit test of `findOrphanPaths`) does not open
 * the SQLite connection.
 */
import fs from 'fs';
import { inArray } from 'drizzle-orm';
import { resolveExistingPath } from './files';

export interface CleanupSummary {
	mediaMetadata: number;
	chapteredMetadata: number;
	bookMetadata: number;
	bookBookmarks: number;
	total: number;
}

/**
 * Return the subset of `paths` that are orphaned — i.e. `exists(path)` is false.
 *
 * Conservative by design: blank/whitespace paths are skipped, and if `exists`
 * throws (e.g. a path-traversal guard fires) the path is KEPT, never deleted.
 * Therefore a path that still exists can never appear in the result.
 */
export function findOrphanPaths(paths: string[], exists: (p: string) => boolean): string[] {
	const orphans: string[] = [];
	for (const p of paths) {
		if (!p || !p.trim()) continue;
		let present: boolean;
		try {
			present = exists(p);
		} catch {
			present = true; // ambiguous → keep the row
		}
		if (!present) orphans.push(p);
	}
	return orphans;
}

/** Real on-disk existence for a media-relative path (follows symlinks like the rest of the app). */
export function mediaPathExists(relativePath: string): boolean {
	// resolveExistingPath throws on traversal; let it propagate so the caller keeps
	// the row. It also matches the file under either Unicode normalization (NFC/NFD),
	// so an accented path stored in one form isn't falsely judged missing — which
	// would prune a valid playback-position / bookmark / favorite row.
	return fs.existsSync(resolveExistingPath(relativePath));
}

/**
 * Delete metadata/bookmark rows whose media path no longer exists. `exists` is
 * injectable for tests and defaults to the real filesystem check.
 *
 * Rows in `bookmarks` / `chaptered_bookmarks` are removed automatically by their
 * `ON DELETE CASCADE` foreign keys when their parent metadata row goes; `book_bookmarks`
 * has no foreign key, so it is pruned explicitly here. `protected_paths` and
 * `deletion_history` are intentionally left untouched (the former is a security
 * setting, the latter is a record of things that are *supposed* to be gone).
 */
export async function cleanupOrphanedRecords(
	exists: (p: string) => boolean = mediaPathExists
): Promise<CleanupSummary> {
	const { db, schema } = await import('$server/db');

	// Single files (cascades to `bookmarks`).
	const media = await db.select({ p: schema.mediaMetadata.path }).from(schema.mediaMetadata);
	const mediaOrphans = findOrphanPaths(
		media.map((r) => r.p),
		exists
	);
	if (mediaOrphans.length) {
		await db.delete(schema.mediaMetadata).where(inArray(schema.mediaMetadata.path, mediaOrphans));
	}

	// Chaptered folders (cascades to `chaptered_bookmarks`).
	const chaptered = await db
		.select({ p: schema.chapteredMetadata.folderPath })
		.from(schema.chapteredMetadata);
	const chapteredOrphans = findOrphanPaths(
		chaptered.map((r) => r.p),
		exists
	);
	if (chapteredOrphans.length) {
		await db
			.delete(schema.chapteredMetadata)
			.where(inArray(schema.chapteredMetadata.folderPath, chapteredOrphans));
	}

	// Converted books (reading position + favorite).
	const books = await db
		.select({ p: schema.bookMetadata.bookFolderPath })
		.from(schema.bookMetadata);
	const bookOrphans = findOrphanPaths(
		books.map((r) => r.p),
		exists
	);
	if (bookOrphans.length) {
		await db
			.delete(schema.bookMetadata)
			.where(inArray(schema.bookMetadata.bookFolderPath, bookOrphans));
	}

	// Book bookmarks (no FK — prune by folder path; a folder may have several rows).
	const bookBms = await db
		.select({ p: schema.bookBookmarks.bookFolderPath })
		.from(schema.bookBookmarks);
	const bookBmOrphans = findOrphanPaths([...new Set(bookBms.map((r) => r.p))], exists);
	const bookBmOrphanSet = new Set(bookBmOrphans);
	const bookBookmarkRows = bookBms.filter((r) => bookBmOrphanSet.has(r.p)).length;
	if (bookBmOrphans.length) {
		await db
			.delete(schema.bookBookmarks)
			.where(inArray(schema.bookBookmarks.bookFolderPath, bookBmOrphans));
	}

	return {
		mediaMetadata: mediaOrphans.length,
		chapteredMetadata: chapteredOrphans.length,
		bookMetadata: bookOrphans.length,
		bookBookmarks: bookBookmarkRows,
		total: mediaOrphans.length + chapteredOrphans.length + bookOrphans.length + bookBookmarkRows
	};
}
