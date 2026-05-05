<script lang="ts">
	import Icon from './Icon.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { formatBytes } from '$lib/utils/format';
	import type { UploadNegotiateRequest, UploadNegotiateResponse } from '$lib/types';

	interface Props {
		isOpen: boolean;
		currentPath: string;
		initialTab?: 'upload' | 'radio';
		initialPicker?: 'file' | 'folder' | null;
		onclose: () => void;
		oncomplete: () => void;
	}

	let {
		isOpen,
		currentPath,
		initialTab = 'upload',
		initialPicker = null,
		onclose,
		oncomplete
	}: Props = $props();

	// Tab state — synced from initialTab when the dialog opens
	let activeTab = $state<'upload' | 'radio'>('upload');

	let fileInput: HTMLInputElement | null = $state(null);
	let folderInput: HTMLInputElement | null = $state(null);
	let addFilesButton: HTMLButtonElement | null = $state(null);

	// Radio creation state
	let radioName = $state('');
	let radioUrl = $state('');
	let radioUsername = $state('');
	let radioPassword = $state('');
	let radioNameInput: HTMLInputElement | null = $state(null);
	let isCreatingRadio = $state(false);

	let lastOpenState = $state(false);
	$effect(() => {
		// Detect transition from closed -> open
		if (isOpen && !lastOpenState) {
			lastOpenState = true;
			activeTab = initialTab;

			if (activeTab === 'radio' && radioNameInput) {
				radioNameInput.focus();
			} else if (initialPicker === 'file' && fileInput) {
				// Auto-trigger file picker on next tick so the dialog mounts first
				queueMicrotask(() => fileInput?.click());
				addFilesButton?.focus();
			} else if (initialPicker === 'folder' && folderInput) {
				queueMicrotask(() => folderInput?.click());
				addFilesButton?.focus();
			} else if (addFilesButton) {
				addFilesButton.focus();
			}
		} else if (!isOpen) {
			lastOpenState = false;
		}
	});

	let selectedFiles = $state<File[]>([]);
	let mode = $state<'copy' | 'sync'>('copy');
	let preflight = $state<UploadNegotiateResponse | null>(null);
	let preflightLoading = $state(false);
	let preflightError = $state<string | null>(null);
	let confirmSyncDelete = $state(false);
	let isUploading = $state(false);
	let uploadProgress = $state(0);
	let currentFileIndex = $state(0);
	let totalFiles = $state(0);
	let error = $state<string | null>(null);
	let lastAnnouncedProgress = $state(-1);
	let progressAnnouncement = $state('');

	const totalSize = $derived(selectedFiles.reduce((sum, f) => sum + f.size, 0));

	const newCount = $derived(preflight?.newFiles.length ?? 0);
	const conflictCount = $derived(preflight?.conflicts.length ?? 0);
	const identicalCount = $derived(preflight?.identical.length ?? 0);
	const extrasCount = $derived(preflight?.extras.length ?? 0);

	// What will actually happen given current mode
	const willUploadCount = $derived(
		mode === 'sync' ? newCount + conflictCount : newCount
	);
	const willSkipCount = $derived(
		mode === 'sync' ? identicalCount : identicalCount + conflictCount
	);
	const willDeleteCount = $derived(mode === 'sync' ? extrasCount : 0);

	// Live announcement of the plan for screen readers
	const planAnnouncement = $derived(
		preflight
			? `Plan: upload ${willUploadCount}, skip ${willSkipCount}${willDeleteCount > 0 ? `, delete ${willDeleteCount}` : ''}.`
			: ''
	);

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			selectedFiles = [...selectedFiles, ...Array.from(input.files)];
		}
		input.value = '';
	}

	function clearFiles() {
		selectedFiles = [];
		preflight = null;
		preflightError = null;
		error = null;
	}

	function clearRadio() {
		radioName = '';
		radioUrl = '';
		radioUsername = '';
		radioPassword = '';
		error = null;
	}

	// Run preflight when files or mode change
	$effect(() => {
		// Track dependencies
		const files = selectedFiles;
		const m = mode;
		if (files.length === 0) {
			preflight = null;
			preflightError = null;
			return;
		}

		let cancelled = false;
		preflightLoading = true;
		preflightError = null;

		const fileList = files.map(f => ({
			path: f.webkitRelativePath || f.name,
			size: f.size
		}));

		const req: UploadNegotiateRequest = {
			basePath: currentPath,
			mode: m,
			files: fileList
		};

		fetch('/api/upload/negotiate', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify(req)
		})
			.then(async (res) => {
				if (cancelled) return;
				if (!res.ok) {
					preflightError = 'Could not check destination folder';
					preflight = null;
				} else {
					preflight = await res.json();
				}
			})
			.catch(() => {
				if (!cancelled) {
					preflightError = 'Could not check destination folder';
					preflight = null;
				}
			})
			.finally(() => {
				if (!cancelled) preflightLoading = false;
			});

		return () => {
			cancelled = true;
		};
	});

	async function handleCreateRadio() {
		if (!radioName.trim() || !radioUrl.trim()) {
			error = 'Station name and URL are required';
			return;
		}

		isCreatingRadio = true;
		error = null;

		try {
			const filePath = currentPath
				? `${currentPath}/${radioName.trim()}`
				: radioName.trim();

			const response = await fetch('/api/radio', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({
					path: filePath,
					url: radioUrl.trim(),
					name: radioName.trim(),
					username: radioUsername.trim() || undefined,
					password: radioPassword.trim() || undefined
				})
			});

			if (!response.ok) {
				throw new Error('Failed to create radio station');
			}

			oncomplete();
			clearRadio();
			onclose();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			isCreatingRadio = false;
		}
	}

	function uploadFile(file: File, filePath: string): Promise<void> {
		return new Promise((resolve, reject) => {
			const xhr = new XMLHttpRequest();

			xhr.upload.addEventListener('progress', (e) => {
				if (e.lengthComputable && totalFiles > 0) {
					const fileProgress = e.loaded / e.total;
					const overallProgress = Math.round(
						((currentFileIndex + fileProgress) / totalFiles) * 100
					);
					uploadProgress = Math.min(overallProgress, 99);

					const progressToAnnounce = Math.floor(uploadProgress / 5) * 5;
					if (progressToAnnounce > lastAnnouncedProgress && progressToAnnounce > 0) {
						lastAnnouncedProgress = progressToAnnounce;
						progressAnnouncement = `Uploading, ${progressToAnnounce}%, file ${currentFileIndex + 1} of ${totalFiles}`;
					}
				}
			});

			xhr.addEventListener('load', () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new Error(`Failed to upload ${file.name}`));
				}
			});

			xhr.addEventListener('error', () => {
				reject(new Error(`Failed to upload ${file.name}`));
			});

			xhr.addEventListener('abort', () => {
				reject(new Error('Upload cancelled'));
			});

			xhr.open('POST', `/api/upload/stream?path=${encodeURIComponent(filePath)}`);
			xhr.send(file);
		});
	}

	function startUpload() {
		// If sync mode would delete files, require explicit confirmation
		if (mode === 'sync' && willDeleteCount > 0) {
			confirmSyncDelete = true;
			return;
		}
		void runUpload();
	}

	async function runUpload() {
		if (selectedFiles.length === 0 || !preflight) return;

		isUploading = true;
		uploadProgress = 0;
		currentFileIndex = 0;
		lastAnnouncedProgress = -1;
		progressAnnouncement = '';
		error = null;

		try {
			const { toUpload, toDelete } = preflight;

			// Delete files if in sync mode
			if (toDelete && toDelete.length > 0) {
				for (const path of toDelete) {
					await fetch(`/api/files?path=${encodeURIComponent(path)}`, {
						method: 'DELETE'
					});
				}
			}

			// Upload files
			const filesToUpload = selectedFiles.filter(f =>
				toUpload.includes(f.webkitRelativePath || f.name)
			);

			totalFiles = filesToUpload.length;

			if (totalFiles === 0) {
				uploadProgress = 100;
				progressAnnouncement = 'Upload complete, no new files to upload';
			} else {
				progressAnnouncement = `Starting upload of ${totalFiles} file${totalFiles !== 1 ? 's' : ''}`;

				for (let i = 0; i < filesToUpload.length; i++) {
					currentFileIndex = i;
					const file = filesToUpload[i];

					const filePath = currentPath
						? `${currentPath}/${file.webkitRelativePath || file.name}`
						: file.webkitRelativePath || file.name;

					await uploadFile(file, filePath);
				}

				uploadProgress = 100;
				progressAnnouncement = `Upload complete, ${totalFiles} file${totalFiles !== 1 ? 's' : ''} uploaded`;
			}

			oncomplete();

			await new Promise(resolve => setTimeout(resolve, 500));

			clearFiles();
			onclose();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			isUploading = false;
		}
	}

	function handleConfirmSyncDelete() {
		confirmSyncDelete = false;
		void runUpload();
	}

	function handleClose() {
		if (!isUploading && !isCreatingRadio) {
			clearFiles();
			clearRadio();
			activeTab = 'upload';
			onclose();
		}
	}

	function handleKeydown(e: KeyboardEvent) {
		if (e.key === 'Escape' && !isUploading && !confirmSyncDelete) {
			handleClose();
		}
	}

	function handleTabKeydown(e: KeyboardEvent) {
		if (isUploading || isCreatingRadio) return;

		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			activeTab = activeTab === 'upload' ? 'radio' : 'upload';
			requestAnimationFrame(() => {
				const selectedTab = document.querySelector('[role="tab"][aria-selected="true"]') as HTMLElement;
				selectedTab?.focus();
			});
		}
	}
