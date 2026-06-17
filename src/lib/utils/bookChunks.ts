/**
 * Pure markdown -> plain spoken-text chunking. No server imports, so it is unit
 * testable and could run client-side too. Used by the server conversion pipeline
 * (bookConvert) to build the canonical book.chunks.json.
 */
import type { Chunk } from '$lib/types';

/** Source formats that can be converted into a readable (TTS) book. v2 adds '.pdf'. */
export const BOOK_EXTENSIONS = ['.epub', '.docx', '.txt'];

export function isBookExtension(filename: string): boolean {
	const dot = filename.lastIndexOf('.');
	const ext = dot >= 0 ? filename.slice(dot).toLowerCase() : '';
	return BOOK_EXTENSIONS.includes(ext);
}

/**
 * Strip raw HTML tags/comments and decode the common entities pandoc may emit.
 * EPUBs routinely carry inline HTML (cover <svg>, <div>/<span> chapter wrappers)
 * that pandoc passes through verbatim into GFM; without this the tags get read
 * aloud as text. Runs in addition to the `gfm-raw_html` writer flag as a safety net.
 */
export function stripHtml(text: string): string {
	return text
		.replace(/<!--[\s\S]*?-->/g, ' ') // HTML comments
		.replace(/<\/?[a-zA-Z][^>]*>/g, ' ') // open / close / self-closing tags
		.replace(/&nbsp;/gi, ' ')
		.replace(/&lt;/gi, '<')
		.replace(/&gt;/gi, '>')
		.replace(/&quot;/gi, '"')
		.replace(/&#0*39;|&apos;/gi, "'")
		.replace(/&amp;/gi, '&'); // decode ampersand last
}

/** Strip inline markdown (links, images, emphasis, code, escapes) to plain text. */
export function stripInline(text: string): string {
	return text
		.replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1') // image -> alt text
		.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // inline link -> text
		.replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1') // reference link -> text
		.replace(/[`*]/g, '') // emphasis / inline-code markers
		.replace(/\\([\\`*_{}[\]()#+\-.!>])/g, '$1'); // un-escape pandoc backslash escapes
}

/** Strip one markdown block (paragraph, heading, list, quote, table row) to plain text. */
function stripBlockToPlain(block: string, isHeading: boolean): string {
	const lines = block
		.split('\n')
		.map((line) => {
			let l = line;
			if (isHeading) l = l.replace(/^\s*#{1,6}\s*/, '').replace(/\s*#+\s*$/, '');
			l = l.replace(/^\s*>+\s?/, ''); // blockquote
			l = l.replace(/^\s*[-*+]\s+/, ''); // bullet list
			l = l.replace(/^\s*\d+[.)]\s+/, ''); // ordered list
			return l;
		})
		// Drop rule/table-separator-only lines (e.g. "---", "|---|:--|").
		.filter((l) => !/^[\s>|:*_+=-]*$/.test(l));
	let text = lines.join(' ').replace(/\|/g, ' ');
	text = stripHtml(text);
	text = stripInline(text);
	return text.replace(/\s+/g, ' ').trim();
}

function splitBlocks(markdown: string): string[] {
	// Drop fenced code blocks entirely — we don't read code aloud.
	const noCode = markdown
		.replace(/```[\s\S]*?```/g, '\n\n')
		.replace(/~~~[\s\S]*?~~~/g, '\n\n');
	return noCode
		.split(/\n{2,}/)
		.map((b) => b.trim())
		.filter(Boolean);
}

/** Whole-document plain text (used by tests / debugging). */
export function stripMarkdownToPlain(markdown: string): string {
	return splitBlocks(markdown)
		.map((b) => stripBlockToPlain(b, /^#{1,6}\s+/.test(b)))
		.filter(Boolean)
		.join('\n');
}

function makeSegmenter(locale: string): Intl.Segmenter {
	try {
		return new Intl.Segmenter(locale, { granularity: 'sentence' });
	} catch {
		return new Intl.Segmenter('en', { granularity: 'sentence' });
	}
}

/**
 * Split markdown into the canonical chunk list. Each non-heading block is
 * sentence-segmented; headings are kept whole (chapter titles read as one chunk).
 * `para` increments per source block; `i` is a global running index.
 */
export function splitIntoChunks(markdown: string, locale: string): Chunk[] {
	const chunks: Chunk[] = [];
	const segmenter = makeSegmenter(locale);
	let i = 0;
	let para = 0;

	for (const block of splitBlocks(markdown)) {
		const isHeading = /^#{1,6}\s+/.test(block) || /^#{1,6}$/.test(block);
		const plain = stripBlockToPlain(block, isHeading);
		if (!plain) continue;

		if (isHeading) {
			chunks.push({ i: i++, text: plain, para, type: 'heading' });
		} else {
			for (const seg of segmenter.segment(plain)) {
				const text = seg.segment.trim();
				if (text) chunks.push({ i: i++, text, para, type: 'paragraph' });
			}
		}
		para++;
	}

	return chunks;
}
