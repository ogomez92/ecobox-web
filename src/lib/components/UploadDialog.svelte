<script lang="ts">
	import Icon from './Icon.svelte';
	import { formatBytes } from '$lib/utils/format';
	import type { UploadNegotiateRequest, UploadNegotiateResponse } from '$lib/types';

	interface Props {
		isOpen: boolean;
		currentPath: string;
		onclose: () => void;
		oncomplete: () => void;
	}

	let { isOpen, currentPath, onclose, oncomplete }: Props = $props();

	// Tab state
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

	$effect(() => {
		if (isOpen) {
			if (activeTab === 'upload' && addFilesButton) {
				addFilesButton.focus();
			} else if (activeTab === 'radio' && radioNameInput) {
				radioNameInput.focus();
			}
		}
	});
	let selectedFiles = $state<File[]>([]);
	let mode = $state<'copy' | 'sync'>('copy');
	let isUploading = $state(false);
	let uploadProgress = $state(0);
	let currentFileIndex = $state(0);
	let totalFiles = $state(0);
	let error = $state<string | null>(null);
	let lastAnnouncedProgress = $state(-1);
	let progressAnnouncement = $state('');

	const totalSize = $derived(selectedFiles.reduce((sum, f) => sum + f.size, 0));

	function handleFileSelect(e: Event) {
		const input = e.target as HTMLInputElement;
		if (input.files) {
			selectedFiles = [...selectedFiles, ...Array.from(input.files)];
		}
		input.value = '';
	}

	function clearFiles() {
		selectedFiles = [];
		error = null;
	}

	function clearRadio() {
		radioName = '';
		radioUrl = '';
		radioUsername = '';
		radioPassword = '';
		error = null;
	}

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
					// Calculate progress for current file
					const fileProgress = e.loaded / e.total;
					// Overall progress: completed files + current file progress
					const overallProgress = Math.round(
						((currentFileIndex + fileProgress) / totalFiles) * 100
					);
					uploadProgress = Math.min(overallProgress, 99); // Cap at 99 until fully done

					// Announce every 5%
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

	async function handleUpload() {
		if (selectedFiles.length === 0) return;

		isUploading = true;
		uploadProgress = 0;
		currentFileIndex = 0;
		lastAnnouncedProgress = -1;
		progressAnnouncement = '';
		error = null;

		try {
			// Prepare file list for negotiation
			const fileList = selectedFiles.map(f => ({
				path: f.webkitRelativePath || f.name,
				size: f.size
			}));

			// Negotiate upload
			const negotiateReq: UploadNegotiateRequest = {
				basePath: currentPath,
				mode,
				files: fileList
			};

			const negotiateRes = await fetch('/api/upload/negotiate', {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify(negotiateReq)
			});

			if (!negotiateRes.ok) {
				throw new Error('Failed to negotiate upload');
			}

			const { toUpload, toDelete }: UploadNegotiateResponse = await negotiateRes.json();

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
				// Nothing to upload (all files already exist)
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

			// Small delay to let user see 100% before closing
			await new Promise(resolve => setTimeout(resolve, 500));

			clearFiles();
			onclose();
		} catch (err) {
			error = (err as Error).message;
		} finally {
			isUploading = false;
		}
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
		if (e.key === 'Escape' && !isUploading) {
			handleClose();
		}
	}

	function handleTabKeydown(e: KeyboardEvent) {
		if (isUploading || isCreatingRadio) return;

		if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
			e.preventDefault();
			activeTab = activeTab === 'upload' ? 'radio' : 'upload';
			// Focus the newly selected tab
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
				<div class="flex px-4" role="tablist" onkeydown={handleTabKeydown}>
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

							<fieldset class="space-y-2">
								<legend class="text-sm font-medium text-gray-700 dark:text-gray-300">Upload Mode</legend>
								<div class="flex gap-4">
									<label class="flex items-center gap-2 cursor-pointer">
										<input
											type="radio"
											bind:group={mode}
											value="copy"
											tabindex={mode === 'copy' ? 0 : -1}
											class="w-4 h-4 text-primary-600"
										/>
										<span class="text-sm">Copy (keep existing)</span>
									</label>
									<label class="flex items-center gap-2 cursor-pointer">
										<input
											type="radio"
											bind:group={mode}
											value="sync"
											tabindex={mode === 'sync' ? 0 : -1}
											class="w-4 h-4 text-primary-600"
										/>
										<span class="text-sm">Sync (replace)</span>
									</label>
								</div>
							</fieldset>
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
						onclick={handleUpload}
						disabled={isUploading || selectedFiles.length === 0}
						class="btn-primary flex-1"
					>
						{#if isUploading}
							Uploading...
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
