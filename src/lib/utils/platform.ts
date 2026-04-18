import { browser } from '$app/environment';

export function isIOS(): boolean {
	if (!browser) return false;
	if (/iPad|iPhone|iPod/.test(navigator.userAgent)) return true;
	if (navigator.maxTouchPoints > 1 && /Macintosh/.test(navigator.userAgent)) return true;
	return false;
}
