import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDirectory, deleteFile } from '$server/services/files';
import { recordDeletion } from '$server/services/deletionHistory';
import { purgeCacheForPath } from '$server/services/tts/cache';
import { db } from '$server/db';
import { bookBookmarks } from '$server/db/schema';
import { eq, or, sql } from 'drizzle-orm';
import { getProtectedSet, isPathProtected, isUnlocked } from '$server/services/protection';

export const GET: RequestHandler = async ({ url, cookies }) => {
	const path = url.searchParams.get('path') || '';

	// Check if user is unlocked
	const unlocked = isUnlocked(cookies);

	// Get protected paths
	const protectedSet = await getProtectedSet();

	// If not unlocked and trying to access a protected path, pretend it doesn't exist
	if (!unlocked && path && isPathProtected(path, protectedSet)) {
		throw error(404, 'Directory not found');
	}

	try {
		let files = await listDirectory(path);

		// Filter protected paths if not unlocked, or mark them if unlocked
		if (!unlocked) {
			files = files.filter(file => {
				// Check if this exact path is protected
				if (protectedSet.has(file.path)) return false;

				// Check if any ancestor is protected
				const pathParts = file.path.split('/');
				for (let i = 1; i < pathParts.length; i++) {
					const ancestorPath = pathParts.slice(0, i).join('/');
					if (protectedSet.has(ancestorPath)) return false;
				}

				return true;
			});
		}

		// Add isProtected flag to each file (only matters when unlocked)
		const filesWithProtection = files.map(file => ({
			...file,
			isProtected: protectedSet.has(file.path)
		}));

		return json({
			files: filesWithProtection,
			unlocked
		});
	} catch (err) {
		if ((err as Error).message === 'Directory not found') {
			throw error(404, 'Directory not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Failed to list directory');
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path');

	if (!path) {
		throw error(400, 'Path is required');
	}

	// Sync-mode uploads tag their DELETEs with source=sync so the history can
	// label them; everything else is a direct user deletion.
	const source = url.searchParams.get('source') === 'sync' ? 'sync' : 'user';

	try {
		const { isDirectory } = await deleteFile(path);
		// Drop any cached TTS audio for this path (book folder, or a parent dir of
		// books — the cache tree mirrors the media tree so the subtree goes too).
		// Best-effort: never let cache bookkeeping fail an actual deletion.
		try {
			await purgeCacheForPath(path);
		} catch (cacheErr) {
			console.error('Failed to purge TTS cache:', cacheErr);
		}
		// Drop any saved book bookmarks for this path. Mirrors the cache purge:
		// removes rows for an exact book folder, OR for every book under a deleted
		// parent dir (the path itself or anything beneath "path/"). LIKE wildcards
		// are escaped so a literal % or _ in a folder name can't widen the match.
		// Best-effort: never let bookmark bookkeeping fail an actual deletion.
		try {
			const p = path.normalize('NFC');
			const esc = p.replace(/[\\%_]/g, (c) => '\\' + c);
			await db
				.delete(bookBookmarks)
				.where(
					or(
						eq(bookBookmarks.bookFolderPath, p),
						sql`${bookBookmarks.bookFolderPath} LIKE ${esc + '/%'} ESCAPE '\\'`
					)
				);
		} catch (bmErr) {
			console.error('Failed to purge book bookmarks:', bmErr);
		}
		// Record every deletion in the history. Best-effort: never let history
		// bookkeeping fail an actual deletion.
		try {
			await recordDeletion({ path, isDirectory, source });
		} catch (histErr) {
			console.error('Failed to record deletion history:', histErr);
		}
		return json({ success: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'File not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Failed to delete file');
	}
};
