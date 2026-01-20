import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { listDirectoryRecursive } from '$server/services/files';

export const GET: RequestHandler = async ({ url }) => {
	const path = url.searchParams.get('path') || '';

	try {
		const files = await listDirectoryRecursive(path);
		return json(files);
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
