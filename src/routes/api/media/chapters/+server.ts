import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath } from '$server/services/files';
import { extractID3Chapters } from '$server/services/id3chapters';
import { parseDaisyBook, isDaisyBook } from '$server/services/daisy';
import path from 'path';
import fs from 'fs/promises';

export const GET: RequestHandler = async ({ url }) => {
	const filePath = url.searchParams.get('path');

	if (!filePath) {
		throw error(400, 'Path is required');
	}

	try {
		const absolutePath = resolvePath(filePath);
		const stats = await fs.stat(absolutePath);

		if (stats.isDirectory()) {
			// Check if it's a DAISY book
			if (await isDaisyBook(absolutePath)) {
				const book = await parseDaisyBook(absolutePath);
				if (book) {
					return json({
						type: 'daisy',
						title: book.title,
						chapters: book.chapters,
						totalDuration: book.totalDuration
					});
				}
			}

			// Regular chaptered folder - no chapters, just files
			return json({
				type: 'chaptered',
				chapters: []
			});
		}

		// Single audio file - try to extract ID3 chapters
		const ext = path.extname(absolutePath).toLowerCase();
		if (ext === '.mp3') {
			const chapters = extractID3Chapters(absolutePath);
			return json({
				type: 'id3',
				chapters
			});
		}

		// Other audio formats - no chapters
		return json({
			type: 'none',
			chapters: []
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'File not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		console.error('Chapter extraction error:', err);
		throw error(500, 'Failed to extract chapters');
	}
};
