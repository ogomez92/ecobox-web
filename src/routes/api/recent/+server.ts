import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath } from '$server/services/files';
import {
	DEFAULT_RECENT_LIMIT,
	MAX_RECENT,
	describePath,
	isRecentKind,
	listRecent,
	recordAccess
} from '$server/services/recentFiles';
import { getProtectedSet, isPathProtected, isUnlocked } from '$server/services/protection';

/**
 * GET /api/recent[?limit=n]
 *
 * The recently-opened list, newest first. Each entry carries a resolved `target`
 * — where it opens right now — so a locally deleted file still lands somewhere
 * sensible (its nearest surviving ancestor folder).
 *
 * Protected content is filtered exactly as in `/api/files`: a locked session
 * never sees a protected entry, and the fallback walk never routes it into a
 * protected folder either.
 */
export const GET: RequestHandler = async ({ url, cookies }) => {
	const requested = Number(url.searchParams.get('limit'));
	const limit =
		Number.isFinite(requested) && requested > 0
			? Math.min(Math.floor(requested), MAX_RECENT)
			: DEFAULT_RECENT_LIMIT;

	try {
		const unlocked = isUnlocked(cookies);
		const protectedSet = unlocked ? null : await getProtectedSet();
		const isHidden = protectedSet ? (p: string) => isPathProtected(p, protectedSet) : undefined;

		return json({ recent: await listRecent({ limit, isHidden }) });
	} catch (err) {
		console.error('Recent GET error:', err);
		throw error(500, 'Failed to load recent files');
	}
};

/**
 * POST /api/recent  { path, kind? }
 *
 * Records that a path was opened. `kind` is what the client already knows it
 * opened (it just loaded the manifest); when omitted it is read from disk.
 */
export const POST: RequestHandler = async ({ request, cookies }) => {
	let body: { path?: unknown; kind?: unknown };
	try {
		body = await request.json();
	} catch {
		throw error(400, 'Invalid JSON body');
	}

	const path = typeof body.path === 'string' ? body.path : '';
	if (!path) {
		throw error(400, 'Path is required');
	}

	try {
		resolvePath(path); // traversal guard
	} catch {
		throw error(403, 'Access denied');
	}

	// A locked session must not be able to write protected paths into a list it
	// would then be unable to see.
	if (!isUnlocked(cookies) && isPathProtected(path, await getProtectedSet())) {
		throw error(404, 'Not found');
	}

	try {
		const kind = isRecentKind(body.kind) ? body.kind : ((await describePath(path)) ?? 'file');
		await recordAccess({ path, kind });
		return json({ success: true });
	} catch (err) {
		console.error('Recent POST error:', err);
		throw error(500, 'Failed to record recent file');
	}
};
