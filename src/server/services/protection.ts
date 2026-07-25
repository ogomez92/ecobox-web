import { db } from '$server/db';
import { protectedPaths } from '$server/db/schema';
import { env } from '$env/dynamic/private';
import type { Cookies } from '@sveltejs/kit';

/**
 * Protected paths hide a subtree until the session is "unlocked" with the global
 * keyword. Protection is inherited: marking `secret` hides `secret/book/ch1.mp3`
 * too, so every check has to walk the ancestors, not just look the path up.
 */

/** True when this request may see protected content. */
export function isUnlocked(cookies: Cookies): boolean {
	return cookies.get('unlocked') === env.PROTECT_KEYWORD;
}

export async function getProtectedSet(): Promise<Set<string>> {
	const rows = await db.select().from(protectedPaths);
	return new Set(rows.map((row) => row.path));
}

/** True when `path` itself, or any ancestor of it, is protected. */
export function isPathProtected(path: string, protectedSet: Set<string>): boolean {
	if (!path || protectedSet.size === 0) return false;
	if (protectedSet.has(path)) return true;

	const parts = path.split('/').filter(Boolean);
	for (let i = 1; i < parts.length; i++) {
		if (protectedSet.has(parts.slice(0, i).join('/'))) return true;
	}

	return false;
}

/**
 * Whether a locked session is allowed to see `path`. Skips the database entirely
 * for unlocked sessions, which is the common case.
 */
export async function isPathHidden(path: string, cookies: Cookies): Promise<boolean> {
	if (isUnlocked(cookies)) return false;
	return isPathProtected(path, await getProtectedSet());
}
