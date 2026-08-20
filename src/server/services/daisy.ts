import fs from 'fs/promises';
import path from 'path';
import type { Chapter, ChapteredFile, DaisyBook, DaisyVolume } from '$lib/types';
import { getMediaRoot, toPosixPath } from './files';
import { isPlayableMedia } from '$lib/utils/mediaTypes';
import { getDurations } from './audioDuration';

const DAISY_MARKERS = ['ncc.html', 'ncc.xml', 'Navigation.xml'];

const VOLUME_PATTERN = /^(\d+)\s+of\s+(\d+)$/i;

/** A multi-file book — DAISY, or a plain `.CHAPTERED` folder — as clients consume it. */
export interface ChapteredBook {
	type: 'daisy' | 'chaptered';
	title: string;
	author?: string;
	totalDuration: number;
	/** Playback order; every chapter's `filePath` appears here. */
	files: ChapteredFile[];
	chapters: Chapter[];
}

// Convert absolute path to path relative to MEDIA_ROOT. Forward slashes: these
// become chapter `filePath`s and `files[].path`, which clients send back and
// which key `chaptered_metadata` / `chaptered_bookmarks` (see toPosixPath).
function toRelativePath(absolutePath: string): string {
	const mediaRoot = getMediaRoot();
	return toPosixPath(path.relative(mediaRoot, absolutePath));
}

export async function isDaisyBook(folderPath: string): Promise<boolean> {
	try {
		const stats = await fs.stat(folderPath);
		if (!stats.isDirectory()) return false;

		if (await findMarker(folderPath)) return true;

		// Multi-volume books keep their navigation inside the volume folders.
		for (const volumePath of await getVolumeSubdirectories(folderPath)) {
			if (await findMarker(volumePath)) return true;
		}

		return false;
	} catch {
		return false;
	}
}

async function findMarker(folderPath: string): Promise<string | null> {
	for (const marker of DAISY_MARKERS) {
		const markerPath = path.join(folderPath, marker);
		try {
			await fs.access(markerPath);
			return markerPath;
		} catch {
			// Try the next navigation format
		}
	}
	return null;
}

async function getVolumeSubdirectories(folderPath: string): Promise<string[]> {
	try {
		const entries = await fs.readdir(folderPath, { withFileTypes: true });
		const volumes: { path: string; index: number }[] = [];

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;

			const match = entry.name.match(VOLUME_PATTERN);
			if (match) {
				volumes.push({ path: path.join(folderPath, entry.name), index: parseInt(match[1], 10) });
			}
		}

		volumes.sort((a, b) => a.index - b.index);
		return volumes.map((v) => v.path);
	} catch {
		return [];
	}
}

// MARK: - Text decoding

/**
 * DAISY 2.02 books are routinely windows-1252 / iso-8859-1 — every Spanish book
 * in this library is — and they declare it in the XML prolog or an `ncc:charset`
 * meta rather than with a BOM. Reading them as UTF-8 turns each accent into
 * U+FFFD, which is how "Capítulo" used to reach the chapter list as "Cap<?>tulo".
 */
