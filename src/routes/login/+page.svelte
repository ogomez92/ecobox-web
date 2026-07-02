<script lang="ts">
	import { page } from '$app/stores';

	let password = $state('');
	let errorMsg = $state('');
	let busy = $state(false);

	async function submit(e: Event) {
		e.preventDefault();
		if (busy || password.length === 0) return;
		busy = true;
		errorMsg = '';
		try {
			const res = await fetch('/api/auth', {
				method: 'POST',
				headers: { 'content-type': 'application/json' },
				body: JSON.stringify({ password })
			});
			if (res.ok) {
				const redirect = $page.url.searchParams.get('redirect') || '/';
				// Full reload so the new cookie is applied to the next document request.
				window.location.href = redirect;
				return;
			}
			if (res.status === 429) {
				const secs = Number(res.headers.get('retry-after')) || 0;
				const mins = Math.ceil(secs / 60);
				errorMsg =
					secs > 90
						? `Too many attempts. Try again in about ${mins} min.`
						: 'Too many attempts. Try again in a moment.';
			} else {
				errorMsg = res.status === 401 ? 'Incorrect password' : 'Something went wrong';
			}
		} catch {
			errorMsg = 'Network error';
		} finally {
			busy = false;
		}
	}
</script>

<svelte:head>
	<title>Ecobox · Sign in</title>
</svelte:head>

<div class="flex min-h-screen items-center justify-center px-4">
	<form
		onsubmit={submit}
		class="w-full max-w-sm space-y-6 rounded-2xl bg-white p-8 shadow-lg dark:bg-gray-800"
	>
		<div class="text-center">
			<h1 class="text-2xl font-semibold text-gray-900 dark:text-gray-100">Ecobox</h1>
			<p class="mt-1 text-sm text-gray-500 dark:text-gray-400">Enter your password to continue</p>
		</div>

		<div class="space-y-2">
			<label for="password" class="block text-sm font-medium text-gray-700 dark:text-gray-300">
				Password
			</label>
			<!-- svelte-ignore a11y_autofocus -->
			<input
				id="password"
				type="password"
				autocomplete="current-password"
				autofocus
				bind:value={password}
				disabled={busy}
				class="w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-gray-900 shadow-sm focus:border-sky-500 focus:outline-none focus:ring-1 focus:ring-sky-500 dark:border-gray-600 dark:bg-gray-700 dark:text-gray-100"
			/>
		</div>

		{#if errorMsg}
			<p class="text-sm text-red-600 dark:text-red-400" role="alert">{errorMsg}</p>
		{/if}

		<button
			type="submit"
			disabled={busy || password.length === 0}
			class="w-full rounded-lg bg-sky-600 px-4 py-2 font-medium text-white transition hover:bg-sky-700 disabled:cursor-not-allowed disabled:opacity-50"
		>
			{busy ? 'Signing in…' : 'Sign in'}
		</button>
	</form>
</div>
