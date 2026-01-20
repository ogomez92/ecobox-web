<script lang="ts">
	import Icon from './Icon.svelte';

	interface Props {
		value: string;
		placeholder?: string;
		onchange: (value: string) => void;
	}

	let { value = '', placeholder = 'Search files...', onchange }: Props = $props();

	let inputElement: HTMLInputElement | null = $state(null);

	function handleInput(e: Event) {
		const target = e.target as HTMLInputElement;
		onchange(target.value);
	}

	function handleClear() {
		onchange('');
		inputElement?.focus();
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && value) {
			handleClear();
			e.preventDefault();
		}
	}
</script>

<div class="relative" role="search">
	<label for="search-input" class="sr-only">Search files</label>
	<div class="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
		<Icon name="search" size={20} class="text-gray-400" />
	</div>
	<input
		bind:this={inputElement}
		id="search-input"
		type="search"
		{value}
		{placeholder}
		oninput={handleInput}
		onkeydown={handleKeydown}
		class="input pl-10 pr-10"
		autocomplete="off"
		autocorrect="off"
		autocapitalize="off"
		spellcheck="false"
	/>
	{#if value}
		<button
			type="button"
			onclick={handleClear}
			class="absolute inset-y-0 right-0 pr-3 flex items-center"
			aria-label="Clear search"
		>
			<Icon name="x" size={20} class="text-gray-400 hover:text-gray-600 dark:hover:text-gray-300" />
		</button>
	{/if}
</div>
