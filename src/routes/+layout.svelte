<script lang="ts">
	import '../app.css';
	import { page } from '$app/stores';

	let { children } = $props();
</script>

<svelte:head>
	<meta name="description" content="Ecobox - Audio Player for Audiobooks and Podcasts" />
</svelte:head>

<div class="min-h-screen flex flex-col">
	{@render children()}
</div>
