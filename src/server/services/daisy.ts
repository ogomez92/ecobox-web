import fs from 'fs/promises';
import fsSync from 'fs';
import path from 'path';
import type { Chapter, DaisyBook, DaisyVolume } from '$lib/types';
import { getMediaRoot } from './files';

const DAISY_MARKERS = ['ncc.html', 'ncc.xml', 'Navigation.xml'];
const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.wav', '.aac', '.flac'];
const VOLUME_PATTERN = /^(\d+)\s+of\s+(\d+)$/i;

// Convert absolute path to path relative to MEDIA_ROOT
function toRelativePath(absolutePath: string): string {
	const mediaRoot = getMediaRoot();
	return path.relative(mediaRoot, absolutePath);
}

export async function isDaisyBook(folderPath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(folderPath);
		if (!stats.isDirectory()) return false;

		// Check for DAISY markers in the folder itself
		for (const marker of DAISY_MARKERS) {
			const markerPath = path.join(folderPath, marker);
			try {
				await fs.access(markerPath);
				return true;
			} catch {
				// Continue checking other markers
			}
		}

		// Check for multi-volume structure
		const volumes = await getVolumeSubdirectories(folderPath);
		for (const volumePath of volumes) {
			for (const marker of DAISY_MARKERS) {
				const markerPath = path.join(volumePath, marker);
				try {
					await fs.access(markerPath);
					return true;
				} catch {
					// Continue
				}
			}
		}

		return false;
	} catch {
		return false;
	}
}

async function getVolumeSubdirectories(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { withFileTypes: true });
		const volumes: { path: string; index: number; total: number }[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const match = entry.name.match(VOLUME_PATTERN);
			if (match) {
				volumes.push({
					path: path.join(folderPath, entry.name),
					index: parseInt(match[1], 10),
					total: parseInt(match[2], 10)
				});
			}
		}

		// Sort by index
		volumes.sort((a, b) => a.index - b.index);
		return volumes.map(v => v.path);
	} catch {
		return [];
	}
}

export async function parseDaisyBook(folderPath: string): Promise<DaisyBook | null> {
	try {
		// Check for multi-volume structure
		const volumes = await getVolumeSubdirectories(folderPath);

		if (volumes.length > 0) {
			// Multi-volume DAISY book
			const parsedVolumes: DaisyVolume[] = [];
			let totalDuration = 0;

			for (const volumePath of volumes) {
				const volumeChapters = await parseDaisyVolume(volumePath);
				if (volumeChapters.length > 0) {
					// Adjust chapter times for continuous playback
					const adjustedChapters = volumeChapters.map(ch => ({
						...ch,
						startTime: ch.startTime + totalDuration,
						filePath: ch.filePath
					}));

					const volumeDuration = volumeChapters.reduce((max, ch) =>
						Math.max(max, (ch.endTime || ch.startTime)), 0);

					parsedVolumes.push({
						name: path.basename(volumePath),
						path: volumePath,
						chapters: adjustedChapters
					});

					totalDuration += volumeDuration;
				}
			}

			const allChapters = parsedVolumes.flatMap(v => v.chapters);

			return {
				title: path.basename(folderPath),
				totalDuration,
				chapters: allChapters,
				volumes: parsedVolumes
			};
		}

		// Single volume
		const chapters = await parseDaisyVolume(folderPath);
		if (chapters.length === 0) return null;

		const totalDuration = chapters.reduce((max, ch) =>
			Math.max(max, (ch.endTime || ch.startTime)), 0);

		return {
			title: path.basename(folderPath),
			totalDuration,
			chapters
		};
	} catch {
		return null;
	}
}

async function parseDaisyVolume(volumePath: string): Promise<Chapter[]> {
	// Try each DAISY navigation format
	for (const marker of DAISY_MARKERS) {
		const markerPath = path.join(volumePath, marker);
		try {
			await fs.access(markerPath);
			const content = await fs.readFile(markerPath, 'utf-8');

			if (marker === 'ncc.html') {
				return parseNCCHtml(content, volumePath);
			} else if (marker === 'ncc.xml' || marker === 'Navigation.xml') {
				return parseNCCXml(content, volumePath);
			}
		} catch {
			// Try next format
		}
	}

	// Fallback: return audio files as chapters
	return getAudioFilesAsChapters(volumePath);
}

function parseNCCHtml(content: string, basePath: string): Chapter[] {
	const chapters: Chapter[] = [];

	// Extract h1/h2/h3 elements with links to SMIL files
	const headingRegex = /<h[1-6][^>]*>.*?<a\s+href="([^"]+)"[^>]*>([^<]*)<\/a>.*?<\/h[1-6]>/gi;

	let match;
	while ((match = headingRegex.exec(content)) !== null) {
		const smilRef = match[1];
		const title = decodeHTMLEntities(match[2].trim());

		const audioInfo = extractAudioFromSmil(smilRef, basePath);
		if (audioInfo) {
			chapters.push({
				title,
				startTime: audioInfo.startTime,
				endTime: audioInfo.endTime,
				filePath: audioInfo.filePath
			});
		}
	}

	return chapters;
}

