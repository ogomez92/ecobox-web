import type { FileEntry } from '$lib/types';

/**
 * How the file browser orders a folder. The order of `SORT_FIELDS` is the order
 * of the Ctrl+1 … Ctrl+5 shortcuts and of the sort bar, so it is part of the UI.
 */
export const SORT_FIELDS = ['name', 'lastPlayed', 'duration', 'size', 'modifiedAt'] as const;
export type SortField = (typeof SORT_FIELDS)[number];
export type SortDirection = 'asc' | 'desc';

/**
 * The direction a field starts in when first chosen. Name reads A→Z; every other
 * field is a quantity where "most" is what the user is looking for: the most
 * recently played, the longest, the largest, the newest.
 */
export const DEFAULT_DIRECTION: Record<SortField, SortDirection> = {
	name: 'asc',
	lastPlayed: 'desc',
	duration: 'desc',
	size: 'desc',
	modifiedAt: 'desc'
};

function compareNames(a: FileEntry, b: FileEntry): number {
	return a.name.localeCompare(b.name, undefined, { numeric: true });
}

/** The sortable quantity of an entry for a field, or `undefined` when unknown. */
function keyOf(entry: FileEntry, field: SortField): number | undefined {
	switch (field) {
		case 'size':
			// A directory's st_size says nothing about its contents.
			return entry.isDirectory ? undefined : entry.size;
		case 'modifiedAt':
			return new Date(entry.modifiedAt).getTime();
		case 'duration':
			return entry.duration;
		case 'lastPlayed':
			return entry.lastPlayedAt;
		default:
			return undefined;
	}
}

function compareDirsFirst(a: FileEntry, b: FileEntry): number {
	if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1;
	return 0;
}

/**
 * Order two entries. Directories come first, then — within each group — the
 * chosen field in the chosen direction. The one exception is "recent": there a
 * folder is as recent as the newest thing played inside it, so folders and files
 * interleave on one timeline (the season you were in the middle of sits right
 * next to the file you played after it). Entries with no value for the field (a
 * never-played file under "recent", a folder or unparsed file under "duration")
 * sort after everything that has one *regardless of direction*, so flipping the
 * order never hides the real results behind a wall of unknowns. Ties fall back
 * to directories-first, then the name, so the order is stable and predictable.
 */
export function compareEntries(
	a: FileEntry,
	b: FileEntry,
	field: SortField,
	direction: SortDirection
): number {
	if (field !== 'lastPlayed') {
		const byKind = compareDirsFirst(a, b);
		if (byKind !== 0) return byKind;
	}

	const sign = direction === 'asc' ? 1 : -1;
	if (field === 'name') return sign * compareNames(a, b);

	const ka = keyOf(a, field);
	const kb = keyOf(b, field);
	const knownA = ka !== undefined && isFinite(ka);
	const knownB = kb !== undefined && isFinite(kb);
	if (knownA !== knownB) return knownA ? -1 : 1;
	if (knownA && knownB && ka !== kb) return sign * ((ka as number) - (kb as number));
	return compareDirsFirst(a, b) || compareNames(a, b);
}

export function sortEntries(
	entries: readonly FileEntry[],
	field: SortField,
	direction: SortDirection
): FileEntry[] {
	return [...entries].sort((a, b) => compareEntries(a, b, field, direction));
}