function decodeDeclared(buffer: Buffer): string {
	const head = buffer.subarray(0, 2048).toString('latin1');
	const declared =
		/<\?xml[^>]*encoding=["']([\w-]+)["']/i.exec(head)?.[1] ??
		/ncc:charset["'\s]+content=["']([\w-]+)["']/i.exec(head)?.[1] ??
		/charset=["']?([\w-]+)/i.exec(head)?.[1];

	if (declared && !/^utf-?8$/i.test(declared)) {
		try {
			return new TextDecoder(declared).decode(buffer);
		} catch {
			// Unknown encoding label — fall through to the UTF-8 path below.
		}
	}

	const utf8 = buffer.toString('utf8');
	// An undeclared legacy encoding shows up as replacement characters. windows-1252
	// is the common case and a superset of latin-1, so it rescues both.
	return utf8.includes('�') ? new TextDecoder('windows-1252').decode(buffer) : utf8;
}

async function readDaisyFile(absolutePath: string): Promise<string> {
	return decodeDeclared(await fs.readFile(absolutePath));
}

// MARK: - Small parsing helpers

/** Attributes of a single tag. Quoted values only, which is all DAISY emits. */
function attributes(tagBody: string): Record<string, string> {
	const attrs: Record<string, string> = {};
	for (const match of tagBody.matchAll(/([\w:-]+)\s*=\s*"([^"]*)"/g)) {
		attrs[match[1].toLowerCase()] = match[2];
	}
	return attrs;
}

/** NPT (Normal Play Time): "npt=12.5s", "12.5s", "1:23:45", "1:23". */
function parseNptTime(npt: string | undefined): number {
	if (!npt) return 0;
	const value = npt.replace(/^npt=/i, '').trim();

	if (value.endsWith('s')) return parseFloat(value.slice(0, -1)) || 0;

	const parts = value.split(':').map((p) => parseFloat(p) || 0);
	if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
	if (parts.length === 2) return parts[0] * 60 + parts[1];
	return parseFloat(value) || 0;
}

/** `<meta name="x" content="y">` lookup, attribute-order independent. */
function metaContent(content: string, name: string): string | undefined {
	for (const match of content.matchAll(/<meta\b([^>]*)>/gi)) {
		const attrs = attributes(match[1]);
		if (attrs.name?.toLowerCase() === name.toLowerCase()) return attrs.content;
	}
	return undefined;
}

function metaSeconds(content: string, name: string): number | null {
	const raw = metaContent(content, name);
	if (raw === undefined) return null;
	const seconds = parseNptTime(raw);
	return Number.isFinite(seconds) ? seconds : null;
}

function decodeHTMLEntities(text: string): string {
	return text
		.replace(/&lt;/g, '<')
		.replace(/&gt;/g, '>')
		.replace(/&quot;/g, '"')
		.replace(/&#39;/g, "'")
		.replace(/&nbsp;/g, ' ')
		.replace(/&amp;/g, '&');
}

// MARK: - SMIL

interface SmilAudio {
	/** `src` as written in the SMIL, i.e. relative to the volume folder. */
	file: string;
	clipBegin: number;
	clipEnd: number | null;
}

interface SmilDocument {
	/** Absolute offset of this SMIL within the volume (`ncc:totalElapsedTime`). */
	elapsed: number | null;
	/** Playback length of this SMIL (`ncc:timeInThisSmil`, or `<seq dur>`). */
	duration: number | null;
	/** Audio clips in document (playback) order. */
	audios: SmilAudio[];
	/** `par`/`text`/`audio` id → index of the clip that starts there. */
	byId: Map<string, number>;
}

/**
 * A SMIL is a flat sequence of `<par>` blocks, each holding the audio clips of
 * one phrase. A navigation heading addresses a fragment inside it (the `par`, or
 * the `text` element within it), so the id → clip map is what turns "chapter 12"
 * into "this file, at 137.4s".
 *
 * Those clip times are not decoration: when several chapters share one long MP3 —
 * routine in DAISY 2.02 — they are the only thing telling the chapters apart.
 */
function parseSmil(content: string): SmilDocument {
	const audios: SmilAudio[] = [];
	const byId = new Map<string, number>();
	let pendingIds: string[] = [];

	for (const match of content.matchAll(/<(par|text|audio)\b([^>]*)>/gi)) {
		const tag = match[1].toLowerCase();
		const attrs = attributes(match[2]);

		if (tag !== 'audio') {
			// A par (or the text child inside it) labels the clip that follows.
			if (attrs.id) pendingIds.push(attrs.id);
			continue;
		}
		if (!attrs.src) continue;

		const clipEnd = attrs['clip-end'] ?? attrs.clipend;
		const index = audios.length;
		audios.push({
			file: attrs.src,
			clipBegin: parseNptTime(attrs['clip-begin'] ?? attrs.clipbegin),
			clipEnd: clipEnd === undefined ? null : parseNptTime(clipEnd)
		});

		if (attrs.id && !byId.has(attrs.id)) byId.set(attrs.id, index);
		for (const id of pendingIds) if (!byId.has(id)) byId.set(id, index);
		pendingIds = [];
	}

	const seqDuration = /<seq\b[^>]*\bdur="([^"]+)"/i.exec(content)?.[1];

	return {
		elapsed: metaSeconds(content, 'ncc:totalElapsedTime'),
		duration: metaSeconds(content, 'ncc:timeInThisSmil') ?? (seqDuration ? parseNptTime(seqDuration) : null),
		audios,
		byId
	};
}

