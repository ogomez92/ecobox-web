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
 *
 * Extension is necessary but not sufficient: the *codec inside* has to be
 * decodable too. See `isBrowserPlayableAudioCodec` — deciding that needs a probe,
 * so it lives on the server, but the codec list is here with everything else.
 */

/** Audio containers the browser plays directly. */
export const AUDIO_EXTENSIONS = ['.mp3', '.m4a', '.m4b', '.aac', '.ogg', '.opus', '.wav', '.flac'];

/**
 * Video containers a browser can demux, so `<audio src="movie.mp4">` reaches their
 * audio track — provided that track is in a codec it can decode, which upload
 * checks separately. Extracting the audio to its own file is still offered by
 * hand, since streaming a 4 GB file to hear 100 MB of audio is wasteful even when
 * it works.
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

/**
 * Video containers whose audio track can be re-encoded *in place*: the picture is
 * stream-copied, the audio is replaced, and the result keeps the same name. Only
 * the MP4 family qualifies — AAC has nowhere to live in a WebM.
 */
export const REENCODABLE_VIDEO_EXTENSIONS = ['.mp4', '.m4v', '.mov'];

/**
 * Audio codecs a browser will actually decode, as ffprobe names them.
 *
 * A demuxable container is only half the question. An .mp4 carrying E-AC-3 (the
 * usual Dolby Digital Plus track on a TV rip) or DTS opens perfectly and then
 * plays *silence*, because those are licensed codecs no desktop browser ships —
 * which looks exactly like a broken file. The list is deliberately short: being
 * wrong in the "playable" direction costs the user silence, while being wrong in
 * the other direction costs one re-encode, so anything uncertain stays off it.
 */
export const BROWSER_AUDIO_CODECS = ['aac', 'mp3', 'opus', 'vorbis', 'flac'];

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

/** A video whose audio can be swapped for a playable one without touching the picture. */
export function isReencodableVideoExtension(filename: string): boolean {
	return REENCODABLE_VIDEO_EXTENSIONS.includes(extensionOf(filename));
}

/** Whether a browser can decode this audio codec, as ffprobe names it. */
export function isBrowserPlayableAudioCodec(codec: string | undefined | null): boolean {
	return BROWSER_AUDIO_CODECS.includes((codec ?? '').trim().toLowerCase());
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
