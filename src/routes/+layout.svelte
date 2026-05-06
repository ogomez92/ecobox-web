<script lang="ts">
	import '../app.css';
	import { onMount } from 'svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';
	import { i18n, t } from '$lib/i18n/index.svelte';

	let { children } = $props();

	const pageTitle = $derived(settingsStore.maskTitle || t('app.title'));
	const description = $derived(t('app.description'));

	onMount(() => {
		i18n.init();
		settingsStore.load();
	});
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content={description} />
</svelte:head>

<div class="min-h-screen flex flex-col">
	{@render children()}
</div>
