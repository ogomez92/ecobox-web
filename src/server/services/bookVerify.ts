/**
 * Independent verification of a book conversion.
 *
 * The verify gate decides whether the original source file may be deleted after
 * conversion. To be meaningful it MUST measure the source independently of pandoc:
 * if pandoc silently drops a chapter, a pandoc-derived count would drop it too and
 * the check would falsely pass. So source word counts come from jszip (epub) /
 * mammoth (docx) / the file itself (txt) — never from pandoc.
 *
 * Gate: pass when pandoc succeeded, the markdown is non-empty, and the markdown
 * word count is at least 90% of the independently-measured source word count.
 * The dangerous failure mode is truncation (md much smaller than source), so the
 * load-bearing check is a one-sided lower bound; a two-sided band would false-fail
 * constantly on boilerplate (cover/nav/front-matter) that pandoc legitimately drops.
 */
import fs from 'fs/promises';
import path from 'path';
import JSZip from 'jszip';
import mammoth from 'mammoth';

/** Minimum ratio of markdown words to source words for a conversion to be trusted. */
export const VERIFY_MIN_RATIO = 0.9;

/** Count word-like tokens (Unicode letters/numbers), language-agnostic. */
export function countWords(text: string): number {
	const matches = text.match(/[\p{L}\p{N}]+/gu);
	return matches ? matches.length : 0;
}

/** Strip HTML/XHTML tags to plain text for counting (not for display). */
function stripHtml(html: string): string {
	return html
		.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, ' ')
		.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
		.replace(/<[^>]+>/g, ' ')
		.replace(/&[a-z]+;/gi, ' ');
}

/**
 * Source word count for an epub: sum words across all (x)html content documents
 * in the archive. Reading order is irrelevant for a total count, so we avoid the
 * fragility of OPF spine parsing and simply scan every content document.
 */
export async function sourceWordCountEpub(absPath: string): Promise<number> {
	const buf = await fs.readFile(absPath);
	const zip = await JSZip.loadAsync(buf);
	let total = 0;
	const entries = Object.values(zip.files).filter(
		(f) => !f.dir && /\.(x?html?|xml)$/i.test(f.name) && !/\bcontainer\.xml$/i.test(f.name)
	);
	for (const entry of entries) {
		// Skip the package document itself (.opf is xml but not content).
		if (/\.opf$/i.test(entry.name)) continue;
		const html = await entry.async('string');
		total += countWords(stripHtml(html));
	}
	return total;
}

/** Source word count for a docx via mammoth's raw-text extraction. */
export async function sourceWordCountDocx(absPath: string): Promise<number> {
	const result = await mammoth.extractRawText({ path: absPath });
	return countWords(result.value);
}

/** Source word count for a txt file — the file is its own ground truth. */
export async function sourceWordCountTxt(absPath: string): Promise<number> {
	const text = await fs.readFile(absPath, 'utf-8');
	return countWords(text);
}

/** Dispatch to the right counter by extension. Throws for unknown extensions. */
export async function sourceWordCount(absPath: string): Promise<number> {
	const ext = path.extname(absPath).toLowerCase();
	switch (ext) {
		case '.epub':
			return sourceWordCountEpub(absPath);
		case '.docx':
			return sourceWordCountDocx(absPath);
		case '.txt':
			return sourceWordCountTxt(absPath);
		default:
			throw new Error(`No source word counter for ${ext}`);
	}
}

export interface VerifyInput {
	mdWords: number;
	sourceWords: number;
	pandocOk: boolean;
}

/** The deletion gate: only true when the conversion is trustworthy. */
export function verifyPass({ mdWords, sourceWords, pandocOk }: VerifyInput): boolean {
	if (!pandocOk) return false;
	if (mdWords <= 0) return false;
	// A zero source count can't be a basis for trust — keep the original.
	if (sourceWords <= 0) return false;
	return mdWords >= VERIFY_MIN_RATIO * sourceWords;
}
