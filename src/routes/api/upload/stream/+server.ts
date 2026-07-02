import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath, createWriteStream, ensureDirectory } from '$server/services/files';
import { once } from 'node:events';
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

		// One durable 'error' listener latches async write/open failures (ENOSPC,
		// EACCES, …). This replaces the old per-chunk `once('error', reject)` that
		// was re-added on every backpressure cycle and never removed — the source of
		// the "11 error listeners added to [WriteStream]" MaxListeners warning on
		// large uploads. It also surfaces errors that fire when there is no
		// backpressure (where the old loop had no error listener at all).
		let writeError: Error | null = null;
		writeStream.on('error', (e: Error) => {
			writeError = e;
		});

		// Pipe the request body to the file
		const reader = body.getReader();

		try {
			while (true) {
				if (writeError) throw writeError;
				const { done, value } = await reader.read();
				if (done) break;

				// write() returns false under backpressure; wait for 'drain' before
				// continuing. once() resolves on 'drain', rejects on 'error', and
				// removes both listeners each iteration — no accumulation.
				if (!writeStream.write(Buffer.from(value))) {
					await once(writeStream, 'drain');
				}
			}

			await new Promise<void>((resolve) => writeStream.end(() => resolve()));
			if (writeError) throw writeError;

			return json({ success: true, path: filePath });
		} finally {
			reader.releaseLock();
		}
	} catch (err) {
		// Re-throw SvelteKit errors as-is (e.g. the 400 above) so the real
		// status/message reaches the client instead of being masked.
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}
		const message = err instanceof Error ? err.message : '';
		if (message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		console.error('Upload error:', err);
		throw error(500, 'Upload failed');
	}
};
