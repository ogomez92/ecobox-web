import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import type { UploadNegotiateRequest, UploadNegotiateResponse } from '$lib/types';
import { resolvePath, listDirectoryRecursive } from '$server/services/files';
import fs from 'fs/promises';
import path from 'path';

export const POST: RequestHandler = async ({ request }) => {
	try {
		const body: UploadNegotiateRequest = await request.json();
		const { basePath, mode, files } = body;

		if (basePath === undefined || basePath === null || !mode || !files) {
			throw error(400, 'Missing required fields');
		}

		// Validate base path
		resolvePath(basePath);

		// Ensure base directory exists
		const baseDir = resolvePath(basePath);
		await fs.mkdir(baseDir, { recursive: true });

		const toUpload: string[] = [];
		const toDelete: string[] = [];

		// Get existing files in destination
		let existingFiles: Map<string, number> = new Map();
		try {
			const existing = await listDirectoryRecursive(basePath);
			existingFiles = new Map(
				existing
					.filter(f => !f.isDirectory)
					.map(f => [path.relative(basePath, f.path), f.size])
			);
		} catch {
			// Directory might not exist yet
		}

		// Determine which files need to be uploaded
		for (const file of files) {
			const existingSize = existingFiles.get(file.path);

			if (existingSize === undefined) {
				// File doesn't exist, upload it
				toUpload.push(file.path);
			} else if (existingSize === 0 && file.size > 0) {
				// Existing file is 0 bytes (likely failed upload), re-upload it
				toUpload.push(file.path);
			} else if (mode === 'sync' && existingSize !== file.size) {
				// File exists but different size, upload it in sync mode
				toUpload.push(file.path);
			}
			// In copy mode, skip existing files with matching or non-zero size

			// Remove from existing files map (for sync deletion tracking)
			existingFiles.delete(file.path);
		}

		// In sync mode, delete files that weren't in the upload list
		if (mode === 'sync') {
			for (const [existingPath] of existingFiles) {
				// Don't delete .CHAPTERED marker files
				if (!existingPath.endsWith('.CHAPTERED')) {
					toDelete.push(path.join(basePath, existingPath));
				}
			}
		}

		const response: UploadNegotiateResponse = {
			toUpload,
			toDelete: mode === 'sync' ? toDelete : undefined
		};

		return json(response);
	} catch (err) {
		// Re-throw SvelteKit errors as-is
		if (err && typeof err === 'object' && 'status' in err) {
			throw err;
		}
		const message = err instanceof Error ? err.message : '';
		if (message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Negotiation failed');
	}
};
