import { io, type Socket } from 'socket.io-client';
import { Device } from 'mediasoup-client';
import type { Transport, Producer } from 'mediasoup-client/types';
import { audioEffects } from './audioEffects';
import { settingsStore } from '$lib/stores/settings.svelte';

// ICE servers — COPY of SonicRoom's client/src/hooks/useMediasoup.ts ICE_SERVERS
// (self-hosted coturn at turn.oriolgomez.com). Credentials are visible to the
// browser by design (WebRTC requires them client-side). Keep this list in sync
// with the SonicRoom client if it ever changes.
const ICE_SERVERS: RTCIceServer[] = [
	{ urls: 'stun:turn.oriolgomez.com:3478' },
	{ urls: 'stun:stun.l.google.com:19302' },
	{
		urls: 'turn:turn.oriolgomez.com:3478?transport=udp',
		username: 'gamesturn',
		credential: 'sin6V0gFokHz78gM0GDfXmat'
	},
	{
		urls: 'turn:turn.oriolgomez.com:3478?transport=tcp',
		username: 'gamesturn',
		credential: 'sin6V0gFokHz78gM0GDfXmat'
	},
	{
		urls: 'turns:turn.oriolgomez.com:5349?transport=tcp',
		username: 'gamesturn',
		credential: 'sin6V0gFokHz78gM0GDfXmat'
	}
];

// Stereo, hi-fi target for the music track. Far above SonicRoom's voice path
// (mono 64k); negotiates up against the raised router ceiling (256000).
const MUSIC_BITRATE = 256000;

export type CastStatus = 'idle' | 'connecting' | 'casting' | 'error';

export interface CastTarget {
	/** SonicRoom server origin, e.g. https://sonicroom.example.com */
	serverUrl: string;
	/** Room name to join */
	roomName: string;
}

/**
 * Parse a pasted SonicRoom room link OR a bare room name into a CastTarget.
 * - "https://host/room/my-studio"  -> { serverUrl: "https://host", roomName: "my-studio" }
 * - "my-studio"                    -> { serverUrl: <Settings → SonicRoom URL>, roomName: "my-studio" }
 * Returns null if no room name (or, for a bare name, no configured server URL).
 */
