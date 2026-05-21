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
	const path = rawPath.normalize('NFC');

	try {
		const metadata = await db.query.mediaMetadata.findFirst({
			where: eq(schema.mediaMetadata.path, path)
		});

		if (!metadata) {
			return json({
				path,
				lastPlayedPosition: 0,
				duration: null,
				isFavorite: false,
				lastPlayedDate: null
			});
		}

		return json(metadata);
	} catch (err) {
		console.error('Metadata GET error:', err);
		throw error(500, 'Failed to get metadata');
	}
};

export const PUT: RequestHandler = async ({ request }) => {
	try {
		const body = await request.json();
		const { path: rawPath, lastPlayedPosition, duration, isFavorite } = body;

		if (!rawPath) {
			throw error(400, 'Path is required');
		}

		// Normalize Unicode to NFC form for consistent database storage
		const path = rawPath.normalize('NFC');

		const values = {
			path,
			lastPlayedPosition: lastPlayedPosition ?? 0,
			duration: duration ?? null,
			isFavorite: isFavorite ?? false,
			lastPlayedDate: new Date()
		};

		await db
			.insert(schema.mediaMetadata)
			.values(values)
			.onConflictDoUpdate({
				target: schema.mediaMetadata.path,
				set: {
					lastPlayedPosition: values.lastPlayedPosition,
					duration: values.duration,
					isFavorite: values.isFavorite,
					lastPlayedDate: values.lastPlayedDate
				}
			});

		return json({ success: true });
	} catch (err) {
		console.error('Metadata PUT error:', err);
		throw error(500, 'Failed to save metadata');
	}
};
