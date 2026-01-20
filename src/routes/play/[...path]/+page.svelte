<script lang="ts">
	import PlaybackView from '$lib/components/PlaybackView.svelte';
	import { page } from '$app/stores';

	const filePath = $derived($page.params.path || '');
	const title = $derived(filePath.split('/').pop() || 'Playing');
</script>

<svelte:head>
	<title>{title} - Ecobox</title>
</svelte:head>

<PlaybackView {filePath} />
