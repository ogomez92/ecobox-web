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
	const folderPath = rawPath.normalize('NFC');

	try {
		const metadata = await db.query.chapteredMetadata.findFirst({
			where: eq(schema.chapteredMetadata.folderPath, folderPath)
		});

		if (!metadata) {
			return json({
				folderPath,
				currentFilePath: null,
				currentFilePosition: 0,
				totalDuration: null
			});
		}

		return json(metadata);
	} catch (err) {
		console.error('Chaptered metadata GET error:', err);
		throw error(500, 'Failed to get chaptered metadata');
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { folderPath: rawFolderPath, currentFilePath: rawCurrentFilePath, currentFilePosition, totalDuration } = body;

		if (!rawFolderPath) {
			throw error(400, 'Folder path is required');
		}

		// Normalize Unicode to NFC form for consistent database storage
		const folderPath = rawFolderPath.normalize('NFC');
		const currentFilePath = rawCurrentFilePath ? rawCurrentFilePath.normalize('NFC') : null;

		const values = {
			folderPath,
			currentFilePath,
			currentFilePosition: currentFilePosition ?? 0,
			totalDuration: totalDuration ?? null
		};

		await db
			.insert(schema.chapteredMetadata)
			.values(values)
			.onConflictDoUpdate({
				target: schema.chapteredMetadata.folderPath,
				set: {
					currentFilePath: values.currentFilePath,
					currentFilePosition: values.currentFilePosition,
					totalDuration: values.totalDuration
				}
			});

		return json({ success: true });
	} catch (err) {
		console.error('Chaptered metadata PUT error:', err);
		throw error(500, 'Failed to save chaptered metadata');
	}
};
