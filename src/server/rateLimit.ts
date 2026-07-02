/**
 * In-memory brute-force throttle for password guesses.
 *
 * Scope is deliberately narrow: this only ever counts *wrong password
 * submissions* (a bad Basic-auth password from the iOS app / curl, or a bad
 * password POSTed to `/api/auth`). It never sees correct credentials, missing
 * credentials, or stale cookies, so legitimate clients — the iOS app sending
 * the right password on every request, a browser with a valid cookie, or a
 * logged-out browser on its way to `/login` — are never throttled. That keeps
 * the gate backwards-compatible: the only client that can ever be blocked is
 * one actively guessing.
 *
 * State lives in this single Node process (the app runs as one systemd unit),
 * so counters reset on restart. That's fine — the goal is to make online
 * brute force impractically slow, not to be a durable audit log.
 */

/** Wrong guesses allowed per key before lockout kicks in. */
const FREE_ATTEMPTS = 5;
/** First lockout once the free attempts are used up. */
const BASE_LOCK_MS = 5_000;
/** Lockout ceiling — a determined guesser can't stall longer than this. */
const MAX_LOCK_MS = 15 * 60_000;
/** A key with no failures for this long is forgotten (counter resets). */
const DECAY_MS = 15 * 60_000;
/** Sweep idle entries once the map grows past this, to bound memory. */
const SWEEP_THRESHOLD = 5_000;

interface Entry {
	/** Consecutive wrong guesses in the current (non-decayed) window. */
	fails: number;
	/** Timestamp of the most recent wrong guess. */
	lastFail: number;
	/** Epoch ms until which this key is locked out (0 = not locked). */
	blockedUntil: number;
}

const attempts = new Map<string, Entry>();

/**
 * The throttle key for a request: the real client IP. Behind Caddy the socket
 * address is always `127.0.0.1`, so prefer the first hop of `X-Forwarded-For`
 * (Caddy sets it and overwrites any client-supplied value). Falls back to
 * SvelteKit's `getClientAddress()` when the header is absent.
 */
export function clientKey(request: Request, fallback: () => string): string {
	const xff = request.headers.get('x-forwarded-for');
	if (xff) {
		const first = xff.split(',')[0].trim();
		if (first) return first;
	}
	try {
		return fallback();
	} catch {
		return 'unknown';
	}
}

/**
 * If this key is currently locked out, return the seconds remaining (always
 * ≥ 1); otherwise 0. Call this *before* checking the password so a blocked
 * client is rejected without its guess even being evaluated.
 */
export function retryAfter(key: string, now: number = Date.now()): number {
	const e = attempts.get(key);
	if (e && e.blockedUntil > now) {
		return Math.ceil((e.blockedUntil - now) / 1000);
	}
	return 0;
}

/** Record one wrong password guess for this key and update its lockout. */
export function recordFailure(key: string, now: number = Date.now()): void {
	if (attempts.size > SWEEP_THRESHOLD) sweep(now);

	let e = attempts.get(key);
	if (!e || now - e.lastFail > DECAY_MS) {
		e = { fails: 0, lastFail: now, blockedUntil: 0 };
	}
	e.fails += 1;
	e.lastFail = now;

	if (e.fails > FREE_ATTEMPTS) {
		const over = e.fails - FREE_ATTEMPTS; // 1, 2, 3, …
		const lock = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** (over - 1));
		e.blockedUntil = now + lock;
	}
	attempts.set(key, e);
}

/** A correct password clears the key's history entirely. */
export function recordSuccess(key: string): void {
	attempts.delete(key);
}

/** Drop entries that have decayed and are no longer locked. */
function sweep(now: number): void {
	for (const [key, e] of attempts) {
		if (e.blockedUntil <= now && now - e.lastFail > DECAY_MS) {
			attempts.delete(key);
		}
	}
}

/** Test-only: wipe all throttle state. */
export function _reset(): void {
	attempts.clear();
}