export function parseCastInput(input: string): CastTarget | null {
	const trimmed = input.trim();
	if (!trimmed) return null;

	if (/^https?:\/\//i.test(trimmed)) {
		try {
			const url = new URL(trimmed);
			const match = url.pathname.match(/\/room\/([^/?#]+)/);
			const roomName = match ? decodeURIComponent(match[1]) : '';
			if (!roomName) return null;
			return { serverUrl: url.origin, roomName: sanitizeRoom(roomName) };
		} catch {
			return null;
		}
	}

	const serverUrl = settingsStore.sonicroomUrl.trim().replace(/\/+$/, '');
	const roomName = sanitizeRoom(trimmed);
	if (!roomName || !serverUrl) return null;
	return { serverUrl, roomName };
}

// SonicRoom only accepts [a-zA-Z0-9_-] room names (see its lobby/signaling).
function sanitizeRoom(name: string): string {
	return name.replace(/[^a-zA-Z0-9_-]/g, '');
}

class RoomCaster {
	status = $state<CastStatus>('idle');
	error = $state<string | null>(null);
	roomName = $state<string | null>(null);

	private socket: Socket | null = null;
	private sendTransport: Transport | null = null;
	private producer: Producer | null = null;

	get isCasting(): boolean {
		return this.status === 'casting';
	}

	private emit<T>(event: string, data?: unknown): Promise<T> {
		return new Promise((resolve, reject) => {
			const socket = this.socket;
			if (!socket) return reject(new Error('No socket'));
			socket.emit(event, data, (res: T & { ok: boolean; error?: string }) => {
				if (res && res.ok) resolve(res);
				else reject(new Error(res?.error || 'Request failed'));
			});
		});
	}

	/**
	 * Join the SonicRoom room as a send-only "music" caster and produce the
	 * post-effects stereo tap. Throws on failure (and tears itself down).
	 */
	async start(target: CastTarget, displayName = '🎵 Ecobox'): Promise<void> {
		if (this.status === 'casting' || this.status === 'connecting') return;
		this.status = 'connecting';
		this.error = null;
		this.roomName = target.roomName;

		try {
			// 1. Pristine stereo, post-effects capture from the WebAudio graph.
			const stream = await audioEffects.startCapture();
			const track = stream.getAudioTracks()[0];
			if (!track) throw new Error('No audio to cast (is something playing?)');

			// 2. Connect to the SonicRoom signaling server (cross-origin; its CORS
			//    is origin:"*").
			const socket = io(target.serverUrl, { transports: ['websocket'] });
			this.socket = socket;
			await new Promise<void>((resolve, reject) => {
				socket.on('connect', () => resolve());
				socket.on('connect_error', (e) => reject(e));
			});

			// 3. Join as a caster — the server forces SFU and returns its caps.
			const joinRes = await this.emit<{
				rtpCapabilities: Record<string, unknown>;
				mode: string;
			}>('join', { roomName: target.roomName, displayName, role: 'caster' });

			// 4. Load the device.
			const device = new Device();
			await device.load({
				routerRtpCapabilities: joinRes.rtpCapabilities as Parameters<
					typeof device.load
				>[0]['routerRtpCapabilities']
			});

			// 5. Send transport only — a caster never consumes or sets up P2P.
			const sendRes = await this.emit<{ params: Record<string, unknown> }>('create-transport', {
				direction: 'send'
			});
			const sendTransport = device.createSendTransport({
				...(sendRes.params as Parameters<typeof device.createSendTransport>[0]),
				iceServers: ICE_SERVERS
			});
			this.sendTransport = sendTransport;

			sendTransport.on('connect', ({ dtlsParameters }, callback, errback) => {
				this.emit('connect-transport', { direction: 'send', dtlsParameters })
					.then(() => callback())
					.catch((e) => errback(e as Error));
			});

			sendTransport.on('produce', ({ kind, rtpParameters }, callback, errback) => {
				this.emit<{ producerId: string }>('produce', {
					kind,
					rtpParameters,
					source: 'music'
				})
					.then((res) => callback({ id: res.producerId }))
					.catch((e) => errback(e as Error));
			});

			// If the SonicRoom server drops us, tear down cleanly.
			socket.on('disconnect', () => {
				if (this.status === 'casting' || this.status === 'connecting') {
					this.teardown();
					this.status = 'idle';
				}
			});

			// 6. Produce the stereo music track at hi-fi bitrate. Crucially we do
			//    NOT force mono/64k here — that's the voice path only.
			const opusCodec = device.rtpCapabilities.codecs?.find(
				(c) => c.mimeType.toLowerCase() === 'audio/opus'
			);
			this.producer = await sendTransport.produce({
				track,
				codecOptions: {
					opusStereo: true,
					opusFec: true,
					opusDtx: false,
					opusMaxPlaybackRate: 48000,
					opusMaxAverageBitrate: MUSIC_BITRATE
				},
				codec: opusCodec
			});

			this.status = 'casting';
		} catch (err) {
			this.error = err instanceof Error ? err.message : 'Failed to cast';
			this.teardown();
			this.status = 'error';
			throw err;
		}
	}

	stop(): void {
		this.teardown();
		this.status = 'idle';
		this.error = null;
		this.roomName = null;
	}

	private teardown(): void {
		try {
			this.producer?.close();
		} catch {
			/* ignore */
		}
		try {
			this.sendTransport?.close();
		} catch {
			/* ignore */
		}
		this.socket?.disconnect();
		this.producer = null;
		this.sendTransport = null;
		this.socket = null;
		// Restore local Ecobox monitoring.
		audioEffects.stopCapture();
	}
}

export const roomCaster = new RoomCaster();
