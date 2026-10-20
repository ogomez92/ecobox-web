/**
 * Encode a POSIX relative media path for use in a route URL (`/play/…`,
 * `/browse/…`, `/read/…`): each segment is percent-encoded, the slashes kept.
 * Interpolating the raw path breaks on names with `%` (SvelteKit's `decodeURI`
 * throws on `50 %.mp3`), `#` or `?` (cut off as fragment / query).
 */
export function encodePathSegments(path: string): string {
	return path.split('/').map(encodeURIComponent).join('/');
}
