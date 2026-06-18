/**
 * ELF pronunciation dictionary — a server-side text-substitution pass applied to
 * ELF input text *before* it is handed to `eci_synth`.
 *
 * Why this exists in TypeScript rather than via the engine's own dictionary API:
 * the ported ECI engine's native dictionary loader (`NewDict`/`LoadDict`/`SetDict`,
 * wired in `elf/src/eci/engine.c`) is non-functional here — loading the bundled
 * `.dic` files reports success but the entries are silently ignored, and loading
 * edited/custom `.dic` files segfaults the synthesizer. However, every replacement
 * form in those files (plain respellings like `s n e s`, stress hints like `` `1 A K A ``,
 * and phoneme overrides like `` `[f1ub2ar] ``) takes effect when sent as ordinary
 * *input text*, because the engine runs with `eciInputType=1` and interprets the
 * backtick annotations from the text stream. So we apply the dictionary ourselves.
 *
 * The dictionary is selected by the **language of the ELF voice in use** (parsed from
 * the voiceId, e.g. "Reed-en-US" → langid "enu"), NOT the book's language. Files live
 * at `<ELF_DIR>/lib/dictionaries/<langid>{main,root,abbr}.dic`. This composes with the
 * engine's abbreviation-off policy (`eciDictionary=1`): the engine never guesses
 * abbreviations, but the user's own curated entries still apply because the engine only
 * ever sees the already-substituted text.
 */
import path from 'path';
import fs from 'fs/promises';
import { dictionariesDir } from './elf';

/**
 * IETF tag (lowercased) → ECI langid, the 3-char `.dic` filename prefix. Mirrors the
 * `langid` column of `elf/src/eci/languages.c` `g_langs`. Region-less primaries map to
 * the engine's default dialect for that language (CJK is intentionally absent — those
 * modules are gated out of the engine).
 */
const LANGID_BY_TAG: Record<string, string> = {
	'en-us': 'enu',
	en: 'enu',
	'en-gb': 'eng',
	'es-es': 'esp',
	es: 'esp',
	'es-mx': 'esm',
	'fr-fr': 'fra',
	fr: 'fra',
	'fr-ca': 'frc',
	'de-de': 'deu',
	de: 'deu',
	'it-it': 'ita',
	it: 'ita',
	'pt-br': 'ptb',
	pt: 'ptb',
	'fi-fi': 'fin',
	fi: 'fin'
};

/**
 * "Reed-en-US" → "enu". Preset names contain no '-', so everything after the first '-'
 * is the IETF tag. Returns null when the voice's language has no mapped dictionary.
 */
export function langidForVoiceId(voiceId: string): string | null {
	if (!voiceId) return null;
	const dash = voiceId.indexOf('-');
	if (dash < 0) return null;
	const tag = voiceId.slice(dash + 1).toLowerCase();
	return LANGID_BY_TAG[tag] ?? null;
}

/** Parse one `.dic` volume: `key<TAB>value` per line (CRLF or LF). */
export function parseDict(contents: string): Map<string, string> {
	const map = new Map<string, string>();
	for (const line of contents.split(/\r?\n/)) {
		const tab = line.indexOf('\t');
		if (tab <= 0) continue; // no tab, or empty key
		const key = line.slice(0, tab);
		// Preserve the value verbatim (incl. ` annotations and internal spaces); only
		// trim trailing whitespace/CR.
		const value = line.slice(tab + 1).replace(/\s+$/, '');
		if (!value) continue;
		map.set(key, value);
	}
	return map;
}

function escapeRe(s: string): string {
	return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Compile a single-pass, case-sensitive, whole-word replacer from a merged dict map.
 * The alphanumeric look-around gives whole-word matching that still works for keys that
 * contain punctuation: `St` is not replaced inside `Start`, but `Govt` matches in `Govt.`
 * and `P!nk` matches as written. Keys are sorted longest-first so e.g. `Airbnbs` wins
 * over `Airbnb`. A function replacer is used so `$` in values isn't interpreted.
 */
export function buildReplacer(map: Map<string, string>): (text: string) => string {
	if (map.size === 0) return (t) => t;
	const keys = [...map.keys()].sort((a, b) => b.length - a.length);
	const re = new RegExp(
		'(?<![A-Za-z0-9])(?:' + keys.map(escapeRe).join('|') + ')(?![A-Za-z0-9])',
		'g'
	);
	return (text) => text.replace(re, (m) => map.get(m) ?? m);
}

const VOLUMES = ['main', 'root', 'abbr'] as const;
// Merge order: later wins. abbr → main → root, so a phonetic (root) override beats a
// main/abbr entry for the same key (key conflicts across volumes are rare).
const MERGE_ORDER = [2, 0, 1];

type Cached = { mtimes: number[]; replace: (t: string) => string };
const cache = new Map<string, Cached>();

/** Load + memoize the merged replacer for a langid, re-reading when a file's mtime changes. */
async function loadForLangid(langid: string): Promise<(t: string) => string> {
	const dir = dictionariesDir();
	const files = VOLUMES.map((v) => path.join(dir, `${langid}${v}.dic`));
	const mtimes = await Promise.all(
		files.map(async (f) => {
			try {
				return (await fs.stat(f)).mtimeMs;
			} catch {
				return 0; // missing volume
			}
		})
	);

	const hit = cache.get(langid);
	if (hit && hit.mtimes.length === mtimes.length && hit.mtimes.every((m, i) => m === mtimes[i])) {
		return hit.replace;
	}

	const merged = new Map<string, string>();
	for (const i of MERGE_ORDER) {
		if (mtimes[i] === 0) continue;
		let contents: string;
		try {
			// One volume is ISO-8859 — read as latin1 so high bytes round-trip through the
			// UTF-8 → cp1252 path inside eci_synth.
			contents = await fs.readFile(files[i], 'latin1');
		} catch {
			continue;
		}
		for (const [k, v] of parseDict(contents)) merged.set(k, v);
	}

	const replace = buildReplacer(merged);
	cache.set(langid, { mtimes, replace });
	return replace;
}

/**
 * Rewrite `text` using the pronunciation dictionary for the ELF voice's language.
 * No-op (returns the input unchanged) when the voice has no mapped language or no dict
 * files exist for it.
 */
export async function applyElfDictionary(voiceId: string, text: string): Promise<string> {
	if (!text) return text;
	const langid = langidForVoiceId(voiceId);
	if (!langid) return text;
	const replace = await loadForLangid(langid);
	return replace(text);
}
