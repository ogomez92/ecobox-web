import type { RadioStation } from '$lib/types';

/**
 * Parse a .radio file to extract stream URL and optional auth
 * Format:
 *   url=https://stream.example.com/live
 *   username=optional_user
 *   password=optional_pass
 *   name=Station Name
 */
export function parseRadioFile(content: string): RadioStation {
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
		name: data.name
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
export function buildStreamUrl(station: RadioStation): string {
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

/**
 * Check if a stream URL is responsive
 */
export async function checkStreamHealth(url: string): Promise<boolean> {
	try {
		const controller = new AbortController();
		const timeoutId = setTimeout(() => controller.abort(), 5000);

		const response = await fetch(url, {
			method: 'HEAD',
			signal: controller.signal
		});

		clearTimeout(timeoutId);
		return response.ok;
	} catch {
		return false;
	}
}
