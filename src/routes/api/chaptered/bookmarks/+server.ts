import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import { and, eq } from 'drizzle-orm';

/**
 * Bookmarks inside a multi-file book. A bare time is meaningless here — "1h12m"
 * is a different place in every file — so each row carries the file it belongs
 * to plus the offset within that file.
 */

export const GET: RequestHandler = async ({ url }) => {
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		throw error(400, 'Path is required');
	}

	try {
		const bookmarks = await db.query.chapteredBookmarks.findMany({
			where: eq(schema.chapteredBookmarks.folderPath, rawPath.normalize('NFC')),
			orderBy: schema.chapteredBookmarks.time
		});

		return json(bookmarks);
	} catch (err) {
		console.error('Chaptered bookmarks GET error:', err);
		throw error(500, 'Failed to get bookmarks');
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { folderPath: rawFolderPath, filePath: rawFilePath, time, label } = body;

		if (!rawFolderPath || !rawFilePath || time === undefined) {
			throw error(400, 'folderPath, filePath and time are required');
		}

		const folderPath = rawFolderPath.normalize('NFC');
		const filePath = rawFilePath.normalize('NFC');

		// chaptered_bookmarks has a foreign key onto chaptered_metadata, so a book
		// that has never been played needs its row before a bookmark can land.
		await db
			.insert(schema.chapteredMetadata)
			.values({ folderPath })
			.onConflictDoNothing();

		const created = await db
			.insert(schema.chapteredBookmarks)
			.values({ folderPath, filePath, time, label: label || null, createdAt: new Date() })
			.returning();

		return json(created[0]);
	} catch (err) {
		if ((err as { status?: number }).status) throw err;
		console.error('Chaptered bookmarks POST error:', err);
		throw error(500, 'Failed to create bookmark');
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');
	const rawPath = url.searchParams.get('path');
	const rawFilePath = url.searchParams.get('filePath');
	const time = url.searchParams.get('time');

	try {
		if (id) {
			await db
				.delete(schema.chapteredBookmarks)
				.where(eq(schema.chapteredBookmarks.id, parseInt(id, 10)));
		} else if (rawPath && rawFilePath && time) {
			await db
				.delete(schema.chapteredBookmarks)
				.where(
					and(
						eq(schema.chapteredBookmarks.folderPath, rawPath.normalize('NFC')),
						eq(schema.chapteredBookmarks.filePath, rawFilePath.normalize('NFC')),
						eq(schema.chapteredBookmarks.time, parseFloat(time))
					)
				);
		} else {
			throw error(400, 'Either id or (path, filePath and time) are required');
		}

		return json({ success: true });
	} catch (err) {
		if ((err as { status?: number }).status) throw err;
		console.error('Chaptered bookmarks DELETE error:', err);
		throw error(500, 'Failed to delete bookmark');
	}
};
