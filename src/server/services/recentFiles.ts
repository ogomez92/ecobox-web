/**
 * The "recently opened" log behind the Recent tab.
 *
 * Two halves:
 *
 * 1. **Recording** — `recordAccess` upserts one row per media path, so re-opening
 *    a file moves it up the list instead of piling up duplicates. Only playable /
 *    readable units are recorded (an audio file, a radio station, a DAISY or
 *    .CHAPTERED folder, a converted book) — plain folder browsing is not, since
 *    the tab answers "what was I listening to", not "where have I clicked".
 *
 * 2. **Resolution** — `resolveRecentTarget` decides where an entry opens *now*.
 *    Rows are deliberately never pruned when the file disappears (`dbCleanup`
 *    leaves this table alone on purpose): instead the entry falls back to the
 *    nearest ancestor that still exists. Deleting `Show/Season 01/ep08.mp3` opens
 *    `Show/Season 01`; deleting that folder too opens `Show`; and with nothing
 *    left it opens the media root. A recent entry can therefore never dead-end.
 *
 * The walk is injectable (`describe` / `isHidden`) so the fallback rule can be
 * unit-tested without a filesystem or a database.
 */
import fs from 'fs/promises';
import { db } from '$server/db';
import { recentFiles } from '$server/db/schema';
import { desc, notInArray } from 'drizzle-orm';
import type { RecentEntry, RecentKind } from '$lib/types';
import {
	resolvePath,
	isBookFolder,
	isDaisyBook,
	isChapteredFolder,
	isBookExtension
} from './files';

/** Cap on retained rows; the oldest fall off automatically. */
export const MAX_RECENT = 100;

/** How many entries the API serves by default. */
export const DEFAULT_RECENT_LIMIT = 50;

const RECENT_KINDS: RecentKind[] = [
	'file',
	'radio',
	'chaptered',
	'daisy',
	'book',
	'rawbook',
	'folder'
];

export function isRecentKind(value: unknown): value is RecentKind {
	return typeof value === 'string' && (RECENT_KINDS as string[]).includes(value);
}

/** Parent of a media-relative path; '' for a top-level entry (i.e. the media root). */
export function parentOf(path: string): string {
	return path.split('/').filter(Boolean).slice(0, -1).join('/');
}

/** Last segment of a media-relative path ('' for the media root). */
export function nameOf(path: string): string {
	return path.split('/').filter(Boolean).pop() ?? '';
}

/**
 * What lives at `relativePath` right now, or `null` if nothing does.
 *
 * Directory checks run in the same order as `listDirectory`, so a folder is
 * classified exactly as the file browser would classify it.
 */
export async function describePath(relativePath: string): Promise<RecentKind | null> {
	let absolute: string;
	try {
		absolute = resolvePath(relativePath);
	} catch {
		return null; // traversal guard — treat as non-existent
	}

	let stats;
	try {
		stats = await fs.stat(absolute);
	} catch {
		return null;
	}

	if (stats.isDirectory()) {
		if (await isBookFolder(absolute)) return 'book';
		if (await isDaisyBook(absolute)) return 'daisy';
		if (await isChapteredFolder(absolute)) return 'chaptered';
		return 'folder';
	}

	const name = nameOf(relativePath);
	if (name.endsWith('.radio')) return 'radio';
	if (isBookExtension(name)) return 'rawbook';
	return 'file';
}

/**
 * Client route that opens `path`. Mirrors `FileRow.getHref` / the search dialog:
 * converted books go to the reader, DAISY / chaptered folders and audio files to
 * the player, plain folders to the browser. A raw (unconverted) book isn't
 * playable, so it opens its containing folder with the file focused — where the
 * Convert action lives.
 */
