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

export function formatDateAccessible(date: Date | string): string {
	const d = new Date(date);
	return d.toLocaleDateString(localeTag(), {
		weekday: 'long',
		year: 'numeric',
		month: 'long',
		day: 'numeric'
	});
}
