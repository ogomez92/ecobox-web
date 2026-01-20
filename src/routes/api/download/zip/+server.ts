import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath } from '$server/services/files';
import { db } from '$server/db';
import { protectedPaths } from '$server/db/schema';
import { env } from '$env/dynamic/private';
import archiver from 'archiver';
import path from 'path';
import fs from 'fs';
import { PassThrough } from 'stream';

// Check if a path or any of its ancestors is protected
function isPathProtected(filePath: string, protectedSet: Set<string>): boolean {
	if (!filePath) return false;
	if (protectedSet.has(filePath)) return true;

	const pathParts = filePath.split('/').filter(Boolean);
	for (let i = 1; i <= pathParts.length; i++) {
		const ancestorPath = pathParts.slice(0, i).join('/');
		if (protectedSet.has(ancestorPath)) return true;
	}
	return false;
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const folderPath = url.searchParams.get('path');

	if (!folderPath) {
		throw error(400, 'Path is required');
	}

	// Check if user is unlocked
	const unlocked = cookies.get('unlocked') === env.PROTECT_KEYWORD;

	if (!unlocked) {
		const protectedList = await db.select().from(protectedPaths);
		const protectedSet = new Set(protectedList.map(p => p.path));

		if (isPathProtected(folderPath, protectedSet)) {
			throw error(404, 'Directory not found');
		}
	}

	try {
		// Validate and resolve path
		const absolutePath = resolvePath(folderPath);

		// Check that it's a directory
		const stats = fs.statSync(absolutePath);
		if (!stats.isDirectory()) {
			throw error(400, 'Path must be a directory');
		}

		const folderName = path.basename(folderPath) || 'download';

		// Create archive
		const archive = archiver('zip', {
			zlib: { level: 5 }
		});

		// Create passthrough stream
		const passthrough = new PassThrough();
		archive.pipe(passthrough);

		// Add directory to archive
		archive.directory(absolutePath, folderName);

		// Finalize archive
		archive.finalize();

		// Convert to web stream
		const readableStream = nodeStreamToWebStream(passthrough);

		return new Response(readableStream, {
			status: 200,
			headers: {
				'Content-Type': 'application/zip',
				'Content-Disposition': `attachment; filename="${encodeURIComponent(folderName)}.zip"`,
				'Cache-Control': 'no-cache'
			}
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'Directory not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		console.error('ZIP error:', err);
		throw error(500, 'Failed to create ZIP');
	}
};

function nodeStreamToWebStream(nodeStream: NodeJS.ReadableStream): ReadableStream<Uint8Array> {
	return new ReadableStream({
		start(controller) {
			nodeStream.on('data', (chunk: Buffer) => {
				controller.enqueue(new Uint8Array(chunk));
			});
			nodeStream.on('end', () => {
				controller.close();
			});
			nodeStream.on('error', (err) => {
				controller.error(err);
			});
		},
		cancel() {
			if ('destroy' in nodeStream && typeof nodeStream.destroy === 'function') {
				nodeStream.destroy();
			}
		}
	});
}
