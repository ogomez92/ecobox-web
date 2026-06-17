/**
 * A TTS provider failure carrying the HTTP status the API route should relay so
 * the client can branch (400 = misconfigured, 401 = bad key, 502 = provider
 * error, 503 = unreachable) and fall back to Web Speech gracefully.
 */
export class TtsError extends Error {
	status: number;
	constructor(status: number, message: string) {
		super(message);
		this.name = 'TtsError';
		this.status = status;
	}
}
