<script lang="ts">
	import FileExplorer from '$lib/components/FileExplorer.svelte';
	import { page } from '$app/stores';

	const path = $derived($page.params.path || '');
	const focusFile = $derived($page.url.searchParams.get('focus') || undefined);
</script>

<svelte:head>
	<title>Ecobox</title>
</svelte:head>

<FileExplorer initialPath={path} {focusFile} />
