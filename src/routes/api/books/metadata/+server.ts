import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';

export const GET: RequestHandler = async ({ url }) => {
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		throw error(400, 'Path is required');
	}

	// Normalize Unicode to NFC form for consistent database lookups
	const bookFolderPath = rawPath.normalize('NFC');

	try {
		const metadata = await db.query.bookMetadata.findFirst({
			where: eq(schema.bookMetadata.bookFolderPath, bookFolderPath)
		});

		if (!metadata) {
			return json({
				bookFolderPath,
				currentChunkIndex: 0,
				totalChunks: null,
				lastReadDate: null,
				isFavorite: false
			});
		}

		return json(metadata);
	} catch (err) {
		console.error('Book metadata GET error:', err);
		throw error(500, 'Failed to get book metadata');
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { bookFolderPath: rawFolderPath, currentChunkIndex, totalChunks, isFavorite } = body;

		if (!rawFolderPath) {
			throw error(400, 'Folder path is required');
		}

		// Normalize Unicode to NFC form for consistent database storage
		const bookFolderPath = rawFolderPath.normalize('NFC');

		const values = {
			bookFolderPath,
			currentChunkIndex: currentChunkIndex ?? 0,
			totalChunks: totalChunks ?? null,
			isFavorite: isFavorite ?? false,
			lastReadDate: new Date()
		};

		// Frequent position saves omit isFavorite — don't clobber it when absent.
		const set: Record<string, unknown> = {
			currentChunkIndex: values.currentChunkIndex,
			totalChunks: values.totalChunks,
			lastReadDate: values.lastReadDate
		};
		if (isFavorite !== undefined) set.isFavorite = isFavorite;

		await db
			.insert(schema.bookMetadata)
			.values(values)
			.onConflictDoUpdate({
				target: schema.bookMetadata.bookFolderPath,
				set
			});

		return json({ success: true });
	} catch (err) {
		console.error('Book metadata PUT error:', err);
		throw error(500, 'Failed to save book metadata');
	}
};