/** Length of a clip, or null when the SMIL doesn't say. */
function clipDuration(audio: SmilAudio): number | null {
	if (audio.clipEnd === null) return null;
	return Math.max(0, audio.clipEnd - audio.clipBegin);
}

// MARK: - Navigation

interface Heading {
	level: number;
	title: string;
	/** SMIL (or audio) file referenced, relative to the volume folder. */
	href: string;
	fragment?: string;
}

/** DAISY 2.02: `<h1><a href="ch1.smil#id">Title</a></h1>`, any nesting/whitespace. */
function parseNccHtml(content: string): Heading[] {
	const headings: Heading[] = [];

	for (const match of content.matchAll(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1>/gi)) {
		const anchor = /<a\b([^>]*)>([\s\S]*?)<\/a>/i.exec(match[2]);
		if (!anchor) continue;

		const href = attributes(anchor[1]).href;
		if (!href) continue;

		const [file, fragment] = href.split('#');
		headings.push({
			level: parseInt(match[1], 10),
			title: decodeHTMLEntities(anchor[2].replace(/<[^>]+>/g, '').trim()),
			href: file,
			fragment
		});
	}

	return headings;
}

/** DAISY 3: `<navPoint><navLabel><text>Title</text></navLabel><content src="…"/>`. */
function parseNccXml(content: string): Heading[] {
	const headings: Heading[] = [];
	const navPointRegex =
		/<navPoint\b([^>]*)>[\s\S]*?<navLabel>[\s\S]*?<text>([\s\S]*?)<\/text>[\s\S]*?<content\b([^>]*?)\/?>/gi;

	for (const match of content.matchAll(navPointRegex)) {
		const src = attributes(match[3]).src;
		if (!src) continue;

		// navPoints nest; `class="level-2"` (or a bare depth attribute) is the only
		// hint a flat regex pass can use, and level is presentational anyway.
		const attrs = attributes(match[1]);
		const level = parseInt(/level-?(\d)/i.exec(attrs.class ?? '')?.[1] ?? '1', 10);

		const [file, fragment] = src.split('#');
		headings.push({
			level,
			title: decodeHTMLEntities(match[2].replace(/<[^>]+>/g, '').trim()),
			href: file,
			fragment
		});
	}

	return headings;
}

// MARK: - Timeline assembly

interface VolumeResult {
	chapters: Chapter[];
	files: ChapteredFile[];
	/** Length of the volume, for offsetting the next one. */
	duration: number;
	title?: string;
	author?: string;
}

/**
 * Lay one volume's audio out on a single timeline.
 *
 * Every clip is placed in playback order, which teaches each file where it starts
 * on the book timeline (`absolute − clipBegin`) and how far into it the book
 * reads (its largest `clip-end`). One pass gives `startTime` (absolute) and
 * `fileStartTime` (file-relative) consistently, and it decodes no audio at all:
 * a 50-file book costs 50 small text reads instead of 50 MP3 scans.
 */
