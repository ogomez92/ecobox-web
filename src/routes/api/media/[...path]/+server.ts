import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getFileStats, createReadStream, resolveExistingPath, getRelativePath } from '$server/services/files';
import { isPathHidden } from '$server/services/protection';
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

	// Protected content stays invisible to a locked session
	if (await isPathHidden(filePath, cookies)) {
		throw error(404, 'File not found');
	}

	try {
		// Canonicalize to the real on-disk path (also throws on traversal). Handles
		// accented names stored decomposed (NFD) on disk vs. requested precomposed
		// (NFC); both forms now resolve to the same file and the same ETag.
		const realRel = getRelativePath(resolveExistingPath(filePath));

		const stats = await getFileStats(realRel);
		const { size } = stats;
		const mtime = stats.mtime;
		const ext = path.extname(realRel).toLowerCase();
		const mimeType = MIME_TYPES[ext] || 'application/octet-stream';

		// Generate ETag and Last-Modified
		const etag = generateETag(realRel, size, mtime);
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

			const stream = createReadStream(realRel, { start, end });
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
		const stream = createReadStream(realRel);
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
