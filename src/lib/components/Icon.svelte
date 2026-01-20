<script lang="ts">
	type IconName =
		| 'folder'
		| 'file'
		| 'audio'
		| 'book'
		| 'radio'
		| 'play'
		| 'pause'
		| 'skip-back'
		| 'skip-forward'
		| 'upload'
		| 'download'
		| 'trash'
		| 'search'
		| 'settings'
		| 'chevron-right'
		| 'chevron-down'
		| 'chevron-up'
		| 'home'
		| 'bookmark'
		| 'clock'
		| 'volume'
		| 'volume-off'
		| 'x'
		| 'menu'
		| 'check'
		| 'sort'
		| 'more-vertical'
		| 'lock'
		| 'lock-open';

	interface Props {
		name: IconName;
		size?: number;
		class?: string;
		ariaLabel?: string;
	}

	let { name, size = 24, class: className = '', ariaLabel }: Props = $props();

	const paths: Record<IconName, string> = {
		folder: 'M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z',
		file: 'M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8l-6-6zm4 18H6V4h7v5h5v11z',
		audio: 'M12 3v10.55c-.59-.34-1.27-.55-2-.55-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4V7h4V3h-6z',
		book: 'M4 19.5A2.5 2.5 0 016.5 17H20M4 19.5A2.5 2.5 0 004 17V5a2 2 0 012-2h14a2 2 0 012 2v12a2 2 0 01-2 2H6.5z',
		radio: 'M12 20h.01M8 16h8M12 12a4 4 0 100-8 4 4 0 000 8zM4.93 4.93l2.83 2.83M16.24 7.76l2.83-2.83M19.07 19.07l-2.83-2.83M7.76 16.24l-2.83 2.83',
		play: 'M5 3l14 9-14 9V3z',
		pause: 'M6 4h4v16H6V4zm8 0h4v16h-4V4z',
		'skip-back': 'M19 20L9 12l10-8v16zM5 19V5',
		'skip-forward': 'M5 4l10 8-10 8V4zm14 1v14',
		upload: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M17 8l-5-5-5 5M12 3v12',
		download: 'M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3',
		trash: 'M3 6h18M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2m3 0v14a2 2 0 01-2 2H7a2 2 0 01-2-2V6h14z',
		search: 'M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z',
		settings: 'M12 15a3 3 0 100-6 3 3 0 000 6zM19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 010 2.83 2 2 0 01-2.83 0l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-2 2 2 2 0 01-2-2v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 01-2.83 0 2 2 0 010-2.83l.06-.06a1.65 1.65 0 00.33-1.82 1.65 1.65 0 00-1.51-1H3a2 2 0 01-2-2 2 2 0 012-2h.09A1.65 1.65 0 004.6 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 010-2.83 2 2 0 012.83 0l.06.06a1.65 1.65 0 001.82.33H9a1.65 1.65 0 001-1.51V3a2 2 0 012-2 2 2 0 012 2v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 0 2 2 0 010 2.83l-.06.06a1.65 1.65 0 00-.33 1.82V9a1.65 1.65 0 001.51 1H21a2 2 0 012 2 2 2 0 01-2 2h-.09a1.65 1.65 0 00-1.51 1z',
		'chevron-right': 'M9 18l6-6-6-6',
		'chevron-down': 'M6 9l6 6 6-6',
		'chevron-up': 'M18 15l-6-6-6 6',
		home: 'M3 12l2-2m0 0l7-7 7 7M5 10v10a1 1 0 001 1h3m10-11l2 2m-2-2v10a1 1 0 01-1 1h-3m-6 0a1 1 0 001-1v-4a1 1 0 011-1h2a1 1 0 011 1v4a1 1 0 001 1m-6 0h6',
		bookmark: 'M5 5a2 2 0 012-2h10a2 2 0 012 2v16l-7-3.5L5 21V5z',
		clock: 'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10zM12 6v6l4 2',
		volume: 'M11 5L6 9H2v6h4l5 4V5zM19.07 4.93a10 10 0 010 14.14M15.54 8.46a5 5 0 010 7.07',
		'volume-off': 'M11 5L6 9H2v6h4l5 4V5zM23 9l-6 6M17 9l6 6',
		x: 'M18 6L6 18M6 6l12 12',
		menu: 'M4 6h16M4 12h16M4 18h16',
		check: 'M20 6L9 17l-5-5',
		sort: 'M3 6h18M6 12h12M9 18h6',
		'more-vertical': 'M12 5v.01M12 12v.01M12 19v.01M12 6a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2zm0 7a1 1 0 110-2 1 1 0 010 2z',
		lock: 'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 0110 0v4',
		'lock-open': 'M19 11H5a2 2 0 00-2 2v7a2 2 0 002 2h14a2 2 0 002-2v-7a2 2 0 00-2-2zM7 11V7a5 5 0 019.9-1'
	};
</script>

<svg
	xmlns="http://www.w3.org/2000/svg"
	width={size}
	height={size}
	viewBox="0 0 24 24"
	fill="none"
	stroke="currentColor"
	stroke-width="2"
	stroke-linecap="round"
	stroke-linejoin="round"
	class={className}
	aria-hidden={!ariaLabel}
	aria-label={ariaLabel}
	role={ariaLabel ? 'img' : undefined}
>
	<path d={paths[name]} />
</svg>
