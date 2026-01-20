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

export interface Settings {
	seekInterval: number;
	longSeekInterval: number;
	createBookmarkOnPause: boolean;
	audioEffectsEnabled: boolean;
	radioResumeBehavior: 'always' | 'never' | 'ask';
	theme: 'light' | 'dark' | 'system';
	autoplay: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
	seekInterval: 5,
	longSeekInterval: 30,
	createBookmarkOnPause: false,
	audioEffectsEnabled: false,
	radioResumeBehavior: 'ask',
	theme: 'system',
	autoplay: true
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
