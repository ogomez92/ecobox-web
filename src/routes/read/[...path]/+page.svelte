<script lang="ts">
	import ReaderView from '$lib/components/ReaderView.svelte';
	import { page } from '$app/stores';

	const bookPath = $derived($page.params.path || '');
</script>

<ReaderView {bookPath} />
