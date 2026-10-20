import { db, schema } from '$server/db';
import { inArray, or, sql, type SQL } from 'drizzle-orm';

/** SQLite's default parameter cap is 999 — stay well under it when batching. */
const SQL_BATCH = 400;

/**
 * When each path was last opened, as epoch milliseconds — the value behind the
 * file browser's "Recent" sort.
 *
 * Three tables know about this and none covers everything: `recent_files` logs
 * every playable unit (files, radio, DAISY/chaptered folders, books) but is capped
 * at the newest 100 rows; `media_metadata.last_played_date` exists for every
 * single file ever played; `book_metadata.last_read_date` for every book. The
 * answer is the newest of the three, so a file that fell off the Recent list is
 * still ordered by the day it was actually played.
 *
 * A **directory** is as recent as the newest thing played *inside* it (its own
 * row, if it is a playable unit, or any descendant's): browsing is never
 * recorded, but the folder you were last in is the one you last played from,
 * which is what "recent" means to someone looking for where they left off.
 *
 * Paths are matched NFC-normalized (the DB stores NFC, the disk may be NFD) and
 * the result is keyed by the caller's own spelling. Never throws — an unknown
 * path is simply absent, and a DB error yields an empty map.
 */
export async function getLastPlayed(
	entries: { path: string; isDirectory: boolean }[]
): Promise<Map<string, number>> {
	const result = new Map<string, number>();
	if (entries.length === 0) return result;

	const original = new Map<string, string>();
	for (const e of entries) original.set(e.path.normalize('NFC'), e.path);
	const keys = [...original.keys()];
	const dirs = entries.filter((e) => e.isDirectory).map((e) => e.path.normalize('NFC'));

	const bump = (nfc: string, when: Date | number | null | undefined) => {
		if (when == null) return;
		const ms = when instanceof Date ? when.getTime() : when;
		if (!isFinite(ms)) return;
		const own = original.get(nfc);
		if (!own) return;
		if ((result.get(own) ?? 0) < ms) result.set(own, ms);
	};
	// A row under one of the listed directories counts for that directory. The
	// listed paths are siblings, so at most one of them is a prefix of the row.
	const bumpDescendant = (rowPath: string, when: Date | number | null | undefined) => {
		for (const dir of dirs) {
			if (rowPath.startsWith(dir + '/')) {
				bump(dir, when);
				return;
			}
		}
	};
	const escapeLike = (p: string) => p.replace(/[\\%_]/g, (c) => '\\' + c);

	const tables = [
		{ table: schema.recentFiles, path: schema.recentFiles.path, at: schema.recentFiles.accessedAt },
		{ table: schema.mediaMetadata, path: schema.mediaMetadata.path, at: schema.mediaMetadata.lastPlayedDate },
		{ table: schema.bookMetadata, path: schema.bookMetadata.bookFolderPath, at: schema.bookMetadata.lastReadDate }
	] as const;

	try {
		for (const { table, path, at } of tables) {
			for (let i = 0; i < keys.length; i += SQL_BATCH) {
				const rows = await db
					.select({ path, at })
					.from(table)
					.where(inArray(path, keys.slice(i, i + SQL_BATCH)));
				for (const row of rows) bump(row.path, row.at);
			}
			for (let i = 0; i < dirs.length; i += SQL_BATCH) {
				const prefixes: SQL[] = dirs
					.slice(i, i + SQL_BATCH)
					.map((dir) => sql`${path} LIKE ${escapeLike(dir) + '/%'} ESCAPE '\\'`);
				const rows = await db
					.select({ path, at })
					.from(table)
					.where(or(...prefixes));
				for (const row of rows) bumpDescendant(row.path, row.at);
			}
		}
	} catch (err) {
		console.error('Last-played lookup failed:', err);
	}
	return result;
}
