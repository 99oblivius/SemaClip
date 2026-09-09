<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import DownloadProgress from '$lib/components/DownloadProgress.svelte';
  import { fadeIn, staggerIn, hoverLift } from '$lib/actions/gsap';
  import type { Stream, Job, ImportByUrlInput, ImportByFileInput } from '$shared/types';
  import type { QualityInfo } from '$lib/api/download';

  const queryClient = useQueryClient();

  const streamsQuery = createQuery(() => ({
    queryKey: ['streams'],
    queryFn: () => apiClient.listStreams(),
  }));

  const jobsQuery = createQuery(() => ({
    queryKey: ['jobs'],
    queryFn: () => apiClient.listJobs(),
    refetchInterval: 3000,
  }));

  const importUrlMutation = createMutation(() => ({
    mutationFn: (input: ImportByUrlInput) => apiClient.importByUrl(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  const importFileMutation = createMutation(() => ({
    mutationFn: (input: ImportByFileInput) => apiClient.importByFile(input),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['streams'] }),
  }));

  const cancelMutation = createMutation(() => ({
    mutationFn: (jobId: string) => apiClient.cancelJob(jobId),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  }));

  // ── Download options (always visible). URL downloads are chunk-live by
  // default; scrubFirst opts into the two-file 540p-first system. ──
  let scrubFirst = $state(false);
  let maxQualityHeight = $state<number | null>(null); // null = no cap
  const settingsForDefaults = createQuery(() => ({
    queryKey: ['settings'],
    queryFn: () => apiClient.getSettings(),
    staleTime: 30_000,
  }));
  // Qualities resolved from the pasted URL (fetched lazily, debounced by URL change).
  let qualities = $state<QualityInfo[]>([]);
  let qualitiesError = $state<string | null>(null);
  let qualitiesLoading = $state(false);
  let lastQueriedUrl = '';

  $effect(() => {
    const url = urlInput.trim();
    if (!url || url === lastQueriedUrl) return;
    lastQueriedUrl = url;
    qualitiesLoading = true;
    qualitiesError = null;
    apiClient.listQualities(url)
      .then((d) => {
        qualities = d.qualities;
        // Default the max-quality select to the settings default (if the
        // source has it), else the highest available.
        if (d.qualities.length > 0 && maxQualityHeight === null) {
          const def = settingsForDefaults.data?.defaultMaxQualityHeight ?? null;
          const available = d.qualities.map((q) => q.height);
          if (def !== null && available.includes(def)) {
            maxQualityHeight = def;
          } else {
            maxQualityHeight = Math.max(...available);
          }
        }
      })
      .catch((err: Error) => (qualitiesError = err.message))
      .finally(() => (qualitiesLoading = false));
  });

  function handleUrlImport() {
    if (!urlInput.trim()) return;
    importUrlMutation.mutate({
      url: urlInput.trim(),
      progressive: true,
      scrubHeightCap: 540,
      maxQualityHeight,
      includeScrub: scrubFirst,
    });
    urlInput = '';
  }

  const queueMutation = createMutation(() => ({
    mutationFn: (action: Parameters<typeof apiClient.manageQueue>[0]) => apiClient.manageQueue(action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  }));

  let urlInput = $state('');
  let pathInput = $state('');
  let streams = $derived(streamsQuery.data ?? []);
  let jobs = $derived(jobsQuery.data ?? []);
  let runningJobs = $derived(jobs.filter((j) => j.status === 'running'));
  let queuedJobs = $derived(jobs.filter((j) => j.status === 'queued').sort((a, b) => a.position - b.position));

  // P0-1: channel is a first-class filter column.
  let activeChannel = $state<string | null>(null);
  const channels = $derived(
    [...new Set(streams.map((s) => s.streamer).filter((c): c is string => Boolean(c)))].sort(),
  );
  let filteredStreams = $derived(
    activeChannel ? streams.filter((s) => s.streamer === activeChannel) : streams,
  );

  // Track the last-opened stream so the rail's Review entry routes there.
  function openStream(id: string) {
    try { localStorage.setItem('semaclip-last-stream', id); } catch { /* private mode */ }
    window.location.href = `/stream/${id}`;
  }

  function fmtDuration(sec: number | null): string {
    if (!sec) return '--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${m}m` : `${m}m`;
  }

  function fmtDate(iso: string): string {
    return new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function handlePathImport() {
    if (!pathInput.trim()) return;
    importFileMutation.mutate({
      vodPath: pathInput.trim(),
      title: pathInput.trim().split('/').pop()?.replace(/\.[^.]+$/, ''),
    });
    pathInput = '';
  }

  const videoExt = ['.mp4', '.mkv', '.webm', '.mov', '.avi', '.ts'];
  function isVideoPath(path: string): boolean {
    return videoExt.some((ext) => path.toLowerCase().endsWith(ext));
  }

  // Drag state for the dropzone visual feedback.
  let isDraggingVod = $state(false);
  let dragCounter = $state(0);
  let dropHint = $state<string | null>(null);

  function handleVodDrop(e: DragEvent) {
    e.preventDefault();
    isDraggingVod = false;
    dragCounter = 0;
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;

    const videoFile = Array.from(files).find((f) => videoExt.some((ext) => f.name.toLowerCase().endsWith(ext)));
    const chatFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith('.json'));

    if (!videoFile) return;
    const vodPath = (videoFile as File & { path?: string }).path;
    if (vodPath) {
      importFileMutation.mutate({
        vodPath,
        title: videoFile.name.replace(/\.[^.]+$/, ''),
        ...(chatFile && { chatPath: (chatFile as File & { path?: string }).path ?? undefined }),
      });
    } else {
      pathInput = videoFile.name;
      dropHint = `Path not available in browser dev mode. Enter the full path to "${videoFile.name}" and press Enter.`;
    }
  }

  function handleDragEnter(e: DragEvent) {
    e.preventDefault();
    dragCounter++;
    if (e.dataTransfer?.types?.includes('Files')) isDraggingVod = true;
  }

  function handleDragLeave(e: DragEvent) {
    e.preventDefault();
    dragCounter--;
    if (dragCounter <= 0) { isDraggingVod = false; dragCounter = 0; }
  }

  // Pending chat file path that needs a stream to attach to.
  let pendingChatPath = $state<string | null>(null);

  function handleChatDrop(e: DragEvent) {
    e.preventDefault();
    const files = e.dataTransfer?.files;
    if (!files || files.length === 0) return;
    const chatFile = Array.from(files).find((f) => f.name.toLowerCase().endsWith('.json'));
    if (chatFile) {
      const path = (chatFile as File & { path?: string }).path;
      if (path) pendingChatPath = path;
    }
  }

  function attachChatToStream(streamId: string) {
    if (!pendingChatPath) return;
    apiClient.attachChat(streamId, pendingChatPath).then(() => {
      pendingChatPath = null;
      queryClient.invalidateQueries({ queryKey: ['streams'] });
    });
  }

  function jobElapsed(startedAt: string | null): string {
    if (!startedAt) return '--';
    const sec = Math.floor((Date.now() - new Date(startedAt).getTime()) / 1000);
    return `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;
  }

  function streamTitle(id: string): string {
    return streams.find((s) => s.id === id)?.title ?? id.slice(0, 8);
  }
</script>

<div class="flex h-full flex-col overflow-y-auto p-6" use:fadeIn role="region" aria-label="Library">
  <div class="mx-auto flex w-full max-w-3xl flex-col gap-5">
    <!-- Import bar (P0-2): dropzone + URL + path, always first -->
    <section>
      <div
        class="relative flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-6 transition-all duration-150
        {isDraggingVod ? 'border-accent bg-accent/5 accent-glow' : 'border-border bg-surface hover:border-border-strong'}"
        ondrop={handleVodDrop}
        ondragover={(e) => e.preventDefault()}
        ondragenter={handleDragEnter}
        ondragleave={handleDragLeave}
        role="button"
        tabindex="0"
        aria-label="Drop VOD and chat files here"
      >
        <Icon name="download" size={26} fill={false} />
        <span class="font-display text-sm {isDraggingVod ? 'text-accent' : 'text-ink'}">
          {isDraggingVod ? 'Drop to import' : 'Drop VOD + chat files here'}
        </span>
        <span class="text-xs text-ash-dim">Video (.mp4, .mkv, .webm) and chat (.json) — drop together or separately</span>
      </div>
      <div class="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 transition-colors focus-within:border-accent">
        <Icon name="link" size={15} fill={false} />
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
        >
          Download
        </button>
      </div>

      <!-- Download options (always visible; live-chunked download is the
           only URL path — chunks scrub as they land). The toggle chooses
           the two-file scrub-first system (opt-in) vs a single download. -->
      <div class="mt-2 flex flex-wrap items-center gap-3 rounded-md border border-border bg-surface px-3 py-2.5">
        <span class="font-mono text-xs text-ash-dim">Max quality:</span>
        {#if qualitiesLoading}
          <span class="font-mono text-xs text-ash-dim">resolving…</span>
        {:else if qualitiesError}
          <span class="font-mono text-xs text-error">{qualitiesError}</span>
        {:else if qualities.length > 0}
          <select
            bind:value={maxQualityHeight}
            class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
            aria-label="Maximum download quality"
          >
            {#each qualities as q (q.name)}
              <option value={q.height}>
                {q.name} ({q.width}×{q.height})
              </option>
            {/each}
            <option value={null}>No cap</option>
          </select>
        {:else}
          <span class="font-mono text-xs text-ash-dim">paste a URL to list qualities</span>
        {/if}
        <label class="flex items-center gap-2 text-xs text-ash">
          <input type="checkbox" bind:checked={scrubFirst} class="accent-accent" />
          <span class="font-medium">540p scrub-first</span>
          <span class="text-ash-dim">— separate 540p file scrubs immediately; full quality follows in the background. Off = one download at max quality (still scrubbable while it lands).</span>
        </label>
      </div>
      <div class="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 transition-colors focus-within:border-accent">
        <Icon name="folder" size={15} fill={false} />
        <input
          type="text"
          bind:value={pathInput}
          onkeydown={(e) => e.key === 'Enter' && handlePathImport()}
          placeholder="Or enter a local file path"
          class="flex-1 bg-transparent text-sm text-ink placeholder:text-ash-dim focus:outline-none"
          aria-label="Local file path"
        />
        <button
          class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ash transition-colors hover:text-ink hover:border-border-strong disabled:opacity-50"
          onclick={handlePathImport}
          disabled={importFileMutation.isPending || !pathInput.trim() || !isVideoPath(pathInput.trim())}
        >
          Import
        </button>
      </div>
      {#if pathInput.trim() && !isVideoPath(pathInput.trim())}
        <p class="mt-1 px-3 text-xs text-warning">Path must end with a video extension (.mp4, .mkv, .webm, etc.)</p>
      {/if}
      {#if dropHint}
        <div class="mt-2 flex items-center gap-2 rounded-md border border-warning bg-surface px-3 py-2 text-xs text-warning">
          <Icon name="alert" size={14} fill={false} />
          <span class="flex-1">{dropHint}</span>
          <button class="text-ash-dim hover:text-ink" onclick={() => (dropHint = null)} aria-label="Dismiss">
            <Icon name="close" size={13} />
          </button>
        </div>
      {/if}
      {#if importUrlMutation.isError || importFileMutation.isError}
        <div class="mt-2 rounded-md border border-error bg-surface px-3 py-2 text-xs text-error">
          {importUrlMutation.error?.message ?? importFileMutation.error?.message ?? 'Import failed'}
        </div>
      {/if}
    </section>

    <!-- Channel strip (P0-1) -->
    {#if channels.length > 0}
      <section class="flex items-center gap-2" aria-label="Channel filter">
        <span class="font-mono text-xs uppercase tracking-wider text-ash-dim">Channels</span>
        <button
          class="rounded-full border px-3 py-1 text-xs transition-colors
          {activeChannel === null ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
          onclick={() => (activeChannel = null)}
        >
          All
        </button>
        {#each channels as channel (channel)}
          <button
            class="rounded-full border px-3 py-1 text-xs transition-colors
            {activeChannel === channel ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
            onclick={() => (activeChannel = activeChannel === channel ? null : channel)}
          >
            {channel}
          </button>
        {/each}
      </section>
    {/if}

    <!-- Progressive download progress (unified bar + itemized popover) -->
    {#if streams.length > 0}
      <section class="flex flex-col gap-2" aria-label="Download progress">
        {#each streams.filter((s) => s.sourceUrl) as stream (stream.id)}
          <DownloadProgress streamId={stream.id} />
        {/each}
      </section>
    {/if}

    <!-- Running jobs (pinned, live) -->
    {#if runningJobs.length > 0}
      <section class="flex flex-col gap-1" aria-label="Processing now">
        {#each runningJobs as job (job.id)}
          <div class="flex items-center gap-3 rounded-md border border-warning/40 bg-surface px-4 py-2.5">
            <Icon name="cpu" size={15} class="animate-pulse text-warning" />
            <a href="/stream/{job.streamId}/processing" class="flex-1 truncate text-sm text-ink hover:text-accent">
              {streamTitle(job.streamId)}
            </a>
            <span class="font-mono text-xs text-ash-dim">{jobElapsed(job.startedAt)}</span>
            <button
              class="rounded border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-error hover:text-error"
              onclick={() => cancelMutation.mutate(job.id)}
            >
              Cancel
            </button>
          </div>
        {/each}
      </section>
    {/if}

    <!-- Stream list -->
    {#if filteredStreams.length === 0 && streams.length === 0}
      <div class="flex flex-col items-center justify-center gap-3 py-16 text-center">
        <Icon name="waveform" size={40} fill={false} />
        <p class="font-display text-base text-ash">Drop a Twitch VOD to begin</p>
        <p class="text-sm text-ash-dim">or paste a URL / file path above</p>
      </div>
    {:else if filteredStreams.length === 0}
      <div class="py-12 text-center text-sm text-ash-dim">No streams for this channel.</div>
    {:else}
      <section class="flex flex-col gap-1">
        <h2 class="mb-1 font-mono text-xs uppercase tracking-wider text-ash-dim">Recent</h2>
        <div class="flex flex-col gap-1" use:staggerIn>
          {#each filteredStreams as stream (stream.id)}
            <div class="flex items-center gap-3 rounded-md border border-transparent bg-surface px-4 py-3 transition-colors hover:border-border-strong hover:bg-surface-2">
              <button class="flex flex-1 items-center gap-3 text-left" onclick={() => openStream(stream.id)} use:hoverLift>
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-sm font-medium text-ink">{stream.title ?? 'Untitled Stream'}</span>
                  <span class="font-mono text-xs text-ash">
                    {stream.streamer ?? 'unknown'} · {fmtDuration(stream.duration)} · {fmtDate(stream.createdAt)}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  {#if stream.status === 'processing'}
                    <span class="flex items-center gap-1 font-mono text-xs text-warning"><Icon name="cpu" size={13} /> processing</span>
                  {:else if stream.status === 'completed'}
                    <span class="font-mono text-xs text-success">✓</span>
                  {:else if stream.status === 'failed'}
                    <span class="font-mono text-xs text-error">failed</span>
                  {/if}
                  {#if !stream.chatPath}
                    <span class="font-mono text-xs text-ash-dim">no chat</span>
                  {/if}
                </div>
              </button>
              {#if pendingChatPath}
                <button
                  class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent"
                  onclick={() => attachChatToStream(stream.id)}
                >
                  <Icon name="plus" size={11} /> Attach chat
                </button>
              {/if}
            </div>
          {/each}
        </div>
      </section>
    {/if}

    <!-- Queue (bottom, collapsed when empty) -->
    {#if queuedJobs.length > 0}
      <section class="flex flex-col gap-1" aria-label="Queue">
        <h2 class="mb-1 font-mono text-xs uppercase tracking-wider text-ash-dim">Queued ({queuedJobs.length})</h2>
        {#each queuedJobs as job, i (job.id)}
          <div class="flex items-center gap-3 rounded-md border border-border bg-surface px-4 py-2">
            <span class="w-5 text-right font-mono text-xs text-ash-dim">{i + 1}.</span>
            <span class="flex-1 truncate text-sm text-ash">{streamTitle(job.streamId)}</span>
            <button
              class="flex h-6 w-6 items-center justify-center rounded text-ash-dim transition-colors hover:text-ink disabled:opacity-30"
              onclick={() => queueMutation.mutate({ type: 'reorder', jobId: job.id, newPosition: Math.max(0, job.position - 1) })}
              disabled={i === 0}
              aria-label="Move up"
            >
              <Icon name="chevron-left" size={13} class="rotate-90" />
            </button>
            <button
              class="flex h-6 w-6 items-center justify-center rounded text-ash-dim transition-colors hover:text-ink disabled:opacity-30"
              onclick={() => queueMutation.mutate({ type: 'reorder', jobId: job.id, newPosition: job.position + 1 })}
              disabled={i === queuedJobs.length - 1}
              aria-label="Move down"
            >
              <Icon name="chevron-left" size={13} class="-rotate-90" />
            </button>
            <button
              class="flex h-6 w-6 items-center justify-center rounded text-ash-dim transition-colors hover:text-error"
              onclick={() => queueMutation.mutate({ type: 'cancel', jobId: job.id })}
              aria-label="Remove from queue"
            >
              <Icon name="close" size={13} />
            </button>
          </div>
        {/each}
      </section>
    {/if}
  </div>
</div>