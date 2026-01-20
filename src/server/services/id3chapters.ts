import fs from 'fs';
import type { Chapter } from '$lib/types';

/**
 * Extract ID3v2 CHAP frames from an MP3 file
 * Supports ID3v2.3 and ID3v2.4
 */
export function extractID3Chapters(filePath: string): Chapter[] {
	const fd = fs.openSync(filePath, 'r');
	try {
		const header = Buffer.alloc(10);
		if (fs.readSync(fd, header, 0, 10, 0) !== 10) return [];

		// Check for ID3 header: "ID3"
		if (header[0] !== 0x49 || header[1] !== 0x44 || header[2] !== 0x33) {
			return [];
		}

		const version = header[3]; // 3 or 4
		const flags = header[5];
		const tagSize = decodeSyncSafe(header.subarray(6, 10));

		let offset = 10;

		// Skip extended header if present
		if (flags & 0x40) {
			const extSizeData = Buffer.alloc(4);
			fs.readSync(fd, extSizeData, 0, 4, offset);
			const extSize = version === 4
				? decodeSyncSafe(extSizeData)
				: decodeBE32(extSizeData);
			offset += extSize;
		}

		const chapters: Chapter[] = [];
		const frameHeaderLen = 10;

		while (offset < 10 + tagSize) {
			const frameHeader = Buffer.alloc(frameHeaderLen);
			if (fs.readSync(fd, frameHeader, 0, frameHeaderLen, offset) !== frameHeaderLen) break;
			offset += frameHeaderLen;

			const frameId = frameHeader.subarray(0, 4).toString('ascii');
			const frameSize = version === 4
				? decodeSyncSafe(frameHeader.subarray(4, 8))
				: decodeBE32(frameHeader.subarray(4, 8));

			if (!frameId || frameId[0] === '\0' || frameSize <= 0) break;

			const content = Buffer.alloc(frameSize);
			if (fs.readSync(fd, content, 0, frameSize, offset) !== frameSize) break;
			offset += frameSize;

			if (frameId === 'CHAP') {
				const chapter = parseCHAPFrame(content, version);
				if (chapter) {
					chapters.push(chapter);
				}
			}

			if (offset >= 10 + tagSize) break;
		}

		return chapters.sort((a, b) => a.startTime - b.startTime);
	} finally {
		fs.closeSync(fd);
	}
}

function parseCHAPFrame(content: Buffer, version: number): Chapter | null {
	let i = 0;

	// Skip element ID (null-terminated string)
	while (i < content.length && content[i] !== 0) i++;
	if (i < content.length) i++; // Skip null terminator

	// Need at least 16 bytes for timestamps
	if (i + 16 > content.length) return null;

	const startMs = decodeBE32(content.subarray(i, i + 4));
	// Skip endMs (i+4 to i+8), startOffset (i+8 to i+12), endOffset (i+12 to i+16)
	i += 16;

	let title: string | undefined;

	// Parse subframes inside CHAP (look for TIT2)
	while (i + 10 <= content.length) {
		const subId = content.subarray(i, i + 4).toString('ascii');
		const subSize = version === 4
			? decodeSyncSafe(content.subarray(i + 4, i + 8))
			: decodeBE32(content.subarray(i + 4, i + 8));
		i += 10; // Skip subframe header

		if (subSize <= 0 || i + subSize > content.length) break;

		const payload = content.subarray(i, i + subSize);
		i += subSize;

		if (subId === 'TIT2' && payload.length >= 1) {
			const encoding = payload[0];
			const textData = payload.subarray(1);

			if (encoding === 0) {
				// ISO-8859-1
				title = textData.toString('latin1').replace(/\0/g, '');
			} else if (encoding === 1) {
				// UTF-16 with BOM
				title = textData.toString('utf16le').replace(/\0/g, '');
			} else if (encoding === 2) {
				// UTF-16BE
				title = textData.swap16().toString('utf16le').replace(/\0/g, '');
			} else if (encoding === 3) {
				// UTF-8
				title = textData.toString('utf8').replace(/\0/g, '');
			}
		}
	}

	return {
		title: title || `Chapter`,
		startTime: startMs / 1000
	};
}

function decodeSyncSafe(bytes: Buffer): number {
	return ((bytes[0] & 0x7f) << 21) |
		((bytes[1] & 0x7f) << 14) |
		((bytes[2] & 0x7f) << 7) |
		(bytes[3] & 0x7f);
}

function decodeBE32(bytes: Buffer): number {
	return (bytes[0] << 24) | (bytes[1] << 16) | (bytes[2] << 8) | bytes[3];
}
