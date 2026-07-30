import { error, isHttpError } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getFileStats, createReadStream, resolveExistingPath, getRelativePath } from '$server/services/files';
import { isPathHidden } from '$server/services/protection';
import { ifRangeMatches, parseRangeHeader } from '$server/services/httpRange';
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

		// `no-cache` still lets the browser *store* the file — it just has to
		// revalidate before reusing it, which costs one conditional request and
		// normally answers 304. A freshness lifetime instead of revalidation is
		// unsafe here: media is addressed by path, and a path can be re-pointed at
		// completely different bytes (delete + re-upload). With the old
		// `max-age=86400, stale-while-revalidate=604800` the browser would keep
		// serving the previous file's bytes for a day — and stale ones for a week
		// after that — without ever asking, so a replaced file stayed broken until
		// the user manually cleared their cache. `private` because this content is
		// password-gated and must not land in a shared proxy cache.
		const CACHE_CONTROL = 'private, no-cache';

		// RFC 7232 §6: when both validators are present, If-None-Match wins and
		// If-Modified-Since must be ignored — otherwise a client holding a stale
		// ETag but a recent date gets a bogus 304 and keeps its outdated copy.
		const ifNoneMatch = request.headers.get('if-none-match');
		const ifModifiedSince = request.headers.get('if-modified-since');

		let notModified = false;
		if (ifNoneMatch !== null) {
			notModified = ifNoneMatch === etag;
		} else if (ifModifiedSince) {
			// An HTTP-date carries whole seconds, so compare against a floored mtime
			// or a file saved mid-second never validates and always refetches.
			const since = new Date(ifModifiedSince).getTime();
			notModified =
				!Number.isNaN(since) && since >= Math.floor(mtime.getTime() / 1000) * 1000;
		}

		if (notModified) {
			return new Response(null, {
				status: 304,
				headers: {
					'ETag': etag,
					'Last-Modified': lastModified,
					'Cache-Control': CACHE_CONTROL
				}
			});
		}

		const cacheHeaders = {
			'ETag': etag,
			'Last-Modified': lastModified,
			'Cache-Control': CACHE_CONTROL
		};

		const rangeHeader = request.headers.get('range');

		// RFC 7233 §3.2 — an `If-Range` that no longer matches means the client is
		// holding a stale copy (typically a file deleted and re-uploaded at the same
		// path). Answering the range anyway lets it splice bytes from two different
		// files together, which shows up as a decode failure part-way through
		// playback. Ignore the range and send the whole current representation.
		const ifRange = request.headers.get('if-range');
		const rangeIsUsable = !ifRange || ifRangeMatches(ifRange, etag, mtime);

		if (rangeHeader && rangeIsUsable) {
			const range = parseRangeHeader(rangeHeader, size);

			if (range === null) {
				// 416 must advertise the real length so the client can retry sanely.
				// Returned directly rather than thrown: the catch below would other-
				// wise have to re-derive the status from an exception.
				return new Response(null, {
					status: 416,
					headers: {
						'Content-Range': `bytes */${size}`,
						'Accept-Ranges': 'bytes',
						...cacheHeaders
					}
				});
			}

			// `undefined` means the header wasn't a byte range we understand; §3.1
			// says to ignore it and fall through to the full-body response.
			if (range) {
				const { start, end } = range;
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
		// A status we raised deliberately must pass through untouched — otherwise
		// every intentional 4xx in this handler reaches the client as a 500.
		if (isHttpError(err)) {
			throw err;
		}
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'File not found');
		}
		// `message` isn't guaranteed to exist on a thrown non-Error.
		if (String((err as Error)?.message ?? '').includes('traversal')) {
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
