import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import { eq, and } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		throw error(400, 'Path is required');
	}

	// Normalize Unicode to NFC form for consistent database lookups
	const mediaPath = rawPath.normalize('NFC');

	try {
		const bookmarks = await db.query.bookmarks.findMany({
			where: eq(schema.bookmarks.mediaPath, mediaPath),
			orderBy: schema.bookmarks.time
		});

		return json(bookmarks);
	} catch (err) {
		console.error('Bookmarks GET error:', err);
		throw error(500, 'Failed to get bookmarks');
	}
};

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { mediaPath: rawPath, time, label } = body;

		if (!rawPath || time === undefined) {
			throw error(400, 'mediaPath and time are required');
		}

		// Normalize Unicode to NFC form for consistent database storage
		const mediaPath = rawPath.normalize('NFC');

		// Ensure media metadata exists
		await db
			.insert(schema.mediaMetadata)
			.values({ path: mediaPath })
			.onConflictDoNothing();

		// Insert bookmark
		const result = await db
			.insert(schema.bookmarks)
			.values({
				mediaPath,
				time,
				label: label || null,
				createdAt: new Date()
			})
			.returning();

		return json(result[0]);
	} catch (err) {
		console.error('Bookmarks POST error:', err);
		throw error(500, 'Failed to create bookmark');
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	const id = url.searchParams.get('id');
	const rawPath = url.searchParams.get('path');
	const time = url.searchParams.get('time');

	try {
		if (id) {
			// Delete by ID
			await db
				.delete(schema.bookmarks)
				.where(eq(schema.bookmarks.id, parseInt(id, 10)));
		} else if (rawPath && time) {
			// Normalize Unicode to NFC form for consistent database lookups
			const mediaPath = rawPath.normalize('NFC');
			// Delete by path and time
			await db
				.delete(schema.bookmarks)
				.where(
					and(
						eq(schema.bookmarks.mediaPath, mediaPath),
						eq(schema.bookmarks.time, parseFloat(time))
					)
				);
		} else {
			throw error(400, 'Either id or (path and time) are required');
		}

		return json({ success: true });
	} catch (err) {
		console.error('Bookmarks DELETE error:', err);
		throw error(500, 'Failed to delete bookmark');
	}
};
