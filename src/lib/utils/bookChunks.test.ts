import { describe, it, expect } from 'vitest';
import { stripInline, stripHtml, stripMarkdownToPlain, splitIntoChunks } from './bookChunks';

describe('stripInline', () => {
	it('unwraps links and images to their text/alt', () => {
		expect(stripInline('see [the docs](https://x.com)')).toBe('see the docs');
		expect(stripInline('![a cat](cat.png)')).toBe('a cat');
	});

	it('removes emphasis and code markers', () => {
		expect(stripInline('a **bold** and `code` word')).toBe('a bold and code word');
	});

	it('un-escapes pandoc backslash escapes', () => {
		expect(stripInline('Mr\\. Smith said \\[hi\\]')).toBe('Mr. Smith said [hi]');
	});
});

describe('stripHtml', () => {
	it('removes tags but keeps their text content', () => {
		expect(stripHtml('<span id="a.xhtml"></span>Hello <em>world</em>').trim()).toBe(
			'Hello  world'.trim()
		);
		expect(stripHtml('<div class="sinopsis">').trim()).toBe('');
	});

	it('strips multi-attribute and self-closing tags (e.g. epub cover svg)', () => {
		const svg = '<svg xmlns="http://x" viewbox="0 0 1 1"><image xlink:href="../c.jpg"></image></svg>';
		expect(stripHtml(svg).trim()).toBe('');
	});

	it('decodes the common entities pandoc emits', () => {
		expect(stripHtml('Tom &amp; Jerry &lt;3 &quot;hi&quot;')).toBe('Tom & Jerry <3 "hi"');
	});
});

describe('stripMarkdownToPlain', () => {
	it('strips headings, lists and rules', () => {
		const md = '# Chapter One\n\n- first\n- second\n\n---\n\nA paragraph.';
		const out = stripMarkdownToPlain(md);
		expect(out).toContain('Chapter One');
		expect(out).toContain('first');
		expect(out).not.toContain('#');
		expect(out).not.toContain('---');
	});

	it('drops fenced code blocks', () => {
		const md = 'Before.\n\n```\ncode();\n```\n\nAfter.';
		const out = stripMarkdownToPlain(md);
		expect(out).toContain('Before.');
		expect(out).toContain('After.');
		expect(out).not.toContain('code()');
	});
});

describe('splitIntoChunks', () => {
	it('keeps a heading as one chunk and sentence-splits paragraphs', () => {
		const md = '# Chapter One\n\nIt was a bright cold day. The clocks struck thirteen.';
		const chunks = splitIntoChunks(md, 'en');
		expect(chunks).toHaveLength(3);
		expect(chunks[0]).toMatchObject({ i: 0, para: 0, type: 'heading', text: 'Chapter One' });
		expect(chunks[1]).toMatchObject({ i: 1, para: 1, type: 'paragraph' });
		expect(chunks[2]).toMatchObject({ i: 2, para: 1, type: 'paragraph' });
		expect(chunks[1].text).toContain('bright cold day');
		expect(chunks[2].text).toContain('thirteen');
	});

	it('produces a stable, gapless global index', () => {
		const md = '# A\n\nOne. Two.\n\n# B\n\nThree.';
		const chunks = splitIntoChunks(md, 'en');
		expect(chunks.map((c) => c.i)).toEqual([0, 1, 2, 3, 4]);
		// para increments per source block
		expect(chunks.map((c) => c.para)).toEqual([0, 1, 1, 2, 3]);
		expect(chunks.filter((c) => c.type === 'heading').map((c) => c.text)).toEqual(['A', 'B']);
	});

	it('drops empty/markup-only blocks', () => {
		const md = 'Real text.\n\n---\n\n![](only-image.png)';
		const chunks = splitIntoChunks(md, 'en');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe('Real text.');
	});

	it('drops raw-HTML-only blocks and strips inline tags from prose', () => {
		const md =
			'<span id="cubierta.xhtml"></span>\n\n<div class="sinopsis">\n\n' +
			'A real <em>sentence</em> survives.\n\n</div>';
		const chunks = splitIntoChunks(md, 'en');
		expect(chunks).toHaveLength(1);
		expect(chunks[0].text).toBe('A real sentence survives.');
		expect(chunks.some((c) => c.text.includes('<'))).toBe(false);
	});
});
