/**
 * UI-only book metadata for the Book info modal.
 *
 * Kept deliberately separate from /api/books/content (which existing apps
 * consume) so this never changes that contract. GET assembles a BookInfo from
 * the book folder's `book.chunks.json` + `.BOOK` marker; PUT overrides the
 * book's language (the canonical chunk positions are never touched).
 */
import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import fs from 'fs/promises';
import path from 'path';
import { resolvePath, BOOK_MARKER } from '$server/services/files';
import { readBookMarker, type BookMarker } from '$server/services/bookConvert';
import type { BookInfo, BookLocaleSource, Chunk } from '$lib/types';

/** Whitespace word count — a display stat (undercounts unspaced scripts, like the marker). */
function wordCount(text: string): number {
	const m = text.trim().match(/\S+/g);
	return m ? m.length : 0;
}

/** Permissive BCP-47-ish validation (e.g. 'en', 'es', 'zh-Hans', 'pt-BR'). */
function isValidLocale(s: string): boolean {
	return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/.test(s) && s.length <= 35;
}

function resolveBookFolder(rawPath: string | null): string {
	if (!rawPath) throw error(400, 'Path is required');
	try {
		return resolvePath(rawPath.normalize('NFC'));
	} catch (err) {
		const msg = err instanceof Error ? err.message : '';
		if (msg.includes('traversal')) throw error(403, 'Forbidden');
		throw error(500, 'Bad path');
	}
}

/** Assemble the BookInfo for a resolved book folder (marker is best-effort). */
async function buildInfo(folderAbs: string): Promise<BookInfo> {
	let parsed: { title?: string; locale?: string; chunks?: Chunk[] };
	try {
		const raw = await fs.readFile(path.join(folderAbs, 'book.chunks.json'), 'utf-8');
		parsed = JSON.parse(raw);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw error(404, 'Book not found');
		throw error(500, 'Failed to read book');
	}

	const chunks = parsed.chunks ?? [];
	const chapters = chunks.reduce((n, c) => n + (c.type === 'heading' ? 1 : 0), 0);
	const mdWordsFromChunks = chunks.reduce((n, c) => n + wordCount(c.text), 0);
	// Character count is a display-only stat; the marker never stored it, so it's
	// always derived from the live chunk text.
	const mdChars = chunks.reduce((n, c) => n + c.text.length, 0);

	const marker = await readBookMarker(folderAbs);
	return {
		title: parsed.title ?? '',
		locale: parsed.locale ?? marker?.locale ?? 'en',
		localeSource: (marker?.localeSource ?? 'unknown') as BookLocaleSource,
		verified: marker?.verified ?? false,
		sourceWords: marker?.sourceWords ?? 0,
		mdWords: marker?.mdWords ?? mdWordsFromChunks,
		mdChars,
		totalChunks: chunks.length,
		chapters,
		convertedAt: marker?.convertedAt ?? ''
	};
}

export const GET: RequestHandler = async ({ url }) => {
	const folderAbs = resolveBookFolder(url.searchParams.get('path'));
	return json(await buildInfo(folderAbs));
};

/** Atomic-ish JSON write (temp + rename) so a reader never sees a partial file. */
async function writeJson(file: string, value: unknown): Promise<void> {
	const tmp = `${file}.${process.pid}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(value), 'utf-8');
	await fs.rename(tmp, file);
}

/**
 * PUT { path, locale } — override the book's language. Updates book.chunks.json
 * (what the reader/app consume) and the .BOOK marker (localeSource → 'manual').
 * Does NOT re-segment: the chunk list is the canonical position index.
 */
export const PUT: RequestHandler = async ({ request }) => {
	const body = (await request.json().catch(() => ({}))) as { path?: string; locale?: string };
	const folderAbs = resolveBookFolder(body.path ?? null);

	const locale = (body.locale ?? '').trim();
	if (!isValidLocale(locale)) throw error(400, 'Invalid language code');

	// Update the chunk file's locale, preserving title + chunks exactly.
	const chunksFile = path.join(folderAbs, 'book.chunks.json');
	let parsed: Record<string, unknown>;
	try {
		parsed = JSON.parse(await fs.readFile(chunksFile, 'utf-8'));
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') throw error(404, 'Book not found');
		throw error(500, 'Failed to read book');
	}
	parsed.locale = locale;
	await writeJson(chunksFile, parsed);

	// Update (or create) the marker so the modal + warning reflect the override.
	const existing = await readBookMarker(folderAbs);
	const chunks = (parsed.chunks as Chunk[]) ?? [];
	const marker: BookMarker = {
		verified: existing?.verified ?? false,
		sourceWords: existing?.sourceWords ?? 0,
		mdWords: existing?.mdWords ?? chunks.reduce((n, c) => n + wordCount(c.text), 0),
		totalChunks: existing?.totalChunks ?? chunks.length,
		locale,
		localeSource: 'manual',
		convertedAt: existing?.convertedAt ?? ''
	};
	await writeJson(path.join(folderAbs, BOOK_MARKER), marker);

	return json(await buildInfo(folderAbs));
};
