import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { db } from '$server/db';
import { protectedPaths } from '$server/db/schema';
import { eq } from 'drizzle-orm';
import { env } from '$env/dynamic/private';

/**
 * GET /api/protect?path=<path>
 * Check if a path is protected
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const path = url.searchParams.get('path');

	if (!path) {
		throw error(400, 'Path is required');
	}

	// Must be unlocked to check protection status
	const unlocked = cookies.get('unlocked') === env.PROTECT_KEYWORD;
	if (!unlocked) {
		throw error(403, 'Not authorized');
	}

	const result = await db.select().from(protectedPaths).where(eq(protectedPaths.path, path));
	return json({ protected: result.length > 0 });
};

/**
 * POST /api/protect
 * Toggle protection on a path
 * Body: { path: string }
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	// Must be unlocked to toggle protection
	const unlocked = cookies.get('unlocked') === env.PROTECT_KEYWORD;
	if (!unlocked) {
		throw error(403, 'Not authorized');
	}

	const body = await request.json();
	const { path } = body;

	if (!path) {
		throw error(400, 'Path is required');
	}

	// Check if already protected
	const existing = await db.select().from(protectedPaths).where(eq(protectedPaths.path, path));

	if (existing.length > 0) {
		// Unprotect
		await db.delete(protectedPaths).where(eq(protectedPaths.path, path));
		return json({ protected: false });
	} else {
		// Protect
		await db.insert(protectedPaths).values({ path });
		return json({ protected: true });
	}
};

