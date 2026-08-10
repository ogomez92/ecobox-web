import { i18n } from '../i18n/index.svelte';

export function formatBytes(bytes: number): string {
	if (bytes === 0) return '0 B';

	const units = ['B', 'KB', 'MB', 'GB', 'TB'];
	const k = 1024;
	const i = Math.floor(Math.log(bytes) / Math.log(k));

	return `${(bytes / Math.pow(k, i)).toFixed(i > 0 ? 1 : 0)} ${units[i]}`;
}

export function formatDuration(seconds: number): string {
	if (!seconds || !isFinite(seconds)) return '--:--';

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	if (hours > 0) {
		return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
	}
	return `${minutes}:${secs.toString().padStart(2, '0')}`;
}

export function formatDurationAccessible(seconds: number): string {
	if (!seconds || !isFinite(seconds)) return i18n.t('player.durationUnknown');

	const hours = Math.floor(seconds / 3600);
	const minutes = Math.floor((seconds % 3600) / 60);
	const secs = Math.floor(seconds % 60);

	const parts: string[] = [];
	if (hours > 0) {
		parts.push(i18n.t(hours === 1 ? 'player.hour' : 'player.hours', { n: hours }));
	}
	if (minutes > 0) {
		parts.push(i18n.t(minutes === 1 ? 'player.minute' : 'player.minutes', { n: minutes }));
	}
	if (secs > 0 && hours === 0) {
		parts.push(i18n.t(secs === 1 ? 'player.second' : 'player.seconds', { n: secs }));
	}

	return parts.join(', ') || i18n.t('player.seconds', { n: 0 });
}

function localeTag(): string {
	return i18n.locale;
}

export function formatDate(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleDateString(localeTag(), {
		year: 'numeric',
		month: 'short',
		day: 'numeric'
	});
}

/**
 * "3 minutes ago" / "yesterday" for anything inside the last week, and a plain
 * date beyond that — the point of a recent list is recency, and "6 days ago"
 * reads better than a date, while "37 days ago" reads worse than one.
 *
 * Used for both the visible text and the accessible name, so a screen reader
 * hears exactly what is on screen. `now` is injectable for tests.
 */
export function formatRelativeTime(date: Date | string, now: number = Date.now()): string {
	const then = new Date(date).getTime();
	if (!isFinite(then)) return '';

	const diffSeconds = (then - now) / 1000;
	const absolute = Math.abs(diffSeconds);
	const WEEK = 7 * 24 * 3600;
	if (absolute >= WEEK) return formatDate(date);

	try {
		const rtf = new Intl.RelativeTimeFormat(localeTag(), { numeric: 'auto' });
		if (absolute < 60) return rtf.format(Math.round(diffSeconds), 'second');
		if (absolute < 3600) return rtf.format(Math.round(diffSeconds / 60), 'minute');
		if (absolute < 24 * 3600) return rtf.format(Math.round(diffSeconds / 3600), 'hour');
		return rtf.format(Math.round(diffSeconds / (24 * 3600)), 'day');
	} catch {
		return formatDate(date);
	}
}

export function formatDateAccessible(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleDateString(localeTag(), {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}
