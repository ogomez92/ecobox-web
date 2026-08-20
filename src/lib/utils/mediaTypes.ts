/**
 * What this app considers playable, by file extension. Pure — no server imports —
 * because both sides need the same answer: the server tags directory listings and
 * decides what to extract audio from, the client picks the next track in a folder
 * and offers the "Extract audio" action.
 *
 * Video is a first-class citizen but is never *shown*: a video file is loaded into
 * the same `<audio>` element as everything else, which decodes the audio track and
 * has no rendering surface for the picture. That works only for containers the
 * browser can actually demux, hence the split below.
 */

/** Audio containers the browser plays directly. */
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.wav', '.flac'];

/**
 * Video containers a browser can demux, so `<audio src="movie.mp4">` plays their
 * audio track as-is. They are left alone on upload; extracting their audio is
 * still offered by hand, since streaming a 4 GB file to hear 100 MB of audio is
 * wasteful even when it works.
 */
export const PLAYABLE_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov', '.webm'];

/**
 * Video containers no browser will open. These are auto-converted to an audio
 * file on upload (the original is deleted once the result verifies) — otherwise
 * they would sit in the library as permanently unplayable rows.
 */
export const CONVERTIBLE_VIDEO_EXTENSIONS = [
	'.mkv',
	'.avi',
	'.wmv',
	'.flv',
	'.f4v',
	'.ts',
	'.m2ts',
	'.mts',
	'.mpg',
	'.mpeg',
	'.mpv',
	'.vob',
	'.ogv',
	'.3gp',
	'.3g2',
	'.asf',
	'.divx',
	'.rm',
	'.rmvb'
];

export const VIDEO_EXTENSIONS = [...PLAYABLE_VIDEO_EXTENSIONS, ...CONVERTIBLE_VIDEO_EXTENSIONS];

/** Lowercased extension including the dot, or '' when the name has none. */
export function extensionOf(filename: string): string {
	const slash = Math.max(filename.lastIndexOf('/'), filename.lastIndexOf('\\'));
	const name = slash >= 0 ? filename.slice(slash + 1) : filename;
	const dot = name.lastIndexOf('.');
	// A leading dot is a hidden file (".CHAPTERED"), not an extension.
	return dot > 0 ? name.slice(dot).toLowerCase() : '';
}

export function isAudioExtension(filename: string): boolean {
	return AUDIO_EXTENSIONS.includes(extensionOf(filename));
}

export function isVideoExtension(filename: string): boolean {
	return VIDEO_EXTENSIONS.includes(extensionOf(filename));
}

/** A video whose audio the browser can play without transcoding it first. */
export function isPlayableVideoExtension(filename: string): boolean {
	return PLAYABLE_VIDEO_EXTENSIONS.includes(extensionOf(filename));
}

/** A video that must be converted before it can be played at all. */
export function needsAudioExtraction(filename: string): boolean {
	return CONVERTIBLE_VIDEO_EXTENSIONS.includes(extensionOf(filename));
}

/**
 * Anything the player can open right now — what "the next track in this folder"
 * means, and what a plain `.CHAPTERED` folder counts as a chapter.
 */
export function isPlayableMedia(filename: string): boolean {
	const ext = extensionOf(filename);
	return AUDIO_EXTENSIONS.includes(ext) || PLAYABLE_VIDEO_EXTENSIONS.includes(ext);
}
