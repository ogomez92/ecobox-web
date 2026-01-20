<script lang="ts">
	import FileExplorer from '$lib/components/FileExplorer.svelte';
	import { page } from '$app/stores';

	const focusFile = $derived($page.url.searchParams.get('focus') || undefined);
</script>

<svelte:head>
	<title>Ecobox - Audio Player</title>
</svelte:head>

<FileExplorer initialPath="" {focusFile} />
