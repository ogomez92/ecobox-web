import { describe, it, expect, vi, beforeEach } from 'vitest';

const ensureVideoPlayable = vi.fn();
vi.mock('./videoConvert', () => ({ ensureVideoPlayable: (p: string) => ensureVideoPlayable(p) }));

async function load() {
	vi.resetModules();
	return import('./playabilityQueue');
}

function deferred<T>() {
	let resolve!: (v: T) => void;
	const promise = new Promise<T>((r) => (resolve = r));
	return { promise, resolve };
}

describe('playabilityQueue', () => {
	beforeEach(() => ensureVideoPlayable.mockReset());

	it('runs checks one at a time, in upload order', async () => {
		const q = await load();
		const first = deferred<{ action: string }>();
		ensureVideoPlayable.mockReturnValueOnce(first.promise).mockResolvedValueOnce({ action: 'skipped' });

		q.enqueuePlayabilityCheck('a.mp4');
		q.enqueuePlayabilityCheck('b.mp4');
		expect(q.getPlayabilityStatus('a.mp4')?.state).toBe('running');
		expect(q.getPlayabilityStatus('b.mp4')?.state).toBe('queued');
		expect(ensureVideoPlayable).toHaveBeenCalledTimes(1);

		first.resolve({ action: 'reencoded' });
		await vi.waitFor(() => expect(q.getPlayabilityStatus('b.mp4')?.state).toBe('done'));
		expect(q.getPlayabilityStatus('a.mp4')).toEqual({ state: 'done', result: { action: 'reencoded' } });
		expect(ensureVideoPlayable.mock.calls.map((c) => c[0])).toEqual(['a.mp4', 'b.mp4']);
	});

	it('does not queue a path twice while it is pending, but re-checks a re-upload', async () => {
		const q = await load();
		const first = deferred<{ action: string }>();
		ensureVideoPlayable.mockReturnValueOnce(first.promise).mockResolvedValue({ action: 'skipped' });

		q.enqueuePlayabilityCheck('a.mp4');
		q.enqueuePlayabilityCheck('a.mp4');
		first.resolve({ action: 'skipped' });
		await vi.waitFor(() => expect(q.getPlayabilityStatus('a.mp4')?.state).toBe('done'));
		expect(ensureVideoPlayable).toHaveBeenCalledTimes(1);

		q.enqueuePlayabilityCheck('a.mp4');
		await vi.waitFor(() => expect(ensureVideoPlayable).toHaveBeenCalledTimes(2));
	});

	it('turns a thrown check into a failed result and keeps going', async () => {
		const q = await load();
		vi.spyOn(console, 'error').mockImplementation(() => {});
		ensureVideoPlayable.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce({ action: 'skipped' });

		q.enqueuePlayabilityCheck('a.mp4');
		q.enqueuePlayabilityCheck('b.mp4');
		await vi.waitFor(() => expect(q.getPlayabilityStatus('b.mp4')?.state).toBe('done'));
		expect(q.getPlayabilityStatus('a.mp4')?.result?.action).toBe('failed');
	});

	it('answers null for a path that was never queued', async () => {
		const q = await load();
		expect(q.getPlayabilityStatus('nope.mp4')).toBeNull();
	});
});
