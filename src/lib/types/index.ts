export interface FileEntry {
	name: string;
	path: string;
	isDirectory: boolean;
	size: number;
	modifiedAt: Date;
	duration?: number;
	isChapteredFolder?: boolean;
	isDaisyBook?: boolean;
	isRadioFile?: boolean;
	isProtected?: boolean;
	/** A converted book folder (contains book.md + book.chunks.json + .BOOK marker). */
	isBookFolder?: boolean;
	/** A raw, not-yet-converted book file (.epub/.docx/.txt) that can be converted. */
	isRawBook?: boolean;
	/** For book folders: false when conversion passed verify only loosely (original kept). */
	bookVerified?: boolean;
}

/** One spoken unit of a converted book — a single sentence (or a heading line). */
export interface Chunk {
	/** Global, stable, zero-based index across the whole book (the position key). */
	i: number;
	/** Plain spoken text (markdown stripped). */
	text: string;
	/** Source block index (heading or paragraph) — used for paragraph jumps and result labels. */
	para: number;
	type: 'heading' | 'paragraph';
}

/** Payload returned by GET /api/books/content. */
export interface BookContent {
	title: string;
	locale: string;
	chunks: Chunk[];
}

/** How a book's language was determined ('unknown' = older book, never recorded). */
export type BookLocaleSource = 'detected' | 'default' | 'manual' | 'unknown';

/**
 * Rich book metadata for the Book info modal (GET /api/books/info). UI-only —
 * separate from the app-facing BookContent so existing clients are unaffected.
 */
export interface BookInfo {
	title: string;
	locale: string;
	localeSource: BookLocaleSource;
	verified: boolean;
	/** Word count of the source document (0 if unknown). */
	sourceWords: number;
	/** Word count of the spoken (converted) text. */
	mdWords: number;
	/** Sentence chunks — the canonical reading positions. */
	totalChunks: number;
	/** Number of headings, i.e. chapters. */
	chapters: number;
	/** ISO timestamp of conversion ('' if unknown). */
	convertedAt: string;
}

export interface Chapter {
	title: string;
	startTime: number;
	endTime?: number;
	filePath?: string; // For multi-file chapters (DAISY)
}

export interface DaisyBook {
	title: string;
	author?: string;
	narrator?: string;
	totalDuration: number;
	chapters: Chapter[];
	volumes?: DaisyVolume[];
}

export interface DaisyVolume {
	name: string;
	path: string;
	chapters: Chapter[];
}

export interface RadioStation {
	url: string;
	name?: string;
	auth?: {
		username: string;
		password: string;
	};
}

export interface PlaybackState {
	isPlaying: boolean;
	currentTime: number;
	duration: number;
	playbackRate: number;
	volume: number;
	currentFile: string | null;
	currentChapter: Chapter | null;
	chapters: Chapter[];
	isLoading: boolean;
	error: string | null;
}

export interface UploadNegotiateRequest {
	basePath: string;
	mode: 'copy' | 'sync';
	files: {
		path: string;
		size: number;
		hash?: string;
	}[];
}

export interface UploadNegotiateResponse {
	toUpload: string[];
	toDelete?: string[];
	newFiles: string[];
	conflicts: string[];
	identical: string[];
	extras: string[];
}

export interface StorageInfo {
	used: number;
	free: number;
	total: number;
}

export interface AudioEffects {
	enabled: boolean;
	eq: EQSettings;
	compressor: CompressorSettings;
	reverb: ReverbSettings;
	highPass: HighPassSettings;
	volumeBoost: VolumeBoostSettings;
	preset: EffectPreset;
}

export interface VolumeBoostSettings {
	enabled: boolean;
	gain: number; // 0 to 12 dB
}

export interface EQSettings {
	bands: EQBand[];
}

export interface EQBand {
	frequency: number;
	gain: number;
	q: number;
}

export interface CompressorSettings {
	threshold: number;
	ratio: number;
	attack: number;
	release: number;
	knee: number;
}

export interface ReverbSettings {
	enabled: boolean;
	wetDry: number;
}

export interface HighPassSettings {
	enabled: boolean;
	frequency: number;
}

export type EffectPreset = 'flat' | 'dialog' | 'bass' | 'treble' | 'custom';

/**
 * TTS service the reader uses. `webspeech` is the local browser engine (no server
 * config). The rest synthesize server-side and have persisted per-service config.
 * `azure-edge` is the keyless "Edge read-aloud" mode (no API key, experimental).
 */
