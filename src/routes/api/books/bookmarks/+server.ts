import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db, schema } from '$server/db';
import { and, eq } from 'drizzle-orm';

// Book bookmarks are the TTS analogue of audio time bookmarks: a saved chunk
// (sentence) index + optional label. The iOS client decodes [{chunkIndex, label}]
// and ignores any extra fields (id/createdAt). Bookmarks are unique per
// (bookFolderPath, chunkIndex), so POST is idempotent on a duplicate index.

export const GET: RequestHandler = async ({ url }) => {
	const raw = url.searchParams.get('path');
	if (!raw) throw error(400, 'Path is required');
	const bookFolderPath = raw.normalize('NFC');

	try {
		const rows = await db.query.bookBookmarks.findMany({
			where: eq(schema.bookBookmarks.bookFolderPath, bookFolderPath)
		});
		return json(
			rows
				.map((r) => ({ chunkIndex: r.chunkIndex, label: r.label }))
				.sort((a, b) => a.chunkIndex - b.chunkIndex)
		);
	} catch (err) {
		console.error('Book bookmarks GET error:', err);
		throw error(500, 'Failed to get book bookmarks');
	}
};

export const POST: RequestHandler = async ({ request }) => {
	const { bookFolderPath: rawPath, chunkIndex, label } = await request.json();
	if (!rawPath || typeof chunkIndex !== 'number') {
		throw error(400, 'bookFolderPath and chunkIndex are required');
	}
	const bookFolderPath = rawPath.normalize('NFC');

	try {
		const existing = await db.query.bookBookmarks.findFirst({
			where: and(
				eq(schema.bookBookmarks.bookFolderPath, bookFolderPath),
				eq(schema.bookBookmarks.chunkIndex, chunkIndex)
			)
		});
		if (!existing) {
			await db
				.insert(schema.bookBookmarks)
				.values({ bookFolderPath, chunkIndex, label: label ?? null });
		}
		return json({ chunkIndex, label: label ?? null });
	} catch (err) {
		console.error('Book bookmarks POST error:', err);
		throw error(500, 'Failed to create book bookmark');
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	const raw = url.searchParams.get('path');
	const idx = url.searchParams.get('chunkIndex');
	if (!raw || idx == null) throw error(400, 'path and chunkIndex are required');

	try {
		await db
			.delete(schema.bookBookmarks)
			.where(
				and(
					eq(schema.bookBookmarks.bookFolderPath, raw.normalize('NFC')),
					eq(schema.bookBookmarks.chunkIndex, parseInt(idx, 10))
				)
			);
		return json({ success: true });
	} catch (err) {
		console.error('Book bookmarks DELETE error:', err);
		throw error(500, 'Failed to delete book bookmark');
	}
};
