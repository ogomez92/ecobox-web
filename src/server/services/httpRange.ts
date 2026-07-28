/**
 * Conditional + partial-content helpers for byte-range media serving (RFC 7233).
 *
 * Kept out of the route so the parsing rules are unit-testable — getting these
 * subtly wrong doesn't fail loudly, it hands a client bytes it can't use.
 */

export interface ByteRange {
	start: number;
	end: number;
}

/**
 * RFC 7233 §3.2 — `If-Range` means "send me the partial content **only if** it's
 * still the representation I already hold; otherwise send the whole new thing".
 *
 * This matters when a file is replaced at the same path (delete + re-upload):
 * without it, the server happily answers a range request with bytes from the
 * *new* file, the client splices them into its cached copy of the *old* one, and
 * playback dies mid-file at the seam with a decode error.
 *
 * Only a strong validator may be used here, so a weak (`W/`-prefixed) entity-tag
 * never matches. A date validator compares at second granularity, since that's
 * all an HTTP-date carries.
 */
export function ifRangeMatches(ifRange: string, etag: string, mtime: Date): boolean {
	const value = ifRange.trim();
	if (!value) return false;

	// Weak validators are unusable for If-Range; check before the entity-tag case
	// because `W/"…"` also contains a quote.
	if (value.startsWith('W/')) return false;
	if (value.startsWith('"')) return value === etag;

	const date = new Date(value);
	if (Number.isNaN(date.getTime())) return false;
	return date.getTime() === Math.floor(mtime.getTime() / 1000) * 1000;
}

/**
 * Parse a single-range `Range` header against a known representation size.
 *
 * Returns the resolved range, or `null` when the range is unsatisfiable (the
 * caller should answer 416). A header we can't parse at all yields `undefined`,
 * meaning "ignore the Range and send the full body" — RFC 7233 §3.1 requires an
 * unrecognised range unit be ignored rather than treated as an error.
 *
 * Handles the three forms:
 *   `bytes=N-M`  explicit range; M past the end is **clamped**, not rejected
 *                (§2.1) — Safari and some iOS clients routinely overshoot.
 *   `bytes=N-`   open-ended, to the last byte.
 *   `bytes=-N`   suffix: the final N bytes.
 *
 * Multi-range headers (`bytes=0-9,20-29`) would require a multipart/byteranges
 * response; we serve only the first range, which browsers never rely on for
 * media playback.
 */
export function parseRangeHeader(rangeHeader: string, size: number): ByteRange | null | undefined {
	const match = rangeHeader.match(/^bytes=(\d*)-(\d*)/);
	if (!match) return undefined;

	const [, firstRaw, lastRaw] = match;
	if (firstRaw === '' && lastRaw === '') return undefined;

	// An empty representation can't satisfy any range.
	if (size === 0) return null;

	if (firstRaw === '') {
		// Suffix range: the last N bytes. A suffix longer than the file is the
		// whole file, and a zero-length suffix is unsatisfiable.
		const suffix = parseInt(lastRaw, 10);
		if (suffix === 0) return null;
		return { start: Math.max(0, size - suffix), end: size - 1 };
	}

	const start = parseInt(firstRaw, 10);
	if (start >= size) return null;

	const end = lastRaw === '' ? size - 1 : Math.min(parseInt(lastRaw, 10), size - 1);
	if (start > end) return null;

	return { start, end };
}
