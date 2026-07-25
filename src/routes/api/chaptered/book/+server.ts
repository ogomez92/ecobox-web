import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveExistingPath } from '$server/services/files';
import { getChapteredBook } from '$server/services/daisy';
import { isPathHidden } from '$server/services/protection';
import { db, schema } from '$server/db';
import { eq } from 'drizzle-orm';
import fs from 'fs/promises';

/**
 * GET /api/chaptered/book?path=<folder>
 *
 * Everything a player needs to open a multi-file book, in one round trip: the
 * chapter list, the ordered files with durations, the saved position and the
 * bookmarks. Opening used to cost a chapters call plus a metadata call plus a
 * bookmarks call — and a client without `files` had no way to place a file on
 * the book timeline short of fetching every file to measure it.
 *
 * A path that is a plain file answers `{ type: 'file' }` rather than erroring, so
 * one request can also decide *how* to open something.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		throw error(400, 'Path is required');
	}

	const folderPath = rawPath.normalize('NFC');

	if (await isPathHidden(folderPath, cookies)) {
		throw error(404, 'Not found');
	}

	try {
		const absolutePath = resolveExistingPath(folderPath);
		const stats = await fs.stat(absolutePath);

		if (!stats.isDirectory()) {
			return json({ type: 'file' });
		}

		// The book parse and the two DB reads are independent — run them together.
		const [book, metadata, bookmarks] = await Promise.all([
			getChapteredBook(absolutePath),
			db.query.chapteredMetadata.findFirst({
				where: eq(schema.chapteredMetadata.folderPath, folderPath)
			}),
			db.query.chapteredBookmarks.findMany({
				where: eq(schema.chapteredBookmarks.folderPath, folderPath),
				orderBy: schema.chapteredBookmarks.time
			})
		]);

		if (!book) {
			throw error(404, 'No audio in this folder');
		}

		return json({
			type: book.type,
			title: book.title,
			author: book.author,
			totalDuration: book.totalDuration,
			files: book.files,
			chapters: book.chapters,
			metadata: {
				currentFilePath: metadata?.currentFilePath ?? null,
				currentFilePosition: metadata?.currentFilePosition ?? 0,
				totalDuration: metadata?.totalDuration ?? null
			},
			bookmarks
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'Folder not found');
		}
		if ((err as Error).message?.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		if ((err as { status?: number }).status) throw err;
		console.error('Chaptered book error:', err);
		throw error(500, 'Failed to read book');
	}
};