async function parseVolume(volumePath: string, timelineStart: number): Promise<VolumeResult | null> {
	const markerPath = await findMarker(volumePath);
	if (!markerPath) return buildPlainFolder(volumePath, timelineStart);

	const marker = path.basename(markerPath).toLowerCase();
	const navigation = await readDaisyFile(markerPath);
	const headings = marker === 'ncc.html' ? parseNccHtml(navigation) : parseNccXml(navigation);
	if (headings.length === 0) return buildPlainFolder(volumePath, timelineStart);

	// Each SMIL is read once, however many headings point into it.
	const smilNames = [...new Set(headings.map((h) => h.href))].filter((name) => /\.smil$/i.test(name));
	const smils = new Map<string, SmilDocument>();
	await Promise.all(
		smilNames.map(async (name) => {
			try {
				smils.set(name, parseSmil(await readDaisyFile(path.join(volumePath, name))));
			} catch {
				// A missing or unreadable SMIL simply drops the headings pointing at it.
			}
		})
	);
	if (smils.size === 0) return buildPlainFolder(volumePath, timelineStart);

	const files = new Map<string, ChapteredFile>();
	/** Absolute start of each clip, per SMIL. */
	const clipStarts = new Map<string, number[]>();
	let cursor = timelineStart;

	for (const name of smilNames) {
		const smil = smils.get(name);
		if (!smil) continue;

		// `ncc:totalElapsedTime` is the book's own record of where this SMIL begins;
		// trust it when present, and accumulate clip lengths when it isn't.
		const smilStart = smil.elapsed !== null ? timelineStart + smil.elapsed : cursor;
		let running = smilStart;
		const starts: number[] = [];

		for (const audio of smil.audios) {
			starts.push(running);

			const relPath = toRelativePath(path.join(volumePath, audio.file));
			const readUntil = audio.clipEnd ?? audio.clipBegin;
			const existing = files.get(relPath);
			if (existing) {
				existing.duration = Math.max(existing.duration, readUntil);
			} else {
				files.set(relPath, { path: relPath, duration: readUntil, startTime: running - audio.clipBegin });
			}

			running += clipDuration(audio) ?? 0;
		}

		clipStarts.set(name, starts);
		cursor = smil.duration !== null ? smilStart + smil.duration : running;
	}

	const chapters: Chapter[] = [];
	for (const heading of headings) {
		const smil = smils.get(heading.href);
		if (!smil || smil.audios.length === 0) continue;

		const index = (heading.fragment ? smil.byId.get(heading.fragment) : undefined) ?? 0;
		const audio = smil.audios[index];
		if (!audio) continue;

		chapters.push({
			title: heading.title,
			startTime: clipStarts.get(heading.href)?.[index] ?? timelineStart,
			filePath: toRelativePath(path.join(volumePath, audio.file)),
			fileStartTime: audio.clipBegin,
			level: heading.level
		});
	}
	if (chapters.length === 0) return buildPlainFolder(volumePath, timelineStart);

	chapters.sort((a, b) => a.startTime - b.startTime);
	for (let i = 0; i < chapters.length - 1; i++) {
		chapters[i].endTime = chapters[i + 1].startTime;
	}

	const ordered = [...files.values()].sort((a, b) => a.startTime - b.startTime);
	await fillMissingDurations(ordered);

	// The navigation's own total wins when present — it accounts for audio the
	// SMILs never reference (lead-ins, trailing silence).
	const declaredTotal = metaSeconds(navigation, 'ncc:totalTime');
	const measuredTotal = ordered.reduce((end, file) => Math.max(end, file.startTime + file.duration), timelineStart);
	const duration = Math.max(declaredTotal ?? 0, measuredTotal - timelineStart);
	chapters[chapters.length - 1].endTime = timelineStart + duration;

	return {
		chapters,
		files: ordered,
		duration,
		title: metaContent(navigation, 'dc:title') ?? /<title>([\s\S]*?)<\/title>/i.exec(navigation)?.[1]?.trim(),
		author: metaContent(navigation, 'dc:creator')
	};
}

/** Any gaps in the clip times (a SMIL without `clip-end`) fall back to the audio. */
async function fillMissingDurations(files: ChapteredFile[]): Promise<void> {
	const unknown = files.filter((file) => file.duration <= 0).map((file) => file.path);
	if (unknown.length === 0) return;

	const durations = await getDurations(unknown);
	for (const file of files) {
		if (file.duration <= 0) file.duration = durations.get(file.path) ?? 0;
	}
}

/**
 * A folder with no usable navigation: audio files in natural order. Serves plain
 * `.CHAPTERED` folders, and is the fallback for a DAISY book whose navigation
 * can't be parsed. Durations come from the cached probe, so only the first open
 * of a folder pays for reading the files.
 */
async function buildPlainFolder(folderPath: string, timelineStart: number): Promise<VolumeResult | null> {
	let entries;
	try {
		entries = await fs.readdir(folderPath, { withFileTypes: true });
	} catch {
		return null;
	}

	const audioPaths = entries
		.filter((entry) => !entry.isDirectory() && isPlayableMedia(entry.name))
		.map((entry) => entry.name)
		.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
		.map((name) => toRelativePath(path.join(folderPath, name)));

	if (audioPaths.length === 0) return null;

	const durations = await getDurations(audioPaths);
	const files: ChapteredFile[] = [];
	const chapters: Chapter[] = [];
	let cursor = timelineStart;

	for (const relPath of audioPaths) {
		const duration = durations.get(relPath) ?? 0;
		files.push({ path: relPath, duration, startTime: cursor });
		chapters.push({
			title: path.basename(relPath, path.extname(relPath)),
			startTime: cursor,
			endTime: cursor + duration,
			filePath: relPath,
			fileStartTime: 0,
			level: 1
		});
		cursor += duration;
	}

	return { chapters, files, duration: cursor - timelineStart };
}

