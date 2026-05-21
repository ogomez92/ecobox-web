import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getFileStats, createReadStream, resolvePath } from '$server/services/files';
import { db } from '$server/db';
import { protectedPaths } from '$server/db/schema';
import { env } from '$env/dynamic/private';
import path from 'path';
import crypto from 'crypto';

const MIME_TYPES: Record<string, string> = {
	'.mp3': 'audio/mpeg',
	'.m4a': 'audio/mp4',
	'.m4b': 'audio/mp4',
	'.aac': 'audio/aac',
	'.ogg': 'audio/ogg',
	'.opus': 'audio/opus',
	'.wav': 'audio/wav',
	'.flac': 'audio/flac'
};

// Check if a path or any of its ancestors is protected
function isPathProtected(filePath: string, protectedSet: Set<string>): boolean {
	if (!filePath) return false;

	// Check exact path
	if (protectedSet.has(filePath)) return true;

	// Check ancestors
	const pathParts = filePath.split('/').filter(Boolean);
	for (let i = 1; i <= pathParts.length; i++) {
		const ancestorPath = pathParts.slice(0, i).join('/');
		if (protectedSet.has(ancestorPath)) return true;
	}

	return false;
}

// Generate ETag from file path, size, and mtime
function generateETag(filePath: string, size: number, mtime: Date): string {
	const hash = crypto.createHash('md5')
		.update(`${filePath}-${size}-${mtime.getTime()}`)
		.digest('hex')
		.slice(0, 16);
	return `"${hash}"`;
}

export const GET: RequestHandler = async ({ params, request, cookies }) => {
	const filePath = params.path;

	if (!filePath) {
		throw error(400, 'Path is required');
	}

	// Check if user is unlocked
	const unlocked = cookies.get('unlocked') === env.PROTECT_KEYWORD;

	// Check if path is protected
	if (!unlocked) {
		const protectedList = await db.select().from(protectedPaths);
		const protectedSet = new Set(protectedList.map(p => p.path));

		if (isPathProtected(filePath, protectedSet)) {
			throw error(404, 'File not found');
		}
	}

	try {
		// Validate path (throws on traversal)
		resolvePath(filePath);

		const stats = await getFileStats(filePath);
		const { size } = stats;
		const mtime = stats.mtime;
		const ext = path.extname(filePath).toLowerCase();
		const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

		// Generate ETag and Last-Modified
		const etag = generateETag(filePath, size, mtime);
		const lastModified = mtime.toUTCString();

		// Check If-None-Match (ETag)
		const ifNoneMatch = request.headers.get('if-none-match');
		if (ifNoneMatch === etag) {
			return new Response(null, {
				status: 304,
				headers: {
					'ETag': etag,
					'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
				}
			});
		}

		// Check If-Modified-Since
		const ifModifiedSince = request.headers.get('if-modified-since');
		if (ifModifiedSince && new Date(ifModifiedSince) >= mtime) {
			return new Response(null, {
				status: 304,
				headers: {
					'ETag': etag,
					'Last-Modified': lastModified,
					'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
				}
			});
		}

		const cacheHeaders = {
			'ETag': etag,
			'Last-Modified': lastModified,
			'Cache-Control': 'public, max-age=86400, stale-while-revalidate=604800'
		};

		const rangeHeader = request.headers.get('range');

		if (rangeHeader) {
			// Parse range header
			const match = rangeHeader.match(/bytes=(\d+)-(\d*)/);
			if (!match) {
				throw error(416, 'Invalid range');
			}

			const start = parseInt(match[1], 10);
			const end = match[2] ? parseInt(match[2], 10) : size - 1;

			if (start >= size || end >= size || start > end) {
				throw error(416, 'Range not satisfiable');
			}

			const stream = createReadStream(filePath, { start, end });
			const readableStream = nodeStreamToWebStream(stream);

			return new Response(readableStream, {
				status: 206,
				headers: {
					'Content-Type': mimeType,
					'Content-Length': String(end - start + 1),
					'Content-Range': `bytes ${start}-${end}/${size}`,
					'Accept-Ranges': 'bytes',
					...cacheHeaders
				}
			});
		}

		// Full file response
		const stream = createReadStream(filePath);
		const readableStream = nodeStreamToWebStream(stream);

		return new Response(readableStream, {
			status: 200,
			headers: {
				'Content-Type': mimeType,
				'Content-Length': String(size),
				'Accept-Ranges': 'bytes',
				...cacheHeaders
			}
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'File not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Failed to stream file');
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
