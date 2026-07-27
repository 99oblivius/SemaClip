<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn, staggerIn, hoverLift } from '$lib/actions/gsap';
  import type { Stream, ImportByUrlInput, ImportByFileInput } from '$shared/types';
  import { browser } from '$app/environment';

  const queryClient = useQueryClient();

  const streamsQuery = createQuery(() => ({
    queryKey: ['streams'],
    queryFn: () => apiClient.listStreams(),
  }));

  const importUrlMutation = createMutation(() => ({
    mutationFn: (input: ImportByUrlInput) => apiClient.importByUrl(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  const importFileMutation = createMutation(() => ({
    mutationFn: (input: ImportByFileInput) => apiClient.importByFile(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  const uploadVodMutation = createMutation(() => ({
    mutationFn: (file: File) => apiClient.uploadVod(file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  const uploadChatMutation = createMutation(() => ({
    mutationFn: ({ streamId, file }: { streamId: string; file: File }) =>
      apiClient.uploadChat(streamId, file),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  let urlInput = $state('');
  let pathInput = $state('');
  let streams = $derived(streamsQuery.data ?? []);
  let showEmpty = $derived(streams.length === 0);

  // Drag state for the dropzone visual feedback.
  let isDraggingVod = $state(false);
  let dragCounter = $state(0);

  function fmtDuration(sec: number | null): string {
    if (!sec) return '--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function handleUrlImport() {
    if (!urlInput.trim()) return;
    importUrlMutation.mutate({ url: urlInput.trim() });
    urlInput = '';
  }

  function handlePathImport() {
    if (!pathInput.trim()) return;
    importFileMutation.mutate({
      vodPath: pathInput.trim(),
      title: pathInput.trim().split('/').pop()?.replace(/\.[^.]+$/, ''),
    });
    pathInput = '';
  }



  function handleVodDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingVod = false;
    dragCounter = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    // Find the video file (by extension) and chat file (JSON) among dropped files.
    const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.ts'];
    const videoFile = Array.from(files).find((f) =>
      videoExt.some((ext) => f.name.toLowerCase().endsWith(ext)),
    );
    const chatFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith('.json'));

    if (videoFile) {
      uploadVodMutation.mutate(videoFile, {
        onSuccess: (result) => {
          if (chatFile) {
            uploadChatMutation.mutate({ streamId: result.stream.id, file: chatFile });
          }
        },
      });
    } else if (chatFile) {
      // Only chat dropped — can't attach without a stream yet.
    }
  }

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer?.types?.includes('Files')) {
      isDraggingVod = true;
    }
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) {
      isDraggingVod = false;
      dragCounter = 0;
    }
  }

  const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.ts'];
  function isVideoPath(path: string): boolean {
    return videoExt.some((ext) => path.toLowerCase().endsWith(ext));
  }

  // Pending chat files that need a stream to attach to
  let pendingChatFile = $state<File | null>(null);

  function handleChatDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const chatFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith('.json'));
    if (chatFile) pendingChatFile = chatFile;
  }

  // Attach pending chat to a stream on click
  function attachChatToStream(streamId: string) {
    if (!pendingChatFile) return;
    uploadChatMutation.mutate(
      { streamId, file: pendingChatFile },
      { onSuccess: () => (pendingChatFile = null) },
    );
  }
</script>

<div class="flex h-full flex-col overflow-y-auto p-6" use:fadeIn role="region" aria-label="Library">
  <!-- VOD Dropzone -->
  <section class="mb-4">
    <div
      class="relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-8 transition-all duration-150
        {isDraggingVod
        ? 'border-accent bg-accent/5 accent-glow'
        : 'border-border bg-surface hover:border-border-strong'}"
      ondrop={handleVodDrop}
      ondragover={(e) => e.preventDefault()}
      ondragenter={handleDragEnter}
      ondragleave={handleDragLeave}
      role="button"
      tabindex="0"
      aria-label="Drop VOD and chat files here"
    >
      <Icon name="download" size={32} fill={false} />
      <span class="font-display text-base {isDraggingVod ? 'text-accent' : 'text-ink'}">
        {isDraggingVod ? 'Drop to import' : 'Drop VOD + chat files here'}
      </span>
      <span class="text-xs text-ash-dim">
        Video (.mp4, .mkv, .webm) and chat (.json) — drop together or separately
      </span>

      <!-- Drag overlay -->
      {#if isDraggingVod}
        <div class="pointer-events-none absolute inset-0 flex items-center justify-center rounded-lg bg-accent/5">
          <span class="text-accent opacity-30"><Icon name="download" size={48} fill={false} /></span>
        </div>
      {/if}
    </div>
  </section>

  <!-- URL import -->
  <section class="mb-4">
    <div class="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 transition-colors focus-within:border-accent">
      <Icon name="link" size={16} fill={false} />
      <input
        type="text"
        bind:value={urlInput}
        onkeydown={(e) => e.key === 'Enter' && handleUrlImport()}
        placeholder="Paste Twitch VOD URL to auto-download"
        class="flex-1 bg-transparent text-sm text-ink placeholder:text-ash-dim focus:outline-none"
        aria-label="Twitch VOD URL"
      />
      <button
        class="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        onclick={handleUrlImport}
        disabled={importUrlMutation.isPending || !urlInput.trim()}
        use:hoverLift
      >
        Download
      </button>
    </div>
  </section>

  <!-- Path import (for pre-downloaded files) -->
  <section class="mb-6">
    <div class="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 transition-colors focus-within:border-accent">
      <Icon name="search" size={16} fill={false} />
      <input
        type="text"
        bind:value={pathInput}
        onkeydown={(e) => e.key === 'Enter' && handlePathImport()}
        placeholder="Or enter local file path (e.g. ~/SemaClip/data/training/video.mp4)"
        class="flex-1 bg-transparent text-sm text-ink placeholder:text-ash-dim focus:outline-none"
        aria-label="Local file path"
      />
      <button
        class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ash transition-colors hover:text-ink hover:border-border-strong disabled:opacity-50"
        onclick={handlePathImport}
        disabled={importFileMutation.isPending || !pathInput.trim() || !isVideoPath(pathInput.trim())}
        use:hoverLift
      >
        Import
      </button>
    </div>
    {#if pathInput.trim() && !isVideoPath(pathInput.trim())}
      <p class="mt-1 px-3 text-xs text-warning">Path must end with a video extension (.mp4, .mkv, .webm, etc.)</p>
    {/if}
  </section>

  <!-- Pending chat file indicator -->
  {#if pendingChatFile}
    <section class="mb-4">
      <div class="flex items-center gap-2 rounded-md border border-warning bg-surface px-3 py-2">
        <Icon name="alert" size={16} fill={false} />
        <span class="text-xs text-ash">
          Chat file ready: {pendingChatFile.name} — click a stream below to attach it
        </span>
        <button class="ml-auto text-xs text-ash-dim hover:text-ink" onclick={() => (pendingChatFile = null)}>
          Cancel
        </button>
      </div>
    </section>
  {/if}

  <!-- Error display -->
  {#if importUrlMutation.isError}
    <div class="mb-4 rounded-md border border-error bg-surface px-3 py-2 text-xs text-error">
      {importUrlMutation.error?.message ?? 'Import failed'}
    </div>
  {/if}
  {#if importFileMutation.isError}
    <div class="mb-4 rounded-md border border-error bg-surface px-3 py-2 text-xs text-error">
      {importFileMutation.error?.message ?? 'Import failed'}
    </div>
  {/if}
  {#if uploadVodMutation.isError}
    <div class="mb-4 rounded-md border border-error bg-surface px-3 py-2 text-xs text-error">
      {uploadVodMutation.error?.message ?? 'Upload failed'}
    </div>
  {/if}

  <!-- Stream list -->
  {#if showEmpty}
    <div class="flex flex-1 flex-col items-center justify-center gap-3 text-center">
      <Icon name="waveform" size={48} fill={false} />
      <p class="font-display text-lg text-ash">Drop a Twitch VOD to begin</p>
      <p class="text-sm text-ash-dim">or paste a URL / file path above</p>
    </div>
  {:else}
    <section>
      <h2 class="mb-3 font-display text-sm font-medium text-ash uppercase tracking-wider">Recent</h2>
      <div class="flex flex-col gap-1" use:staggerIn>
        {#each streams as stream (stream.id)}
          <div class="flex items-center gap-4 rounded-md border border-transparent bg-surface px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface-2">
            <a href="/stream/{stream.id}" class="flex flex-1 items-center gap-4" use:hoverLift>
              <div class="flex flex-1 flex-col gap-0.5">
                <span class="text-sm font-medium text-ink">{stream.title ?? 'Untitled Stream'}</span>
                <span class="font-mono text-xs text-ash">
                  {stream.streamer ?? 'unknown'} · {fmtDuration(stream.duration)} · {fmtDate(stream.createdAt)}
                </span>
              </div>
              <div class="flex items-center gap-2">
                {#if stream.status === 'processing'}
                  <span class="flex items-center gap-1 font-mono text-xs text-warning">
                    <Icon name="cpu" size={14} /> processing
                  </span>
                {:else if stream.status === 'completed'}
                  <span class="font-mono text-xs text-success">✓ done</span>
                {/if}
                {#if !stream.chatPath}
                  <span class="font-mono text-xs text-ash-dim">no chat</span>
                {/if}
              </div>
            </a>
            {#if pendingChatFile}
              <button
                class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent"
                onclick={() => attachChatToStream(stream.id)}
              >
                <Icon name="plus" size={12} />
                Attach chat
              </button>
            {/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
</div>
