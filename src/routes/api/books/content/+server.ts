import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath } from '$server/services/files';
import fs from 'fs/promises';
import path from 'path';

/** Return the parsed chunk list ({ title, locale, chunks }) for a book folder. */
export const GET: RequestHandler = async ({ url }) => {
	const rawPath = url.searchParams.get('path');

	if (!rawPath) {
		throw error(400, 'Path is required');
	}

	const folderPath = rawPath.normalize('NFC');

	try {
		const abs = resolvePath(folderPath);
		const raw = await fs.readFile(path.join(abs, 'book.chunks.json'), 'utf-8');
		return json(JSON.parse(raw));
	} catch (err) {
		const msg = err instanceof Error ? err.message : '';
		if (msg.includes('traversal')) {
			throw error(403, 'Forbidden');
		}
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'Book not found');
		}
		console.error('Book content GET error:', err);
		throw error(500, 'Failed to load book');
	}
};
