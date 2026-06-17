/**
 * Runtime grouping of sentence chunks into larger synthesis "units" for AI TTS
 * services (more context = better prosody, fewer requests). This is a pure view
 * over the immutable chunk list — the stored reading position stays the canonical
 * sentence index, so grouping never affects saved positions or the convert pipeline.
 *
 * Indices here are positions in the `chunks` array (which equals each chunk's `i`).
 */
import type { Chunk } from '$lib/types';

export interface Unit {
	/** First chunk index in the unit (inclusive). */
	startIndex: number;
	/** Last chunk index in the unit (inclusive). */
	endIndex: number;
	/** The unit's spoken text (its sentences joined). */
	text: string;
}

/**
 * Group consecutive sentence chunks into units. A unit never crosses a paragraph
 * boundary (`para` change) or a heading (headings are their own unit), and never
 * exceeds `maxChars` (a single over-long sentence still becomes its own unit —
 * sentences are never split).
 */
export function groupChunks(chunks: Chunk[], maxChars: number): Unit[] {
	const units: Unit[] = [];
	let cur: { start: number; end: number; parts: string[]; len: number; para: number } | null = null;

	const flush = () => {
		if (cur) {
			units.push({ startIndex: cur.start, endIndex: cur.end, text: cur.parts.join(' ') });
			cur = null;
		}
	};

	for (let k = 0; k < chunks.length; k++) {
		const c = chunks[k];
		if (c.type === 'heading') {
			flush();
			units.push({ startIndex: k, endIndex: k, text: c.text });
			continue;
		}
		if (cur && (c.para !== cur.para || cur.len + c.text.length + 1 > maxChars)) {
			flush();
		}
		if (!cur) {
			cur = { start: k, end: k, parts: [c.text], len: c.text.length, para: c.para };
		} else {
			cur.parts.push(c.text);
			cur.len += c.text.length + 1;
			cur.end = k;
		}
	}
	flush();
	return units;
}

/** Identity grouping: one unit per chunk (used by the Web Speech engine). */
export function singletonUnits(chunks: Chunk[]): Unit[] {
	return chunks.map((c, k) => ({ startIndex: k, endIndex: k, text: c.text }));
}

/** Binary-search the unit whose [startIndex, endIndex] contains chunk index `i`. */
export function unitForChunk(units: Unit[], i: number): number {
	let lo = 0;
	let hi = units.length - 1;
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		const u = units[mid];
		if (i < u.startIndex) hi = mid - 1;
		else if (i > u.endIndex) lo = mid + 1;
		else return mid;
	}
	return Math.max(0, Math.min(units.length - 1, lo));
}