export type TtsService = 'webspeech' | 'elevenlabs' | 'azure' | 'azure-edge' | 'google';
/** Services that synthesize server-side and have a persisted credentials row. */
export type TtsAudioService = Exclude<TtsService, 'webspeech'>;

/** A selectable voice, unified across providers (Web Speech voiceURI = id). */
export interface TtsVoice {
	id: string;
	name: string;
	/** BCP-47 where known, '' otherwise. */
	lang: string;
}

/**
 * Sanitized per-service config returned by GET /api/tts/config. The API key is
 * NEVER sent to the client — `configured` reports only whether one is stored.
 */
export interface TtsCredentialConfig {
	service: TtsAudioService;
	configured: boolean;
	region: string;
	model: string;
	voiceId: string;
	enabled: boolean;
	/** ElevenLabs voice_settings (ignored by other services). */
	voiceSettings: ElevenVoiceSettings;
}

/** Per-voice ElevenLabs rendering knobs — mirror the API's `voice_settings`. */
export interface ElevenVoiceSettings {
	/** 0–1. Lower = more expressive/variable, higher = more consistent. */
	stability: number;
	/** 0–1. How closely to adhere to the original voice. */
	similarityBoost: number;
	/** 0–1. Style exaggeration (0 = none; higher adds latency). */
	style: number;
	/** Boost similarity/clarity to the source speaker. */
	useSpeakerBoost: boolean;
}

/** ElevenLabs' own documented defaults — used when nothing is configured. */
export const DEFAULT_ELEVEN_VOICE_SETTINGS: ElevenVoiceSettings = {
	stability: 0.5,
	similarityBoost: 0.75,
	style: 0,
	useSpeakerBoost: true
};

export const TTS_AUDIO_SERVICES: TtsAudioService[] = ['elevenlabs', 'azure', 'azure-edge', 'google'];

/** Known ElevenLabs model ids (default first). */
export const ELEVEN_MODELS = [
	'eleven_multilingual_v2',
	'eleven_turbo_v2_5',
	'eleven_flash_v2_5',
	'eleven_v3'
] as const;
export const DEFAULT_ELEVEN_MODEL = 'eleven_multilingual_v2';

/**
 * Models that honor the `language_code` parameter. Other models ignore it (or
 * may reject it), so we only send it for these.
 * https://elevenlabs.io/docs/api-reference/text-to-speech/convert
 */
export const ELEVEN_LANG_CODE_MODELS: string[] = ['eleven_turbo_v2_5', 'eleven_flash_v2_5'];

export interface Settings {
	seekInterval: number;
	longSeekInterval: number;
	createBookmarkOnPause: boolean;
	audioEffectsEnabled: boolean;
	radioResumeBehavior: 'always' | 'never' | 'ask';
	theme: 'light' | 'dark' | 'system';
	autoplay: boolean;
	maskTitle: string;
	/** Default SonicRoom server origin for "Cast to call". */
	sonicroomUrl: string;
	/** Default reading rate for book reading (global; the reader slider persists here). */
	ttsRate: number;
	/** Selected TTS service for book reading (global). */
	ttsService: TtsService;
}

export const DEFAULT_SETTINGS: Settings = {
	seekInterval: 5,
	longSeekInterval: 30,
	createBookmarkOnPause: false,
	audioEffectsEnabled: false,
	radioResumeBehavior: 'ask',
	theme: 'system',
	autoplay: true,
	maskTitle: '',
	sonicroomUrl: '',
	ttsRate: 1.0,
	ttsService: 'webspeech'
};

export const DEFAULT_EQ_BANDS: EQBand[] = [
	{ frequency: 60, gain: 0, q: 1 },
	{ frequency: 230, gain: 0, q: 1 },
	{ frequency: 910, gain: 0, q: 1 },
	{ frequency: 3600, gain: 0, q: 1 },
	{ frequency: 8000, gain: 0, q: 1 },
	{ frequency: 14000, gain: 0, q: 1 }
];

export const DEFAULT_AUDIO_EFFECTS: AudioEffects = {
	enabled: false,
	eq: { bands: DEFAULT_EQ_BANDS },
	compressor: {
		threshold: -24,
		ratio: 4,
		attack: 0.003,
		release: 0.25,
		knee: 10
	},
	reverb: {
		enabled: false,
		wetDry: 0.3
	},
	highPass: {
		enabled: false,
		frequency: 80
	},
	volumeBoost: {
		enabled: false,
		gain: 0
	},
	preset: 'flat'
};
