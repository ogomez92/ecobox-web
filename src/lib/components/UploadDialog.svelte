<script lang="ts">
	import Icon from './Icon.svelte';
	import ConfirmDialog from './ConfirmDialog.svelte';
	import { formatBytes } from '$lib/utils/format';
	import { t } from '$lib/i18n/index.svelte';
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
			? willDeleteCount > 0
				? t('upload.planAnnounceWithDelete', { up: willUploadCount, skip: willSkipCount, del: willDeleteCount })
				: t('upload.planAnnounce', { up: willUploadCount, skip: willSkipCount })
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
					preflightError = t('upload.checkError');
					preflight = null;
				} else {
					preflight = await res.json();
				}
			})
			.catch(() => {
				if (!cancelled) {
					preflightError = t('upload.checkError');
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
			error = t('radio.requiredError');
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
				throw new Error(t('radio.createFailed'));
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
						progressAnnouncement = t('upload.uploadingProgress', { pct: progressToAnnounce, n: currentFileIndex + 1, total: totalFiles });
					}
				}
			});

			xhr.addEventListener('load', () => {
				if (xhr.status >= 200 && xhr.status < 300) {
					resolve();
				} else {
					reject(new Error(t('upload.failedFile', { name: file.name })));
				}
			});

			xhr.addEventListener('error', () => {
				reject(new Error(t('upload.failedFile', { name: file.name })));
			});

			xhr.addEventListener('abort', () => {
				reject(new Error(t('upload.cancelled')));
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
				progressAnnouncement = t('upload.completeNoFiles');
			} else {
				progressAnnouncement = t(totalFiles === 1 ? 'upload.startingOne' : 'upload.startingOther', { n: totalFiles });

				for (let i = 0; i < filesToUpload.length; i++) {
					currentFileIndex = i;
					const file = filesToUpload[i];

					const filePath = currentPath
						? `${currentPath}/${file.webkitRelativePath || file.name}`
						: file.webkitRelativePath || file.name;

					await uploadFile(file, filePath);
				}

				uploadProgress = 100;
				progressAnnouncement = t(totalFiles === 1 ? 'upload.completeOne' : 'upload.completeOther', { n: totalFiles });
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
			aria-label={t('common.closeDialog')}
			disabled={isUploading}
		></button>

		<div class="relative bg-white dark:bg-gray-800 w-full sm:max-w-lg sm:rounded-xl shadow-xl max-h-[90vh] overflow-hidden flex flex-col">
			<header class="border-b border-gray-200 dark:border-gray-700">
				<div class="flex items-center justify-between px-4 py-3">
					<h2 id="upload-dialog-title" class="text-lg font-semibold text-gray-900 dark:text-gray-100">
						{activeTab === 'upload' ? t('upload.title') : t('upload.createRadioTitle')}
					</h2>
					<button
						type="button"
						onclick={handleClose}
						disabled={isUploading || isCreatingRadio}
						class="btn-icon p-2 text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
						aria-label={t('common.close')}
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
						{t('upload.uploadTab')}
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
						{t('upload.radioTab')}
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
								aria-label={t('upload.selectFiles')}
							/>
							<input
								bind:this={folderInput}
								type="file"
								webkitdirectory
								onchange={handleFileSelect}
								class="hidden"
								aria-label={t('upload.selectFolder')}
							/>

							<button
								bind:this={addFilesButton}
								type="button"
								onclick={() => fileInput?.click()}
								class="btn-secondary flex-1"
							>
								<Icon name="file" size={20} class="mr-2" />
								{t('upload.addFiles')}
							</button>
							<button
								type="button"
								onclick={() => folderInput?.click()}
								class="btn-secondary flex-1"
							>
								<Icon name="folder" size={20} class="mr-2" />
								{t('upload.addFolder')}
							</button>
						</div>

						{#if selectedFiles.length > 0}
							<div class="p-4 bg-gray-50 dark:bg-gray-700 rounded-lg text-center">
								<p class="text-2xl font-semibold text-gray-900 dark:text-gray-100">{selectedFiles.length}</p>
								<p class="text-sm text-gray-600 dark:text-gray-400">{t(selectedFiles.length === 1 ? 'upload.fileSelected' : 'upload.filesSelected', { count: selectedFiles.length, size: formatBytes(totalSize) })}</p>
							</div>

							<!-- Preflight summary -->
							{#if preflightLoading}
								<div class="text-sm text-gray-600 dark:text-gray-400" aria-live="polite">
									{t('upload.checking')}
								</div>
							{:else if preflightError}
								<div class="p-3 bg-amber-50 dark:bg-amber-900/20 text-amber-800 dark:text-amber-300 rounded-lg text-sm" role="alert">
									{preflightError}
								</div>
							{:else if preflight}
								<section aria-labelledby="upload-summary-heading" class="space-y-2">
									<h3 id="upload-summary-heading" class="text-sm font-medium text-gray-700 dark:text-gray-300">
										{t('upload.summaryHeading')}
									</h3>
									<ul class="text-sm space-y-1">
										<li class="flex items-center justify-between text-gray-700 dark:text-gray-300">
											<span class="flex items-center gap-2">
												<Icon name="check" size={14} class="text-green-600 dark:text-green-400" />
												{t('upload.newFiles')}
											</span>
											<span class="font-medium tabular-nums">{newCount}</span>
										</li>
										<li class="flex items-center justify-between text-gray-700 dark:text-gray-300">
											<span class="flex items-center gap-2">
												<Icon name="more-vertical" size={14} class="text-amber-600 dark:text-amber-400" />
												{t('upload.conflicts')}
											</span>
											<span class="font-medium tabular-nums">
												{conflictCount}
												{#if conflictCount > 0}
													<span class="text-xs ml-1 text-gray-500 dark:text-gray-400">
														{mode === 'sync' ? t('upload.willReplace') : t('upload.willSkip')}
													</span>
												{/if}
											</span>
										</li>
										<li class="flex items-center justify-between text-gray-700 dark:text-gray-300">
											<span class="flex items-center gap-2">
												<Icon name="check" size={14} class="text-gray-400" />
												{t('upload.identical')}
											</span>
											<span class="font-medium tabular-nums">{identicalCount}</span>
										</li>
										{#if mode === 'sync' && extrasCount > 0}
											<li class="flex items-center justify-between text-red-700 dark:text-red-400">
												<span class="flex items-center gap-2">
													<Icon name="trash" size={14} />
													{t('upload.extras')}
												</span>
												<span class="font-medium tabular-nums">{extrasCount}</span>
											</li>
										{:else if extrasCount > 0}
											<li class="flex items-center justify-between text-gray-500 dark:text-gray-400">
												<span class="flex items-center gap-2">
													<Icon name="folder" size={14} />
													{t('upload.kept')}
												</span>
												<span class="font-medium tabular-nums">{extrasCount}</span>
											</li>
										{/if}
									</ul>

									{#if mode === 'sync' && willDeleteCount > 0}
										<div class="p-3 bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 text-red-800 dark:text-red-300 rounded-lg text-sm" role="alert">
											<strong>{t('upload.warning')}</strong> {t(willDeleteCount === 1 ? 'upload.syncWarningOne' : 'upload.syncWarningOther', { n: willDeleteCount })}
										</div>
									{/if}
								</section>
							{/if}

							<fieldset class="space-y-2">
								<legend class="text-sm font-medium text-gray-700 dark:text-gray-300">{t('upload.ifExists')}</legend>
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
											<span class="block text-gray-900 dark:text-gray-100">{t('upload.modeMerge')}</span>
											<span class="block text-xs text-gray-500 dark:text-gray-400">
												{t('upload.modeMergeDesc')}
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
											<span class="block text-gray-900 dark:text-gray-100">{t('upload.modeSync')}</span>
											<span class="block text-xs text-gray-500 dark:text-gray-400">
												{t('upload.modeSyncDesc')}
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
								{t('radio.stationName')} <span class="text-red-500">*</span>
							</label>
							<input
								bind:this={radioNameInput}
								id="radio-name"
								type="text"
								bind:value={radioName}
								placeholder={t('radio.placeholderName')}
								class="input w-full"
								disabled={isCreatingRadio}
							/>
							<p class="mt-1 text-xs text-gray-500 dark:text-gray-400">
								{t('radio.fileSavedAs', { name: radioName.trim() || t('radio.placeholderFallback') })}
							</p>
						</div>

						<div>
							<label for="radio-url" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
								{t('radio.streamUrl')} <span class="text-red-500">*</span>
							</label>
							<input
								id="radio-url"
								type="url"
								bind:value={radioUrl}
								placeholder={t('radio.placeholderUrl')}
								class="input w-full"
								disabled={isCreatingRadio}
							/>
						</div>

						<details class="group">
							<summary class="text-sm font-medium text-gray-700 dark:text-gray-300 cursor-pointer select-none">
								{t('radio.auth')}
							</summary>
							<div class="mt-3 space-y-3 pl-1">
								<div>
									<label for="radio-username" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
										{t('radio.username')}
									</label>
									<input
										id="radio-username"
										type="text"
										bind:value={radioUsername}
										placeholder={t('radio.optional')}
										class="input w-full"
										disabled={isCreatingRadio}
									/>
								</div>
								<div>
									<label for="radio-password" class="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1">
										{t('radio.password')}
									</label>
									<input
										id="radio-password"
										type="password"
										bind:value={radioPassword}
										placeholder={t('radio.optional')}
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
									{t('upload.fileOf', { n: Math.min(currentFileIndex + 1, totalFiles), total: totalFiles })}
								{:else}
									{t('upload.preparing')}
								{/if}
							</p>
						</div>
						<div
							class="h-3 bg-gray-200 dark:bg-gray-700 rounded-full overflow-hidden"
							role="progressbar"
							aria-valuenow={uploadProgress}
							aria-valuemin={0}
							aria-valuemax={100}
							aria-label={t('upload.progressAria')}
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
					{t('common.cancel')}
				</button>
				{#if activeTab === 'upload'}
					<button
						type="button"
						onclick={startUpload}
						disabled={isUploading || selectedFiles.length === 0 || preflightLoading || !preflight}
						class="btn-primary flex-1"
					>
						{#if isUploading}
							{t('upload.uploading')}
						{:else if preflightLoading}
							{t('upload.checkingShort')}
						{:else if willUploadCount === 0 && willDeleteCount === 0}
							{t('upload.nothingToDo')}
						{:else}
							{t('upload.upload')}
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
							{t('radio.creating')}
						{:else}
							{t('radio.createStation')}
						{/if}
					</button>
				{/if}
			</footer>
		</div>
	</div>
{/if}

<ConfirmDialog
	isOpen={confirmSyncDelete}
	title={t('upload.confirmSync')}
	message={t(willDeleteCount === 1 ? 'upload.confirmSyncMessageOne' : 'upload.confirmSyncMessageOther', { del: willDeleteCount, conflict: conflictCount })}
	confirmText={t('upload.syncAndDelete')}
	cancelText={t('common.cancel')}
	destructive={true}
	onconfirm={handleConfirmSyncDelete}
	oncancel={() => confirmSyncDelete = false}
/>
