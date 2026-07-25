import fs from 'fs/promises';
import fsNode from 'fs';
import { Readable } from 'stream';
import path from 'path';
import { parseBlob, parseWebStream } from 'music-metadata';
import { db, schema } from '$server/db';
import { inArray, sql } from 'drizzle-orm';
import { getMediaRoot } from './files';

/**
 * Durations of audio files, cached in SQLite.
 *
 * Reading a duration means parsing the file header (and, for VBR MP3s without a
 * Xing header, scanning the whole file), so a 50-file DAISY book would otherwise
 * pay that cost on every request. Cache entries are keyed by size + mtime, so an
 * edited or replaced file re-parses automatically.
 */

/** Parsing is IO- and CPU-bound; a handful at a time keeps a big folder responsive. */
const PARSE_CONCURRENCY = 6;
/** SQLite's default parameter cap is 999 — stay well under it when batching. */
const SQL_BATCH = 400;

async function pooled<T, R>(items: T[], limit: number, worker: (item: T) => Promise<R>): Promise<R[]> {
	const results = new Array<R>(items.length);
	let next = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (next < items.length) {
			const index = next++;
			results[index] = await worker(items[index]);
		}
	});
	await Promise.all(runners);
	return results;
}

async function readDuration(absolutePath: string, size: number): Promise<number> {
	try {
		// A Blob lets the parser seek — straight to an MP4 `moov` atom or a trailing
		// ID3 tag — instead of reading the file front to back. The stream is the
		// fallback for Node builds without fs.openAsBlob (added in 19.8).
		// `duration: true` makes it count frames when no header carries a duration,
		// which is the VBR-MP3-without-Xing case.
		const metadata = fsNode.openAsBlob
			? await parseBlob(await fsNode.openAsBlob(absolutePath), { duration: true })
			: await parseWebStream(
					Readable.toWeb(fsNode.createReadStream(absolutePath)) as Parameters<typeof parseWebStream>[0],
					{ size },
					{ duration: true }
				);
		return metadata.format.duration ?? 0;
	} catch {
		return 0;
	}
}

/**
 * Durations (seconds) for media-root-relative paths, in a map keyed by the same
 * paths. Unreadable files map to 0 rather than dropping out, so callers can lay
 * out a timeline without holes.
 */
export async function getDurations(relativePaths: string[]): Promise<Map<string, number>> {
	const durations = new Map<string, number>();
	const paths = [...new Set(relativePaths)];
	if (paths.length === 0) return durations;

	const mediaRoot = getMediaRoot();
	const stats = new Map<string, { size: number; mtime: number }>();
	await pooled(paths, PARSE_CONCURRENCY, async (relPath) => {
		try {
			const stat = await fs.stat(path.join(mediaRoot, relPath));
			stats.set(relPath, { size: stat.size, mtime: Math.round(stat.mtimeMs) });
		} catch {
			durations.set(relPath, 0);
		}
	});

	const known = [...stats.keys()];
	const cached = new Map<string, { duration: number; size: number; mtime: number }>();
	for (let i = 0; i < known.length; i += SQL_BATCH) {
		const batch = known.slice(i, i + SQL_BATCH);
		const rows = await db
			.select()
			.from(schema.mediaDurations)
			.where(inArray(schema.mediaDurations.path, batch));
		for (const row of rows) {
			cached.set(row.path, { duration: row.duration, size: row.size, mtime: row.mtime });
		}
	}

	const stale: string[] = [];
	for (const relPath of known) {
		const stat = stats.get(relPath)!;
		const hit = cached.get(relPath);
		if (hit && hit.size === stat.size && hit.mtime === stat.mtime) {
			durations.set(relPath, hit.duration);
		} else {
			stale.push(relPath);
		}
	}
	if (stale.length === 0) return durations;

	const parsed = await pooled(stale, PARSE_CONCURRENCY, async (relPath) => {
		const stat = stats.get(relPath)!;
		const duration = await readDuration(path.join(mediaRoot, relPath), stat.size);
		durations.set(relPath, duration);
		return { path: relPath, duration, size: stat.size, mtime: stat.mtime };
	});

	// Best-effort: a cache write failing must not fail the request that needed the
	// durations — the next call simply re-parses.
	try {
		for (let i = 0; i < parsed.length; i += SQL_BATCH) {
			await db
				.insert(schema.mediaDurations)
				.values(parsed.slice(i, i + SQL_BATCH))
				.onConflictDoUpdate({
					target: schema.mediaDurations.path,
					set: {
						duration: sql`excluded.duration`,
						size: sql`excluded.size`,
						mtime: sql`excluded.mtime`
					}
				});
		}
	} catch (err) {
		console.error('Duration cache write failed:', err);
	}

	return durations;
}