function parseNCCXml(content: string, basePath: string): Chapter[] {
	const chapters: Chapter[] = [];

	// Extract navPoint elements
	const navPointRegex = /<navPoint[^>]*>[\s\S]*?<navLabel>[\s\S]*?<text>([^<]*)<\/text>[\s\S]*?<content\s+src="([^"]+)"[^>]*\/>[\s\S]*?<\/navPoint>/gi;

	let match;
	while ((match = navPointRegex.exec(content)) !== null) {
		const title = decodeHTMLEntities(match[1].trim());
		const src = match[2];

		const audioInfo = extractAudioFromSmil(src, basePath);
		if (audioInfo) {
			chapters.push({
				title,
				startTime: audioInfo.startTime,
				endTime: audioInfo.endTime,
				filePath: audioInfo.filePath
			});
		}
	}

	return chapters;
}

function extractAudioFromSmil(smilRef: string, basePath: string): { filePath: string; startTime: number; endTime?: number } | null {
	try {
		// Parse SMIL reference (file.smil#id or just file.smil)
		const [smilFile, fragmentId] = smilRef.split('#');
		const smilPath = path.join(basePath, smilFile);

		if (!fsSync.existsSync(smilPath)) return null;

		const smilContent = fsSync.readFileSync(smilPath, 'utf-8');

		// Look for audio element
		// <audio src="file.mp3" clip-begin="npt=0s" clip-end="npt=10s"/>
		const audioRegex = /<audio[^>]+src="([^"]+)"[^>]*(?:clip-begin="npt=([^"]+)")?[^>]*(?:clip-end="npt=([^"]+)")?[^>]*\/?>/gi;

		let audioMatch;
		while ((audioMatch = audioRegex.exec(smilContent)) !== null) {
			const audioFile = audioMatch[1];
			const clipBegin = audioMatch[2];
			const clipEnd = audioMatch[3];

			const audioPath = path.join(basePath, audioFile);
			if (fsSync.existsSync(audioPath)) {
				return {
					// Return path relative to MEDIA_ROOT for use with the media API
					filePath: toRelativePath(audioPath),
					startTime: parseNptTime(clipBegin || '0s'),
					endTime: clipEnd ? parseNptTime(clipEnd) : undefined
				};
			}
		}

		return null;
	} catch {
		return null;
	}
}

function parseNptTime(npt: string): number {
	// Parse NPT (Normal Play Time) format: "123.45s" or "1:23:45" or "1:23"
	if (npt.endsWith('s')) {
		return parseFloat(npt.slice(0, -1)) || 0;
	}

	const parts = npt.split(':').map(p => parseFloat(p) || 0);
	if (parts.length === 3) {
		return parts[0] * 3600 + parts[1] * 60 + parts[2];
	} else if (parts.length === 2) {
		return parts[0] * 60 + parts[1];
	}
	return parseFloat(npt) || 0;
}

async function getAudioFilesAsChapters(folderPath: string): Promise<Chapter[]> {
	try {
		const entries = await fs.readdir(folderPath, { withFileTypes: true });
		const audioFiles = entries
			.filter(e => !e.isDirectory() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
			.map(e => path.join(folderPath, e.name))
			.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));

		// Create chapters from audio files (we don't know durations without parsing)
		// Return paths relative to MEDIA_ROOT
		return audioFiles.map((filePath) => ({
			title: path.basename(filePath, path.extname(filePath)),
			startTime: 0, // Would need to calculate cumulative duration
			filePath: toRelativePath(filePath)
		}));
	} catch {
		return [];
	}
}

function decodeHTMLEntities(text: string): string {
	return text
		.replace(/&amp;/g, '&')
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ');
}

export async function getChapteredFolderFiles(folderPath: string): Promise<string[]> {
	// Check if it's a DAISY book first
	if (await isDaisyBook(folderPath)) {
		const book = await parseDaisyBook(folderPath);
		if (book) {
			// Extract unique file paths from chapters (already relative to MEDIA_ROOT)
			const files = book.chapters
				.filter(ch => ch.filePath)
				.map(ch => ch.filePath as string);
			return [...new Set(files)];
		}
	}

	// Regular chaptered folder - return audio files alphabetically
	// Return paths relative to MEDIA_ROOT
	try {
		const entries = await fs.readdir(folderPath, { withFileTypes: true });
		return entries
			.filter(e => !e.isDirectory() && AUDIO_EXTENSIONS.includes(path.extname(e.name).toLowerCase()))
			.map(e => toRelativePath(path.join(folderPath, e.name)))
			.sort((a, b) => path.basename(a).localeCompare(path.basename(b), undefined, { numeric: true }));
	} catch {
		return [];
	}
}
