import { t } from '$lib/i18n/index.svelte';
import type { MessageKey } from '$lib/i18n/locales/en';
import type { AudiobookErrorCode, AudiobookJobStatus, TtsAudioService, TtsService } from '$lib/types';

/**
 * Client side of "Convert to audio". The server runs the export
 * (`$server/services/audiobookExport.ts`); this store follows it so that closing
 * the progress dialog — or navigating to another folder — doesn't lose track of
 * it. While the dialog is showing a run it narrates progress itself; for anything
 * else the result goes to the layout's polite live region.
 */

const POLL_MS = 2000;

export function isActiveState(state: AudiobookJobStatus['state'] | undefined): boolean {
	return state === 'queued' || state === 'running' || state === 'finishing';
}

const SERVICE_KEYS: Record<TtsService, MessageKey> = {
	webspeech: 'settings.ttsSvcWebSpeech',
	elevenlabs: 'settings.ttsSvcElevenLabs',
	azure: 'settings.ttsSvcAzure',
	'azure-edge': 'settings.ttsSvcAzureEdge',
	google: 'settings.ttsSvcGoogle',
	elf: 'settings.ttsSvcElf',
	piper: 'settings.ttsSvcPiper',
	phonon: 'settings.ttsSvcPhonon'
};

/** The localized display name of a TTS service. */
export function serviceName(service: TtsService): string {
	return t(SERVICE_KEYS[service] ?? 'settings.ttsSvcWebSpeech');
}

const ERROR_KEYS: Record<AudiobookErrorCode, MessageKey> = {
	clientOnly: 'audiobook.errorClientOnly',
	notBook: 'audiobook.errorNotBook',
	empty: 'audiobook.errorEmpty',
	noVoice: 'audiobook.errorNoVoice',
	quotaExceeded: 'audiobook.errorQuota',
	badKey: 'audiobook.errorBadKey',
	misconfigured: 'audiobook.errorMisconfigured',
	unreachable: 'audiobook.errorUnreachable',
	upstream: 'audiobook.errorUpstream',
	ffmpeg: 'audiobook.errorFfmpeg',
	write: 'audiobook.errorWrite',
	busy: 'audiobook.errorBusy',
	unknown: 'audiobook.errorUnknown'
};

/** A localized sentence for an export error, with the server's detail appended. */
export function audiobookErrorMessage(
	code: AudiobookErrorCode | null | undefined,
	service: TtsService,
	detail?: string | null
): string {
	const base = t(ERROR_KEYS[code ?? 'unknown'] ?? 'audiobook.errorUnknown', { service: serviceName(service) });
	return detail && code !== 'quotaExceeded' ? `${base} (${detail})` : base;
}

function baseName(path: string): string {
	return path.slice(path.lastIndexOf('/') + 1);
}

class AudiobookExportStore {
	/** Latest status per book path. */
	statuses = $state<Record<string, AudiobookJobStatus>>({});
	/** Text for the layout's polite live region. */
	announcement = $state('');
	/** Bumped when an export finished and a new file exists, so listings reload. */
	changes = $state(0);
	/** The book whose run the dialog is narrating — its result isn't repeated here. */
	watching = $state<string | null>(null);

	private timer: ReturnType<typeof setTimeout> | null = null;

	/** Record a status from the server and keep polling while anything is active. */
	update(status: AudiobookJobStatus | null, path?: string) {
		const key = status?.path ?? path;
		if (!key) return;
		const previous = this.statuses[key];
		if (!status) {
			delete this.statuses[key];
			// The server forgot an active run: it restarted. Say so rather than going quiet.
			if (isActiveState(previous?.state) && this.watching !== key) {
				this.announce(t('audiobook.lostAnnounce', { name: baseName(key) }));
			}
			return;
		}
		this.statuses[key] = status;
		if (isActiveState(previous?.state) && !isActiveState(status.state)) this.finished(status);
		if (isActiveState(status.state)) this.schedule();
	}

	/** Fetch one book's status now. */
	async refresh(path: string): Promise<AudiobookJobStatus | null> {
		try {
			const res = await fetch(`/api/books/audio?path=${encodeURIComponent(path)}`);
			if (!res.ok) return this.statuses[path] ?? null;
			const { status } = (await res.json()) as { status: AudiobookJobStatus | null };
			this.update(status, path);
			return status;
		} catch {
			return this.statuses[path] ?? null;
		}
	}

	async cancel(path: string): Promise<void> {
		try {
			const res = await fetch('/api/books/audio', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ path, action: 'cancel' })
			});
			if (res.ok) this.update(((await res.json()) as { status: AudiobookJobStatus | null }).status, path);
		} catch {
			// The next poll reports the real state.
		}
	}

	private finished(status: AudiobookJobStatus) {
		if (status.state === 'done') this.changes++;
		if (this.watching === status.path) return;
		const name = baseName(status.path);
		let message: string;
		if (status.state === 'done') {
			message = t('audiobook.doneAnnounce', { name, file: baseName(status.outputPath ?? '') });
		} else if (status.state === 'cancelled') {
			message = t('audiobook.cancelledAnnounce', { name });
		} else {
			message = `${t('audiobook.failedAnnounce', { name })} ${audiobookErrorMessage(status.error, status.service as TtsAudioService, status.detail)}`;
		}
		this.announce(message);
	}

	private announce(message: string) {
		this.announcement = '';
		setTimeout(() => {
			this.announcement = message;
		}, 10);
	}

	private schedule() {
		if (this.timer === null) this.timer = setTimeout(() => void this.poll(), POLL_MS);
	}

	private async poll() {
		this.timer = null;
		const active = Object.values(this.statuses).filter((s) => isActiveState(s.state));
		await Promise.all(active.map((s) => this.refresh(s.path)));
		if (Object.values(this.statuses).some((s) => isActiveState(s.state))) this.schedule();
	}
}

export const audiobookExportStore = new AudiobookExportStore();
