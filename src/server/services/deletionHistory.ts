import { db } from '$server/db';
import { deletionHistory, type DeletionHistoryEntry } from '$server/db/schema';
import { desc, lte } from 'drizzle-orm';

// Hard cap on retained entries. Once exceeded, the oldest rows are pruned
// automatically — there is intentionally no manual way to clear the history.
export const MAX_DELETION_HISTORY = 1000;

/**
 * Record a single filesystem deletion and prune the history back down to the
 * most recent MAX_DELETION_HISTORY entries. A folder deletion is recorded as a
 * single entry (isDirectory = true), not one per contained file. `source`
 * distinguishes explicit user deletions from sync-mode upload deletions.
 */
export async function recordDeletion(entry: {
	path: string;
	isDirectory: boolean;
	source: 'user' | 'sync';
}): Promise<void> {
	const name = entry.path.split('/').filter(Boolean).pop() ?? entry.path;

	await db.insert(deletionHistory).values({
		path: entry.path,
		name,
		isDirectory: entry.isDirectory,
		source: entry.source
	});

	// Find the id at the boundary (the newest row we want to drop) and delete it
	// plus everything older. Ids are autoincrement, so higher id == more recent.
	const boundary = await db
		.select({ id: deletionHistory.id })
		.from(deletionHistory)
		.orderBy(desc(deletionHistory.id))
		.limit(1)
		.offset(MAX_DELETION_HISTORY);

	if (boundary.length > 0) {
		await db.delete(deletionHistory).where(lte(deletionHistory.id, boundary[0].id));
	}
}

/** Return the deletion history, newest first. */
export async function listDeletions(): Promise<DeletionHistoryEntry[]> {
	return db
		.select()
		.from(deletionHistory)
		.orderBy(desc(deletionHistory.id))
		.limit(MAX_DELETION_HISTORY);
}
