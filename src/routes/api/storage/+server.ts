import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getStorageInfo } from '$server/services/files';

export const GET: RequestHandler = async () => {
	try {
		const storage = await getStorageInfo();
		return json(storage);
	} catch (err) {
		throw error(500, 'Failed to get storage info');
	}
};
