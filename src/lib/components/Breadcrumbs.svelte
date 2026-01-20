<script lang="ts">
	import Icon from './Icon.svelte';

	interface Crumb {
		name: string;
		path: string;
	}

	interface Props {
		items: Crumb[];
		onnavigate: (path: string) => void;
	}

	let { items, onnavigate }: Props = $props();
</script>

<nav aria-label="Breadcrumb navigation" class="overflow-x-auto scrollbar-hide">
	<ol class="flex items-center gap-1 text-sm whitespace-nowrap py-2">
		{#each items as crumb, index}
			<li class="flex items-center">
				{#if index > 0}
					<Icon name="chevron-right" size={16} class="text-gray-400 mx-1 flex-shrink-0" />
				{/if}

				{#if index === items.length - 1}
					<span
						class="font-medium text-gray-900 dark:text-gray-100 px-2 py-1"
						aria-current="page"
					>
						{crumb.name}
					</span>
				{:else}
					<button
						type="button"
						onclick={() => onnavigate(crumb.path)}
						class="text-primary-600 dark:text-primary-400 hover:text-primary-800 dark:hover:text-primary-300 px-2 py-1 rounded hover:bg-gray-100 dark:hover:bg-gray-800 transition-colors focus:outline-none focus:ring-2 focus:ring-primary-500 min-h-[44px] flex items-center"
					>
						{#if index === 0}
							<Icon name="home" size={16} class="mr-1" ariaLabel="Home" />
						{/if}
						<span class:sr-only={index === 0}>{crumb.name}</span>
					</button>
				{/if}
			</li>
		{/each}
	</ol>
</nav>

<style>
	.scrollbar-hide {
		-ms-overflow-style: none;
		scrollbar-width: none;
	}
	.scrollbar-hide::-webkit-scrollbar {
		display: none;
	}
</style>
