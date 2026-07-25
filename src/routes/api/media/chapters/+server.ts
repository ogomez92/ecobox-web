import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolveExistingPath } from '$server/services/files';
import { extractID3Chapters } from '$server/services/id3chapters';
import { extractMP4Chapters } from '$server/services/mp4chapters';
import { getChapteredBook } from '$server/services/daisy';
import path from 'path';
import fs from 'fs/promises';

/** Containers whose chapters live in an MP4 atom tree. */
const MP4_EXTENSIONS = new Set(['.m4b', '.m4a', '.mp4', '.m4v', '.mov']);

export const GET: RequestHandler = async ({ url }) => {
	const filePath = url.searchParams.get('path');

	if (!filePath) {
		throw error(400, 'Path is required');
	}

	try {
		// Real on-disk path (handles NFC/NFD accented names).
		const absolutePath = resolveExistingPath(filePath);
		const stats = await fs.stat(absolutePath);

		if (stats.isDirectory()) {
			// DAISY book, or a plain chaptered folder read in file order. `files`
			// carries the playback order with each file's place on the timeline, so a
			// client never has to probe durations file by file.
			const book = await getChapteredBook(absolutePath);
			if (book) {
				return json({
					type: book.type,
					title: book.title,
					author: book.author,
					chapters: book.chapters,
					files: book.files,
					totalDuration: book.totalDuration
				});
			}

			// A folder with no audio in it at all.
			return json({
				type: 'chaptered',
				chapters: [],
				files: [],
				totalDuration: 0
			});
		}

		// Single audio file - try to extract embedded chapters
		const ext = path.extname(absolutePath).toLowerCase();
		if (ext === '.mp3') {
			const chapters = extractID3Chapters(absolutePath);
			return json({
				type: 'id3',
				chapters
			});
		}

		// MP4 family (.m4b audiobooks, .m4a, .mp4): QuickTime chapter track or Nero chpl
		if (MP4_EXTENSIONS.has(ext)) {
			const chapters = extractMP4Chapters(absolutePath);
			return json({
				type: 'mp4',
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
