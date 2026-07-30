/**
 * Case- and accent-insensitive folding for text matching.
 *
 * Lowercases, then decomposes (NFD) and strips combining marks, so "Capítulo"
 * matches "capitulo" and vice-versa. Shared by the book reader's find and the
 * file-browser search (client and server), so both behave identically.
 *
 * The fold is length-preserving for precomposed input, which is what lets the
 * highlighters slice the original string by folded indices.
 */
export function foldForSearch(s: string): string {
	return s.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
}
