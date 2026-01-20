import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath, createWriteStream, ensureDirectory } from '$server/services/files';
import path from 'path';

// Allow large file uploads (10GB max)
export const config = {
	body: {
		maxSize: 10 * 1024 * 1024 * 1024
	}
};

export const POST: RequestHandler = async ({ request, url }) => {
	const filePath = url.searchParams.get('path');

	if (!filePath) {
		throw error(400, 'Path is required');
	}

	try {
		// Validate path
		resolvePath(filePath);

		// Ensure parent directory exists
		const parentDir = path.dirname(filePath);
		await ensureDirectory(parentDir);

		// Get the request body as a stream
		const body = request.body;
		if (!body) {
			throw error(400, 'No file data provided');
		}

		// Create write stream
		const writeStream = createWriteStream(filePath);

		// Pipe the request body to the file
		const reader = body.getReader();

		try {
			while (true) {
				const { done, value } = await reader.read();
				if (done) break;

				await new Promise<void>((resolve, reject) => {
					const canContinue = writeStream.write(Buffer.from(value));
					if (canContinue) {
						resolve();
					} else {
						writeStream.once('drain', resolve);
						writeStream.once('error', reject);
					}
				});
			}

			await new Promise<void>((resolve, reject) => {
				writeStream.end((err?: Error) => {
					if (err) reject(err);
					else resolve();
				});
			});

			return json({ success: true, path: filePath });
		} finally {
			reader.releaseLock();
		}
	} catch (err) {
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		console.error('Upload error:', err);
		throw error(500, 'Upload failed');
	}
};
