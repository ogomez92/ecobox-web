/**
 * Book conversion pipeline: source file -> markdown -> plain sentence chunks.
 *
 * Flow (see convertBook): dispatch by extension to produce GFM markdown (pandoc for
 * epub/docx; txt is already plain) -> strip markdown to plain spoken text and
 * sentence-split with Intl.Segmenter into a canonical chunk list -> independently
 * verify -> write a book folder (book.md + book.chunks.json + .BOOK marker). On a
 * verify PASS the original source is deleted; on FAIL the original is moved inside
 * the folder and the book is marked unverified. Conversion fails safe: if pandoc is
 * missing or errors, nothing is deleted.
 *
 * The converter dispatch is keyed by extension so v2 can register '.pdf' (with OCR)
 * without touching the orchestrator.
 */
import { execFile } from 'child_process';
import { promisify } from 'util';
import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import { resolvePath, getRelativePath, BOOK_MARKER } from './files';
import { countWords, sourceWordCount, verifyPass } from './bookVerify';
import { splitIntoChunks } from '$lib/utils/bookChunks';
import type { BookLocaleSource } from '$lib/types';

const execFileAsync = promisify(execFile);

export type ConvertStatus = 'verified' | 'unverified' | 'failed';

export interface ConvertResult {
	status: ConvertStatus;
	folderPath?: string;
	mdWords: number;
	sourceWords: number;
	totalChunks: number;
	reason?: string;
}

/** Contents of the .BOOK marker file (JSON). */
export interface BookMarker {
	verified: boolean;
	sourceWords: number;
	mdWords: number;
	totalChunks: number;
	locale: string;
	/**
	 * How `locale` was obtained: 'detected' (read from EPUB metadata), 'default'
	 * (no detection — fell back to 'en', e.g. docx/txt or a tag-less epub), or
	 * 'manual' (set by the user in the Book info modal). Drives the UI-only
	 * "language not detected" warning. Older markers omit it (treated as 'unknown').
	 */
	localeSource: BookLocaleSource;
	convertedAt: string;
}

// ---------------------------------------------------------------------------
// Source -> markdown converters (pluggable by extension)
// ---------------------------------------------------------------------------

interface RawConversion {
	markdown: string;
	locale: string;
	/** Whether `locale` came from real detection ('detected') or a fallback ('default'). */
	localeSource: 'detected' | 'default';
	ok: boolean;
	/** A concise, user-facing cause when ok=false (e.g. "pandoc is not installed"). */
	reason?: string;
}

/**
 * Convert a document to GFM markdown via pandoc. Never throws; on failure returns
 * `{ markdown: null }` plus a concise `reason` that distinguishes the cases that
 * matter to the user — pandoc not installed, the document too large to convert (the
 * memory-heavy path that can OOM on big EPUBs), or a pandoc read/parse error.
 */
async function runPandoc(absInputPath: string): Promise<{ markdown: string | null; reason?: string }> {
	try {
		const { stdout } = await execFileAsync(
			'pandoc',
			// gfm-raw_html disables raw-HTML passthrough so EPUB markup (cover <svg>,
			// <div>/<span> wrappers) is dropped rather than read aloud verbatim.
			[absInputPath, '-t', 'gfm-raw_html', '--wrap=none'],
			{ maxBuffer: 256 * 1024 * 1024 }
		);
		return { markdown: stdout };
	} catch (err) {
		console.error('pandoc conversion failed:', err);
		const e = err as NodeJS.ErrnoException & { stderr?: string };
		if (e.code === 'ENOENT') return { markdown: null, reason: 'pandoc is not installed on the server' };
		// The exact code differs by Node version (…STDOUT_MAXBUFFER / …STDIO_MAXBUFFER),
		// so match the family plus the message as a fallback.
		if (/MAXBUFFER/.test(e.code ?? '') || /maxBuffer/i.test(e.message ?? ''))
			return { markdown: null, reason: 'the document is too large to convert' };
		// pandoc ran but exited non-zero (malformed/unsupported document) — surface its
		// first line of output, which usually names the problem.
		const firstLine = (e.stderr || e.message || '').split('\n').find((l) => l.trim())?.trim();
		return { markdown: null, reason: firstLine ? `pandoc could not read it (${firstLine})` : 'pandoc could not read the document' };
	}
}

/**
 * Read the epub package document and extract the primary <dc:language>.
 * `detected` reports whether a real tag was found (vs. the 'en' fallback).
 */
async function detectEpubLanguage(absInputPath: string): Promise<{ locale: string; detected: boolean }> {
	try {
		const buf = await fs.readFile(absInputPath);
		const zip = await JSZip.loadAsync(buf);
		const opf = Object.values(zip.files).find((f) => /\.opf$/i.test(f.name));
		if (!opf) return { locale: 'en', detected: false };
		const xml = await opf.async('string');
		const match = xml.match(/<dc:language[^>]*>\s*([^<\s]+)/i);
		return match ? { locale: match[1].trim(), detected: true } : { locale: 'en', detected: false };
	} catch {
		return { locale: 'en', detected: false };
	}
}

