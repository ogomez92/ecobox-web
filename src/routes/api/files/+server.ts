import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDirectory, deleteFile } from '$server/services/files';
import { db } from '$server/db';
import { protectedPaths } from '$server/db/schema';
import { env } from '$env/dynamic/private';

// Check if a path or any of its ancestors is protected
function isPathProtected(path: string, protectedSet: Set<string>): boolean {
	if (!path) return false;

	// Check exact path
	if (protectedSet.has(path)) return true;

	// Check ancestors
	const pathParts = path.split('/').filter(Boolean);
	for (let i = 1; i <= pathParts.length; i++) {
		const ancestorPath = pathParts.slice(0, i).join('/');
		if (protectedSet.has(ancestorPath)) return true;
	}

	return false;
}

export const GET: RequestHandler = async ({ url, cookies }) => {
	const path = url.searchParams.get('path') || '';

	// Check if user is unlocked
	const unlocked = cookies.get('unlocked') === env.PROTECT_KEYWORD;

	// Get protected paths
	const protectedList = await db.select().from(protectedPaths);
	const protectedSet = new Set(protectedList.map(p => p.path));

	// If not unlocked and trying to access a protected path, pretend it doesn't exist
	if (!unlocked && path && isPathProtected(path, protectedSet)) {
		throw error(404, 'Directory not found');
	}

	try {
		let files = await listDirectory(path);

		// Filter protected paths if not unlocked, or mark them if unlocked
		if (!unlocked) {
			files = files.filter(file => {
				// Check if this exact path is protected
				if (protectedSet.has(file.path)) return false;

				// Check if any ancestor is protected
				const pathParts = file.path.split('/');
				for (let i = 1; i < pathParts.length; i++) {
					const ancestorPath = pathParts.slice(0, i).join('/');
					if (protectedSet.has(ancestorPath)) return false;
				}

				return true;
			});
		}

		// Add isProtected flag to each file (only matters when unlocked)
		const filesWithProtection = files.map(file => ({
			...file,
			isProtected: protectedSet.has(file.path)
		}));

		return json({
			files: filesWithProtection,
			unlocked
		});
	} catch (err) {
		if ((err as Error).message === 'Directory not found') {
			throw error(404, 'Directory not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Failed to list directory');
	}
};

export const DELETE: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path');

	if (!path) {
		throw error(400, 'Path is required');
	}

	try {
		await deleteFile(path);
		return json({ success: true });
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'File not found');
		}
		if ((err as Error).message.includes('traversal')) {
			throw error(403, 'Access denied');
		}
		throw error(500, 'Failed to delete file');
	}
};
