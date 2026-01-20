import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getFileStats, createReadStream, resolvePath } from '$server/services/files';
import { db } from '$server/db';
import { protectedPaths } from '$server/db/schema';
import { env } from '$env/dynamic/private';
import path from 'path';

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
	const filePath = url.searchParams.get('path');

	if (!filePath) {
		throw error(400, 'Path is required');
	}

	// Check if user is unlocked
	const unlocked = cookies.get('unlocked') === env.PROTECT_KEYWORD;

	if (!unlocked) {
		const protectedList = await db.select().from(protectedPaths);
		const protectedSet = new Set(protectedList.map(p => p.path));

		if (isPathProtected(filePath, protectedSet)) {
			throw error(404, 'File not found');
		}
	}

	try {
		// Validate path
		resolvePath(filePath);

		const { size } = await getFileStats(filePath);
		const filename = path.basename(filePath);

		const stream = createReadStream(filePath);
		const readableStream = nodeStreamToWebStream(stream);

		return new Response(readableStream, {
			status: 200,
			headers: {
				'Content-Type': 'application/octet-stream',
				'Content-Length': String(size),
				'Content-Disposition': `attachment; filename="${encodeURIComponent(filename)}"`,
				'Cache-Control': 'no-cache'
			}
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'File not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Failed to download file');
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