// MARK: - Public API

/**
 * Parsed books, invalidated by the navigation file's size/mtime. A DAISY book is
 * ~50 small reads to parse and doesn't change between plays, so every open after
 * the first becomes a map lookup.
 */
const bookCache = new Map<string, { key: string; book: DaisyBook }>();
const BOOK_CACHE_LIMIT = 32;

async function cacheKey(folderPath: string, volumePaths: string[]): Promise<string> {
	const stamps = await Promise.all(
		[folderPath, ...volumePaths].map(async (dir) => {
			const marker = await findMarker(dir);
			if (!marker) return `${dir}:none`;
			try {
				const stat = await fs.stat(marker);
				return `${marker}:${stat.size}:${Math.round(stat.mtimeMs)}`;
			} catch {
				return `${marker}:gone`;
			}
		})
	);
	return stamps.join('|');
}

export async function parseDaisyBook(folderPath: string): Promise<DaisyBook | null> {
	try {
		const volumePaths = await getVolumeSubdirectories(folderPath);
		const key = await cacheKey(folderPath, volumePaths);
		const cached = bookCache.get(folderPath);
		if (cached?.key === key) return cached.book;

		let book: DaisyBook | null = null;
		if (volumePaths.length > 0) {
			book = await parseMultiVolume(folderPath, volumePaths);
		} else {
			const volume = await parseVolume(folderPath, 0);
			if (volume) {
				book = {
					title: volume.title || path.basename(folderPath),
					author: volume.author,
					totalDuration: volume.duration,
					chapters: volume.chapters,
					files: volume.files
				};
			}
		}

		if (book) {
			// Oldest-inserted entry goes first; the working set is a handful of books.
			if (bookCache.size >= BOOK_CACHE_LIMIT) {
				const oldest = bookCache.keys().next().value;
				if (oldest !== undefined) bookCache.delete(oldest);
			}
			bookCache.set(folderPath, { key, book });
		}
		return book;
	} catch {
		return null;
	}
}

async function parseMultiVolume(folderPath: string, volumePaths: string[]): Promise<DaisyBook | null> {
	const volumes: DaisyVolume[] = [];
	const chapters: Chapter[] = [];
	const files: ChapteredFile[] = [];
	let title: string | undefined;
	let author: string | undefined;
	let totalDuration = 0;

	// Volumes play back to back, so each starts where the previous one ended.
	for (const volumePath of volumePaths) {
		const volume = await parseVolume(volumePath, totalDuration);
		if (!volume || volume.chapters.length === 0) continue;

		volumes.push({ name: path.basename(volumePath), path: volumePath, chapters: volume.chapters });
		chapters.push(...volume.chapters);
		files.push(...volume.files);
		title ??= volume.title;
		author ??= volume.author;
		totalDuration += volume.duration;
	}

	if (chapters.length === 0) return null;

	return { title: title || path.basename(folderPath), author, totalDuration, chapters, files, volumes };
}

/**
 * The unified view the API serves: a DAISY book when the folder has navigation,
 * otherwise the plain file order of a `.CHAPTERED` folder.
 */
export async function getChapteredBook(folderPath: string): Promise<ChapteredBook | null> {
	if (await isDaisyBook(folderPath)) {
		const book = await parseDaisyBook(folderPath);
		if (book && book.chapters.length > 0) {
			return {
				type: 'daisy',
				title: book.title,
				author: book.author,
				totalDuration: book.totalDuration,
				files: book.files,
				chapters: book.chapters
			};
		}
	}

	const folder = await buildPlainFolder(folderPath, 0);
	if (!folder) return null;

	return {
		type: 'chaptered',
		title: path.basename(folderPath),
		totalDuration: folder.duration,
		files: folder.files,
		chapters: folder.chapters
	};
}
