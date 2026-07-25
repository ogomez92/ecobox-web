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
	/** Character count of the spoken (converted) text. */
	mdChars: number;
	/** Sentence chunks — the canonical reading positions. */
	totalChunks: number;
	/** Number of headings, i.e. chapters. */
	chapters: number;
	/** ISO timestamp of conversion ('' if unknown). */
	convertedAt: string;
}

export interface Chapter {
	title: string;
	/**
	 * Start of the chapter on the book's timeline. For a single file that is simply
	 * the offset within it; for a multi-file book (DAISY, chaptered folder) it is
	 * absolute across the whole book, i.e. `file.startTime + fileStartTime`.
	 */
	startTime: number;
	endTime?: number;
	filePath?: string; // For multi-file chapters (DAISY)
	/**
	 * Offset of the chapter *within* `filePath` — what a player seeks to once that
	 * file is loaded. Absent for single-file chapters, where `startTime` already is
	 * the in-file offset.
	 */
	fileStartTime?: number;
	/** DAISY heading depth (1–6), for rendering a nested table of contents. */
	level?: number;
}

/** One audio file of a multi-file book, placed on the book's timeline. */
export interface ChapteredFile {
	/** Path relative to MEDIA_ROOT — ready for `/api/media/<path>`. */
	path: string;
	/** Length in seconds; 0 when it could not be determined. */
	duration: number;
	/** Absolute offset of this file's start on the book timeline. */
	startTime: number;
}

export interface DaisyBook {
	title: string;
	author?: string;
	narrator?: string;
	totalDuration: number;
	chapters: Chapter[];
	/** Playback order, with each file's duration and place on the timeline. */
	files: ChapteredFile[];
	volumes?: DaisyVolume[];
}

export interface DaisyVolume {
	name: string;
	path: string;
	chapters: Chapter[];
}

/** A bookmark inside a multi-file book: a file plus an offset within it. */
export interface ChapteredBookmark {
	id: number;
	folderPath: string;
	filePath: string;
	time: number;
	label: string | null;
	createdAt?: string | number;
}

/** Response of `GET /api/chaptered/book` — everything needed to open a book. */
export interface ChapteredBookManifest {
	/** `'file'` means the path is a plain audio file, not a book folder. */
	type: 'daisy' | 'chaptered' | 'file';
	title?: string;
	author?: string;
	totalDuration?: number;
	files?: ChapteredFile[];
	chapters?: Chapter[];
	metadata?: {
		currentFilePath: string | null;
		currentFilePosition: number;
		totalDuration: number | null;
	};
	bookmarks?: ChapteredBookmark[];
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
 * `elf` and `piper` are fully local engines bundled with the app (no API key, no
 * network); `piper` is neural and reads user-imported voice models.
 */
export type TtsService =
	| 'webspeech'
	| 'elevenlabs'
	| 'azure'
	| 'azure-edge'
	| 'google'
	| 'elf'
	| 'piper';
/** Services that synthesize server-side and have a persisted credentials row. */
export type TtsAudioService = Exclude<TtsService, 'webspeech'>;

/**
 * Subscription character quota for the cloud services that expose a usable
 * per-key usage endpoint. Currently only ElevenLabs (GET /v1/user/subscription);
 * Azure and Google report usage only through cloud billing/metrics APIs that need
 * ARM credentials rather than the synthesis key, so they have no quota here.
 */
export interface TtsQuota {
	/** Characters consumed in the current billing period. */
	used: number;
	/** Characters allowed in the current billing period. */
	limit: number;
	/** limit − used, clamped at 0. */
	remaining: number;
	/** Unix seconds when the count resets, when the provider reports it. */
	resetUnix?: number;
}

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
	/** ELF: when true, `elfParams` override the voice preset's built-in knobs. */
	elfCustomize: boolean;
	/** ELF voice parameter overrides (ignored by other services). */
	elfParams: ElfVoiceParams;
}

/**
 * ELF (local engine) voice parameter overrides. Each is 0–100 and maps to an ECI
 * voice knob; they override the selected voice preset's built-in values and are
 * only applied when the service's `elfCustomize` flag is on.
 */
export interface ElfVoiceParams {
	/** Vocal-tract size — lower is thinner/smaller, higher is fuller. */
	headSize: number;
	/** Pitch baseline — overall voice height. */
	pitch: number;
	/** Pitch fluctuation — intonation range (flat → expressive). */
	inflection: number;
	/** Rasp/gravel in the voice. */
	roughness: number;
	/** Aspiration/airiness in the voice. */
	breathiness: number;
	/** Output loudness. */
	volume: number;
}

/**
 * Neutral ELF starting point used to seed the sliders when a user first turns
 * customization on. Volume defaults to 100 (loudest) — the ELF adapter also
 * applies volume 100 by default even when customization is off.
 */
export const DEFAULT_ELF_VOICE_PARAMS: ElfVoiceParams = {
	headSize: 50,
	pitch: 65,
	inflection: 30,
	roughness: 0,
	breathiness: 0,
	volume: 100
};

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

export const TTS_AUDIO_SERVICES: TtsAudioService[] = [
	'elevenlabs',
	'azure',
	'azure-edge',
	'google',
	'elf',
	'piper'
];

/** Audio services that need no credentials (keyless / fully local). */
export const TTS_KEYLESS_SERVICES: TtsAudioService[] = ['azure-edge', 'elf', 'piper'];

/**
 * Services that bake the reading rate into synthesis — re-synthesizing the unit when
 * the rate changes — instead of time-stretching the finished MP3 via
 * `<audio>.playbackRate`. These are the fully local engines, where re-synthesis is
 * free and higher-fidelity than stretching: ELF is a formant voice (stretching smears
 * its consonants) and Piper is neural but re-paces natively via `--length_scale`. The
 * remote/cloud services (ElevenLabs/Azure/azure-edge/Google) stretch instead, because
 * re-synthesizing would re-bill or add latency. Rate is folded into the cache key only
 * for these (a rate change must miss the cache); for stretch services one MP3 serves
 * every speed. Also drives the engine's `liveRate` flag (false here → reader re-speaks).
 */
export const TTS_BAKED_RATE_SERVICES: TtsAudioService[] = ['elf', 'piper'];

/** True when the service synthesizes at the requested rate (see TTS_BAKED_RATE_SERVICES). */
export function bakesRate(service: TtsAudioService): boolean {
	return TTS_BAKED_RATE_SERVICES.includes(service);
}

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
	/** Winamp-style transport keys (x/c/v/b/z) in the media player and book reader. Opt-in. */
	winampShortcuts: boolean;
	/** Auto-advance to the next file in the same folder when a single track finishes. Opt-in. */
	autoAdvanceTracks: boolean;
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
	winampShortcuts: false,
	autoAdvanceTracks: false,
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
