<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';
	import { onMount } from 'svelte';
	import { settingsStore } from '$lib/stores/settings.svelte';

	let { children } = $props();

	const pageTitle = $derived(settingsStore.maskTitle || 'Ecobox');

	onMount(() => {
		settingsStore.load();
	});
</script>

<svelte:head>
	<title>{pageTitle}</title>
	<meta name="description" content="Ecobox - Audio Player for Audiobooks and Podcasts" />
</svelte:head>

<div class="min-h-screen flex flex-col">
	{@render children()}
</div>
