<script lang="ts">
	import PlaybackView from '$lib/components/PlaybackView.svelte';
	import { page } from '$app/stores';

	const filePath = $derived($page.params.path || '');
</script>

<!-- Re-key on the path so switching tracks (Winamp b/z, auto-advance) fully
     remounts the player: onMount reloads and plays the new file. -->
{#key filePath}
	<PlaybackView {filePath} />
{/key}