</script>

{#if isOpen}
	<!-- svelte-ignore a11y_no_noninteractive_tabindex -->
	<div
		class="fixed inset-0 z-50 flex items-end sm:items-center justify-center"
		role="dialog"
		aria-modal="true"
		aria-labelledby="upload-dialog-title"
		onkeydown={handleKeydown}
		tabindex="-1"
	>
		<button
			type="button"
			class="absolute inset-0 bg-black/50"
			onclick={handleClose}
			aria-label="Close dialog"
			disabled={isUploading}
		></button>

		<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:rounded-xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col">
			<header class="border-b border-gray-200 dark:border-gray-700">
				<div class="flex items-center justify-between px-4 py-3">
					<h2 id="upload-dialog-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
						{activeTab === 'upload' ? 'Upload Files' : 'Create Radio Station'}
					</h2>
					<button
						type="button"
						onclick={handleClose}
						disabled={isUploading || isCreatingRadio}
						class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
						aria-label="Close"
					>
						<Icon name="x" size={24} />
					</button>
				</div>
				<div class="flex px-4" role="tablist" tabindex="-1" onkeydown={handleTabKeydown}>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'upload'}
						tabindex={activeTab === 'upload' ? 0 : -1}
						onclick={() => activeTab = 'upload'}
						class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
						class:border-primary-500={activeTab === 'upload'}
						class:text-primary-600={activeTab === 'upload'}
						class:dark:text-primary-400={activeTab === 'upload'}
						class:border-transparent={activeTab !== 'upload'}
						class:text-gray-500={activeTab !== 'upload'}
						class:hover:text-gray-700={activeTab !== 'upload'}
						class:dark:text-gray-400={activeTab !== 'upload'}
						class:dark:hover:text-gray-300={activeTab !== 'upload'}
						disabled={isUploading || isCreatingRadio}
					>
						<Icon name="upload" size={16} class="inline-block mr-1.5 align-text-bottom" />
						Upload
					</button>
					<button
						type="button"
						role="tab"
						aria-selected={activeTab === 'radio'}
						tabindex={activeTab === 'radio' ? 0 : -1}
						onclick={() => activeTab = 'radio'}
						class="px-4 py-2 text-sm font-medium border-b-2 -mb-px transition-colors"
						class:border-primary-500={activeTab === 'radio'}
						class:text-primary-600={activeTab === 'radio'}
						class:dark:text-primary-400={activeTab === 'radio'}
						class:border-transparent={activeTab !== 'radio'}
						class:text-gray-500={activeTab !== 'radio'}
						class:hover:text-gray-700={activeTab !== 'radio'}
						class:dark:text-gray-400={activeTab !== 'radio'}
						class:dark:hover:text-gray-300={activeTab !== 'radio'}
						disabled={isUploading || isCreatingRadio}
					>
						<Icon name="radio" size={16} class="inline-block mr-1.5 align-text-bottom" />
						Radio
					</button>
				</div>
			</header>

			<div class="flex-1 overflow-y-auto p-4 space-y-4">
				{#if error}
					<div class="p-3 bg-red-50 dark:bg-red-900/20 text-red-700 dark:text-red-400 rounded-lg" role="alert">
						{error}
					</div>
				{/if}

				<!-- Upload Tab Panel -->
				{#if activeTab === 'upload'}
					{#if !isUploading}
						<div class="flex gap-2">
							<input
								bind:this={fileInput}
								type="file"
								multiple
								accept="audio/*,.radio"
								onchange={handleFileSelect}
								class="hidden"
								aria-label="Select files"
							/>
							<input
								bind:this={folderInput}
								type="file"
								webkitdirectory
								onchange={handleFileSelect}
								class="hidden"
								aria-label="Select folder"
							/>

							<button
								bind:this={addFilesButton}
								type="button"
								onclick={() => fileInput?.click()}
								class="btn-secondary flex-1"
							>
								<Icon name="file" size={20} class="mr-2" />
								Add Files
							</button>
							<button
								type="button"
								onclick={() => folderInput?.click()}
								class="btn-secondary flex-1"
							>
								<Icon name="folder" size={20} class="mr-2" />
								Add Folder
							</button>
						</div>

						{#if selectedFiles.length > 0}
							<div class="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg text-center">
								<p class="text-2xl font-semibold text-gray-900 dark:text-gray-100">{selectedFiles.length}</p>
								<p class="text-sm text-gray-600 dark:text-gray-400">file{selectedFiles.length !== 1 ? 's' : ''} selected ({formatBytes(totalSize)})</p>
							</div>

							<!-- Preflight summary -->
							{#if preflightLoading}
								<div class="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
									Checking destination folder...
								</div>
							{:else if preflightError}
								<div class="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 rounded-lg text-sm" role="alert">
									{preflightError}
								</div>
							{:else if preflight}
								<section aria-labelledby="upload-summary-heading" class="space-y-2">
									<h3 id="upload-summary-heading" class="text-sm font-medium text-gray-700 dark:text-gray-300">
										What will happen
									</h3>
									<ul class="text-sm space-y-1">
										<li class="flex items-center justify-between text-gray-700 dark:text-gray-300">
											<span class="flex items-center gap-2">
												<Icon name="check" size={14} class="text-green-600 dark:text-green-400" />
												New files (will upload)
											</span>
											<span class="font-medium tabular-nums">{newCount}</span>
										</li>
										<li class="flex items-center justify-between text-gray-700 dark:text-gray-300">
											<span class="flex items-center gap-2">
												<Icon name="more-vertical" size={14} class="text-amber-600 dark:text-amber-400" />
												Conflicts (different size)
											</span>
											<span class="font-medium tabular-nums">
												{conflictCount}
												{#if conflictCount > 0}
													<span class="text-xs ml-1 text-gray-500 dark:text-gray-400">
														{mode === 'sync' ? '— will replace' : '— will skip'}
													</span>
												{/if}
											</span>
										</li>
										<li class="flex items-center justify-between text-gray-700 dark:text-gray-300">
											<span class="flex items-center gap-2">
												<Icon name="check" size={14} class="text-gray-400" />
												Already there (same size)
											</span>
											<span class="font-medium tabular-nums">{identicalCount}</span>
										</li>
										{#if mode === 'sync' && extrasCount > 0}
											<li class="flex items-center justify-between text-red-700 dark:text-red-400">
												<span class="flex items-center gap-2">
													<Icon name="trash" size={14} />
													Extra files in folder (will be DELETED)
												</span>
												<span class="font-medium tabular-nums">{extrasCount}</span>
											</li>
										{:else if extrasCount > 0}
											<li class="flex items-center justify-between text-gray-500 dark:text-gray-400">
												<span class="flex items-center gap-2">
													<Icon name="folder" size={14} />
													Other files in folder (kept)
												</span>
												<span class="font-medium tabular-nums">{extrasCount}</span>
											</li>
										{/if}
									</ul>

									{#if mode === 'sync' && willDeleteCount > 0}
										<div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded-lg text-sm" role="alert">
											<strong>Warning:</strong> Sync mode will permanently delete {willDeleteCount} file{willDeleteCount !== 1 ? 's' : ''} that {willDeleteCount !== 1 ? 'are' : 'is'} in the destination but not in your selection.
										</div>
									{/if}
								</section>
							{/if}

							<fieldset class="space-y-2">
								<legend class="text-sm font-medium text-gray-700 dark:text-gray-300">If a file already exists</legend>
								<div class="space-y-2">
									<label class="flex items-start gap-2 cursor-pointer">
										<input
											type="radio"
											bind:group={mode}
											value="copy"
											tabindex={mode === 'copy' ? 0 : -1}
											class="w-4 h-4 mt-0.5 text-primary-600"
										/>
										<span class="text-sm">
											<span class="block text-gray-900 dark:text-gray-100">Merge — keep existing files</span>
											<span class="block text-xs text-gray-500 dark:text-gray-400">
												Add new files only. Conflicts and extras stay untouched.
											</span>
										</span>
									</label>
									<label class="flex items-start gap-2 cursor-pointer">
										<input
											type="radio"
											bind:group={mode}
											value="sync"
											tabindex={mode === 'sync' ? 0 : -1}
											class="w-4 h-4 mt-0.5 text-primary-600"
										/>
										<span class="text-sm">
											<span class="block text-gray-900 dark:text-gray-100">Sync — mirror selection</span>
											<span class="block text-xs text-gray-500 dark:text-gray-400">
												Replace conflicting files and delete anything else in this folder.
											</span>
										</span>
									</label>
								</div>
							</fieldset>

							<!-- Plan summary for screen readers -->
							<div class="sr-only" aria-live="polite" aria-atomic="true">
								{planAnnouncement}
							</div>
						{/if}
					{/if}
				{/if}

				<!-- Radio Tab Panel -->
				{#if activeTab === 'radio'}
					<div class="space-y-4" role="tabpanel">
						<div>
							<label for="radio-name" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
								Station Name <span class="text-red-500">*</span>
							</label>
							<input
								bind:this={radioNameInput}
								id="radio-name"
								type="text"
								bind:value={radioName}
								placeholder="My Radio Station"
								class="input w-full"
								disabled={isCreatingRadio}
							/>
							<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
								File will be saved as "{radioName.trim() || 'name'}.radio"
							</p>
						</div>

						<div>
							<label for="radio-url" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
								Stream URL <span class="text-red-500">*</span>
							</label>
							<input
								id="radio-url"
								type="url"
								bind:value={radioUrl}
								placeholder="https://stream.example.com/live"
								class="input w-full"
								disabled={isCreatingRadio}
							/>
						</div>

						<details class="group">
							<summary class="text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none">
								Authentication (optional)
							</summary>
							<div class="mt-3 space-y-3 pl-1">
								<div>
									<label for="radio-username" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
										Username
									</label>
									<input
										id="radio-username"
										type="text"
										bind:value={radioUsername}
										placeholder="Optional"
										class="input w-full"
										disabled={isCreatingRadio}
									/>
								</div>
								<div>
									<label for="radio-password" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
										Password
									</label>
									<input
										id="radio-password"
										type="password"
										bind:value={radioPassword}
										placeholder="Optional"
										class="input w-full"
										disabled={isCreatingRadio}
									/>
								</div>
							</div>
						</details>
					</div>
				{/if}

				{#if activeTab === 'upload' && isUploading}
					<div class="space-y-3">
						<div class="text-center">
							<p class="text-lg font-medium text-gray-900 dark:text-gray-100">
								{uploadProgress}%
							</p>
							<p class="text-sm text-gray-600 dark:text-gray-400">
								{#if totalFiles > 0}
									File {Math.min(currentFileIndex + 1, totalFiles)} of {totalFiles}
								{:else}
									Preparing...
								{/if}
							</p>
						</div>
						<div
							class="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"
							role="progressbar"
							aria-valuenow={uploadProgress}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-label="Upload progress"
						>
							<div
								class="h-full bg-primary-500 transition-all duration-150"
								style="width: {uploadProgress}%"
							></div>
						</div>
						<!-- Live region for screen reader announcements -->
						<div
							class="sr-only"
							aria-live="polite"
							aria-atomic="true"
						>
							{progressAnnouncement}
						</div>
					</div>
				{/if}
			</div>

			<footer class="px-4 py-3 border-t border-gray-200 dark:border-gray-700 flex gap-2">
				<button
					type="button"
					onclick={handleClose}
					disabled={isUploading || isCreatingRadio}
					class="btn-secondary flex-1"
				>
					Cancel
				</button>
				{#if activeTab === 'upload'}
					<button
						type="button"
						onclick={startUpload}
						disabled={isUploading || selectedFiles.length === 0 || preflightLoading || !preflight}
						class="btn-primary flex-1"
					>
						{#if isUploading}
							Uploading...
						{:else if preflightLoading}
							Checking...
						{:else if willUploadCount === 0 && willDeleteCount === 0}
							Nothing to do
						{:else}
							Upload
						{/if}
					</button>
				{:else}
					<button
						type="button"
						onclick={handleCreateRadio}
						disabled={isCreatingRadio || !radioName.trim() || !radioUrl.trim()}
						class="btn-primary flex-1"
					>
						{#if isCreatingRadio}
							Creating...
						{:else}
							Create Station
						{/if}
					</button>
				{/if}
			</footer>
		</div>
	</div>
{/if}

<ConfirmDialog
	isOpen={confirmSyncDelete}
	title="Confirm sync"
	message="This will permanently delete {willDeleteCount} file{willDeleteCount !== 1 ? 's' : ''} from the destination folder, and replace {conflictCount} existing file{conflictCount !== 1 ? 's' : ''}. Continue?"
	confirmText="Sync and delete"
	cancelText="Cancel"
	destructive={true}
	onconfirm={handleConfirmSyncDelete}
	oncancel={() => confirmSyncDelete = false}
/>
