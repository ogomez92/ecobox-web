import { en, type MessageKey } from './locales/en';
import { es } from './locales/es';
import { fr } from './locales/fr';
import { de } from './locales/de';
import { ru } from './locales/ru';
import { ja } from './locales/ja';
import { zh } from './locales/zh';

export type LocaleCode = 'en' | 'es' | 'fr' | 'de' | 'ru' | 'ja' | 'zh';

export const SUPPORTED_LOCALES: LocaleCode[] = ['en', 'es', 'fr', 'de', 'ru', 'ja', 'zh'];

export const LOCALE_NAMES: Record<LocaleCode, string> = {
	en: 'English',
	es: 'Español',
	fr: 'Français',
	de: 'Deutsch',
	ru: 'Русский',
	ja: '日本語',
	zh: '中文'
};

const dictionaries: Record<LocaleCode, Record<MessageKey, string>> = {
	en,
	es,
	fr,
	de,
	ru,
	ja,
	zh
};

const STORAGE_KEY = 'ecobox-locale';

function detectFromBrowser(): LocaleCode {
	if (typeof navigator === 'undefined') return 'en';
	const candidates = navigator.languages?.length ? navigator.languages : [navigator.language];
	for (const tag of candidates) {
		if (!tag) continue;
		const base = tag.toLowerCase().split('-')[0];
		if ((SUPPORTED_LOCALES as string[]).includes(base)) {
			return base as LocaleCode;
		}
	}
	return 'en';
}

function readStored(): LocaleCode | null {
	if (typeof localStorage === 'undefined') return null;
	try {
		const v = localStorage.getItem(STORAGE_KEY);
		if (v && (SUPPORTED_LOCALES as string[]).includes(v)) {
			return v as LocaleCode;
		}
	} catch {
		// ignore
	}
	return null;
}

class I18nStore {
	// Default to 'en' on SSR; client overrides in init().
	locale = $state<LocaleCode>('en');
	// Whether locale was set explicitly by the user (vs. browser-detected).
	isExplicit = $state(false);

	init() {
		const stored = readStored();
		if (stored) {
			this.locale = stored;
			this.isExplicit = true;
		} else {
			this.locale = detectFromBrowser();
			this.isExplicit = false;
		}
		this.syncDocumentLang();
	}

	setLocale(code: LocaleCode | null) {
		if (code === null) {
			// Reset to browser detection
			try {
				localStorage.removeItem(STORAGE_KEY);
			} catch {
				// ignore
			}
			this.locale = detectFromBrowser();
			this.isExplicit = false;
		} else {
			try {
				localStorage.setItem(STORAGE_KEY, code);
			} catch {
				// ignore
			}
			this.locale = code;
			this.isExplicit = true;
		}
		this.syncDocumentLang();
	}

	private syncDocumentLang() {
		if (typeof document !== 'undefined') {
			document.documentElement.lang = this.locale;
		}
	}

	t(key: MessageKey, params?: Record<string, string | number>): string {
		const dict = dictionaries[this.locale] ?? en;
		const template = dict[key] ?? en[key] ?? key;
		if (!params) return template;
		return template.replace(/\{(\w+)\}/g, (_, name) => {
			const value = params[name];
			return value === undefined ? `{${name}}` : String(value);
		});
	}
}

export const i18n = new I18nStore();

// Convenience: bound translator that reads `i18n.locale` reactively when called.
export function t(key: MessageKey, params?: Record<string, string | number>): string {
	return i18n.t(key, params);
}