export function hrefFor(kind: RecentKind, path: string): string {
	switch (kind) {
		case 'book':
			return `/read/${path}`;
		case 'daisy':
		case 'chaptered':
		case 'file':
		case 'radio':
			return `/play/${path}`;
		case 'rawbook': {
			const parent = parentOf(path);
			const focus = `?focus=${encodeURIComponent(nameOf(path))}`;
			return parent ? `/browse/${parent}${focus}` : `/${focus}`;
		}
		case 'folder':
		default:
			return path ? `/browse/${path}` : '/';
	}
}

/**
 * Walk from `path` up through its ancestors and return the first one that still
 * exists (and is visible to this session), together with where it opens.
 *
 * Terminates at the media root, which always exists — so the result is total.
 * `exists` reports whether the *original* path was the one found, which is what
 * the UI uses to flag an entry as no longer available.
 */
export async function resolveRecentTarget(
	path: string,
	options: {
		describe?: (p: string) => Promise<RecentKind | null>;
		/** Paths this session may not see (protected and still locked). */
		isHidden?: (p: string) => boolean;
	} = {}
): Promise<RecentEntry['target'] & { exists: boolean }> {
	const describe = options.describe ?? describePath;
	const isHidden = options.isHidden ?? (() => false);

	let candidate = path.split('/').filter(Boolean).join('/');
	let isOriginal = true;

	// eslint-disable-next-line no-constant-condition
	while (true) {
		if (!isHidden(candidate)) {
			const kind = await describe(candidate);
			if (kind) {
				return {
					path: candidate,
					kind,
					href: hrefFor(kind, candidate),
					name: nameOf(candidate),
					exists: isOriginal
				};
			}
		}
		if (candidate === '') break;
		candidate = parentOf(candidate);
		isOriginal = false;
	}

	// The media root itself was unreadable (or hidden) — home is still a valid place to land.
	return { path: '', kind: 'folder', href: '/', name: '', exists: false };
}

/**
 * Record that `path` was opened. Best-effort by design: the caller is a player or
 * reader that must not fail because bookkeeping did.
 */
export async function recordAccess(entry: { path: string; kind: RecentKind }): Promise<void> {
	const path = entry.path.split('/').filter(Boolean).join('/');
	if (!path) return;

	const now = new Date();
	await db
		.insert(recentFiles)
		.values({ path, name: nameOf(path), kind: entry.kind, accessedAt: now })
		.onConflictDoUpdate({
			target: recentFiles.path,
			set: { name: nameOf(path), kind: entry.kind, accessedAt: now }
		});

	// Prune anything past the newest MAX_RECENT rows.
	const keep = await db
		.select({ path: recentFiles.path })
		.from(recentFiles)
		.orderBy(desc(recentFiles.accessedAt))
		.limit(MAX_RECENT);
	if (keep.length >= MAX_RECENT) {
		await db.delete(recentFiles).where(
			notInArray(
				recentFiles.path,
				keep.map((r) => r.path)
			)
		);
	}
}

/**
 * The Recent list, newest first, each entry resolved to a target that exists.
 *
 * `isHidden` filters protected content for a locked session: an entry whose own
 * path is hidden is dropped outright (it must not even be listed), and the
 * fallback walk skips hidden ancestors rather than routing into them.
 */
export async function listRecent(
	options: { limit?: number; isHidden?: (p: string) => boolean } = {}
): Promise<RecentEntry[]> {
	const limit = options.limit ?? DEFAULT_RECENT_LIMIT;
	const isHidden = options.isHidden ?? (() => false);

	const rows = await db
		.select()
		.from(recentFiles)
		.orderBy(desc(recentFiles.accessedAt))
		.limit(MAX_RECENT);

	const entries: RecentEntry[] = [];
	for (const row of rows) {
		if (entries.length >= limit) break;
		if (isHidden(row.path)) continue;

		const { exists, ...target } = await resolveRecentTarget(row.path, { isHidden });
		entries.push({
			path: row.path,
			name: row.name,
			kind: isRecentKind(row.kind) ? row.kind : 'file',
			accessedAt: (row.accessedAt ?? new Date()).toISOString(),
			exists,
			target
		});
	}

	return entries;
}
