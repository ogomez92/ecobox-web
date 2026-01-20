import { json, error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { resolvePath } from '$server/services/files';
import fs from 'node:fs/promises';

export interface RadioStation {
	url: string;
	name?: string;
	auth?: {
		username: string;
		password: string;
	};
}

/**
 * POST /api/radio
 * Creates a new .radio file
 * Body: { path: string, url: string, name?: string, username?: string, password?: string }
 */
export const POST: RequestHandler = async ({ request }) => {
	const body = await request.json();
	const { path: filePath, url: streamUrl, name, username, password } = body;

	if (!filePath || !streamUrl) {
		throw error(400, 'Path and URL are required');
	}

	// Ensure .radio extension
	const radioPath = filePath.endsWith('.radio') ? filePath : `${filePath}.radio`;
	const resolvedPath = resolvePath(radioPath);

	// Build file content
	const lines: string[] = [`url=${streamUrl}`];
	if (name) lines.push(`name=${name}`);
	if (username) lines.push(`username=${username}`);
	if (password) lines.push(`password=${password}`);

	const content = lines.join('\n') + '\n';

	try {
		// Ensure parent directory exists
		const parentDir = resolvedPath.substring(0, resolvedPath.lastIndexOf('/'));
		await fs.mkdir(parentDir, { recursive: true });

		await fs.writeFile(resolvedPath, content, 'utf-8');
		return json({ success: true, path: radioPath });
	} catch (err) {
		console.error('Failed to create radio file:', err);
		throw error(500, 'Failed to create radio file');
	}
};

/**
 * GET /api/radio?path=<radio_file_path>
 * Parses a .radio file and returns the stream URL
 */
export const GET: RequestHandler = async ({ url }) => {
	const filePath = url.searchParams.get('path');

	if (!filePath) {
		throw error(400, 'Path parameter is required');
	}

	const resolvedPath = resolvePath(filePath);

	if (!resolvedPath.endsWith('.radio')) {
		throw error(400, 'Not a radio file');
	}

	try {
		const content = await fs.readFile(resolvedPath, 'utf-8');
		const station = parseRadioFile(content, filePath);
		const streamUrl = buildStreamUrl(station);

		return json({
			url: streamUrl,
			name: station.name || filePath.split('/').pop()?.replace('.radio', '') || 'Radio Station'
		});
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw error(404, 'Radio file not found');
		}
		throw error(500, 'Failed to read radio file');
	}
};

/**
 * Parse a .radio file to extract stream URL and optional auth
 * Format:
 *   url=https://stream.example.com/live
 *   username=optional_user
 *   password=optional_pass
 *   name=Station Name
 */
function parseRadioFile(content: string, filePath: string): RadioStation {
	const lines = content.split('\n');
	const data: Record<string, string> = {};

	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith('#')) continue;

		const eqIndex = trimmed.indexOf('=');
		if (eqIndex > 0) {
			const key = trimmed.slice(0, eqIndex).trim().toLowerCase();
			const value = trimmed.slice(eqIndex + 1).trim();
			data[key] = value;
		}
	}

	const station: RadioStation = {
		url: data.url || '',
		name: data.name || filePath.split('/').pop()?.replace('.radio', '')
	};

	if (data.username && data.password) {
		station.auth = {
			username: data.username,
			password: data.password
		};
	}

	return station;
}

/**
 * Build a stream URL with optional Basic Auth
 */
function buildStreamUrl(station: RadioStation): string {
	if (!station.auth) {
		return station.url;
	}

	// Insert credentials into URL for Basic Auth
	try {
		const url = new URL(station.url);
		url.username = station.auth.username;
		url.password = station.auth.password;
		return url.toString();
	} catch {
		return station.url;
	}
}