const converters: Record<string, (absPath: string) => Promise<RawConversion>> = {
	'.epub': async (absPath) => {
		const { markdown, reason } = await runPandoc(absPath);
		const { locale, detected } = await detectEpubLanguage(absPath);
		return {
			markdown: markdown ?? '',
			locale,
			localeSource: detected ? 'detected' : 'default',
			ok: markdown !== null,
			reason
		};
	},
	'.docx': async (absPath) => {
		const { markdown, reason } = await runPandoc(absPath);
		// pandoc converts the text but we don't extract docx language → fall back.
		return { markdown: markdown ?? '', locale: 'en', localeSource: 'default', ok: markdown !== null, reason };
	},
	'.txt': async (absPath) => {
		try {
			const markdown = await fs.readFile(absPath, 'utf-8');
			return { markdown, locale: 'en', localeSource: 'default', ok: true };
		} catch (err) {
			console.error('txt read failed:', err);
			return { markdown: '', locale: 'en', localeSource: 'default', ok: false, reason: 'could not read the text file' };
		}
	}
};

// ---------------------------------------------------------------------------
// Orchestrator
// ---------------------------------------------------------------------------

/**
 * Convert a raw book file into a book folder. v1 runs synchronously; the v2 OCR
 * path can wrap this behind a background job at the route layer (dispatchConvert).
 */
export async function convertBook(relInputPath: string): Promise<ConvertResult> {
	const absInput = resolvePath(relInputPath);
	const ext = path.extname(relInputPath).toLowerCase();
	const converter = converters[ext];
	if (!converter) {
		return { status: 'failed', mdWords: 0, sourceWords: 0, totalChunks: 0, reason: `Unsupported format ${ext}` };
	}

	const { markdown, locale, localeSource, ok: pandocOk, reason: convReason } = await converter(absInput);
	if (!pandocOk) {
		// Conversion itself failed (pandoc missing/errored, unreadable file) — keep the
		// original untouched and tell the user the specific cause.
		return {
			status: 'failed',
			mdWords: 0,
			sourceWords: 0,
			totalChunks: 0,
			reason: convReason ?? 'pandoc could not convert the document (is pandoc installed?)'
		};
	}

	const chunks = splitIntoChunks(markdown, locale);
	const mdWords = chunks.reduce((sum, c) => sum + countWords(c.text), 0);

	// No readable text came out (e.g. an image-only or all-boilerplate document):
	// don't create an empty, unreadable book folder — keep the original so nothing
	// is lost and the user can retry or convert it differently.
	if (chunks.length === 0) {
		return {
			status: 'failed',
			mdWords: 0,
			sourceWords: 0,
			totalChunks: 0,
			reason: 'no readable text was found in the document'
		};
	}

	let sourceWords = 0;
	try {
		sourceWords = await sourceWordCount(absInput);
	} catch (err) {
		console.error('Source word count failed:', err);
	}

	const passed = verifyPass({ mdWords, sourceWords, pandocOk });

	// Build the book folder: same directory, name = source basename without extension.
	const dir = path.dirname(relInputPath);
	const title = path.basename(relInputPath, path.extname(relInputPath));
	const folderRel = dir === '.' ? title : path.join(dir, title);
	const folderAbs = resolvePath(folderRel);

	// Note whether the folder already existed: on a write failure we only roll back a
	// folder WE created, never one that holds pre-existing user content.
	let folderPreexisted = true;
	try {
		await fs.access(folderAbs);
	} catch {
		folderPreexisted = false;
	}

	const marker: BookMarker = {
		verified: passed,
		sourceWords,
		mdWords,
		totalChunks: chunks.length,
		locale,
		localeSource,
		convertedAt: new Date().toISOString()
	};

	try {
		await fs.mkdir(folderAbs, { recursive: true });
		await fs.writeFile(path.join(folderAbs, 'book.md'), markdown, 'utf-8');
		await fs.writeFile(
			path.join(folderAbs, 'book.chunks.json'),
			JSON.stringify({ title, locale, chunks }),
			'utf-8'
		);
		await fs.writeFile(path.join(folderAbs, BOOK_MARKER), JSON.stringify(marker), 'utf-8');
	} catch (err) {
		console.error('Failed to write book folder:', err);
		// Roll back a partially-written folder so a retry starts clean. The original
		// source is still in place (we delete/move it only after this block succeeds).
		if (!folderPreexisted) await fs.rm(folderAbs, { recursive: true, force: true }).catch(() => {});
		return {
			status: 'failed',
			mdWords,
			sourceWords,
			totalChunks: chunks.length,
			reason: 'could not write the book files (out of disk space or a permissions problem?)'
		};
	}

	if (passed) {
		// Verified — reclaim the original. A failure here is non-fatal: the book is
		// already written, so log and keep the (now redundant) original rather than
		// reporting the whole conversion as failed.
		await fs.unlink(absInput).catch((err) => console.error('Failed to remove original after verify:', err));
	} else {
		// Unverified — retain the original inside the folder (hidden from listings).
		try {
			await fs.rename(absInput, path.join(folderAbs, path.basename(relInputPath)));
		} catch (err) {
			console.error('Failed to retain original inside book folder:', err);
		}
	}

	return {
		status: passed ? 'verified' : 'unverified',
		folderPath: getRelativePath(folderAbs),
		mdWords,
		sourceWords,
		totalChunks: chunks.length,
		reason: passed
			? undefined
			: `Verify failed (md ${mdWords} words vs source ${sourceWords}); original kept.`
	};
}

/** Read and parse a book folder's .BOOK marker, or null if absent/unreadable. */
export async function readBookMarker(folderAbsPath: string): Promise<BookMarker | null> {
	try {
		const raw = await fs.readFile(path.join(folderAbsPath, BOOK_MARKER), 'utf-8');
		return JSON.parse(raw) as BookMarker;
	} catch {
		return null;
	}
}
