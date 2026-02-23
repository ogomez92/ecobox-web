<script lang="ts">
	import PlaybackView from '$lib/components/PlaybackView.svelte';
	import { page } from '$app/stores';

	const filePath = $derived($page.params.path || '');
</script>

<PlaybackView {filePath} />
