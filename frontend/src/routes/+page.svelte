<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import DownloadProgress from '$lib/components/DownloadProgress.svelte';
  import { downloadsQuery, viewFor } from '$lib/api/downloads';
  import { isLive, isSatisfied } from '$lib/api/download';
  import { fadeIn, staggerIn, hoverLift } from '$lib/actions/gsap';
  import type { Stream, Job, ImportByUrlInput, ImportByFileInput } from '$shared/types';
  import type { QualityInfo } from '$lib/api/download';

  const queryClient = useQueryClient();

  // The shared downloads query drives the progress section: a container is
  // rendered for exactly the streams whose download is live (or failed) and
  // not yet satisfied — so it appears the moment a download starts, without
  // a page refresh.
  const downloads = downloadsQuery();
  const liveDownloads = $derived(
    (downloads.data?.views ?? []).filter((v) => isLive(v) && !isSatisfied(v)),
  );

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

  const queueMutation = createMutation(() => ({
    mutationFn: (action: Parameters<typeof apiClient.manageQueue>[0]) => apiClient.manageQueue(action),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ['jobs'] }),
  }));

  let urlInput = $state('');
  let pathInput = $state('');

  // Download options — visible only when a valid stream URL is entered.
  let maxQualityHeight = $state<number | null>(null); // null = no cap
  let proxyHeightCap = $state<number | null>(null); // null = none (no separate proxy file)
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

  const hasStreamUrl = $derived(isTwitchVodUrl(urlInput.trim()));

  function isTwitchVodUrl(url: string): boolean {
    return /twitch\.tv\/videos\/\d+/.test(url) || /^\d{6,}$/.test(url.trim());
  }

  $effect(() => {
    const url = urlInput.trim();
    if (!url || !isTwitchVodUrl(url) || url === lastQueriedUrl) return;
    lastQueriedUrl = url;
    qualitiesLoading = true;
    qualitiesError = null;
    apiClient.listQualities(url)
      .then((d) => {
        qualities = d.qualities;
        // Default the max-quality select to the settings default (if the
        // source has it), else the highest available.
        if (d.qualities.length > 0) {
          const def = settingsForDefaults.data?.defaultMaxQualityHeight ?? null;
          const available = d.qualities.map((q) => q.height);
          const highest = Math.max(...available);
          maxQualityHeight = def !== null && available.includes(def) ? def : highest;
          // Proxy choices sit below the stream's highest and below the max
          // quality cap; defaults to none (single download).
          proxyHeightCap = null;
        }
      })
      .catch((err: Error) => (qualitiesError = err.message))
      .finally(() => (qualitiesLoading = false));
  });

  // Proxy dropdown options: qualities strictly below the chosen max quality.
  const proxyChoices = $derived.by(() => {
    if (maxQualityHeight === null) return qualities.filter((q) => q.height < Math.max(...qualities.map((c) => c.height)));
    return qualities.filter((q) => q.height < maxQualityHeight!);
  });

  function handleUrlImport() {
    if (!urlInput.trim()) return;
    importUrlMutation.mutate({
      url: urlInput.trim(),
      progressive: true,
      proxyHeightCap: proxyHeightCap ?? 540,
      maxQualityHeight,
      includeProxy: proxyHeightCap !== null,
    });
    urlInput = '';
    proxyHeightCap = null;
    maxQualityHeight = null;
    qualities = [];
  }

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

  // Live downloads, filtered by the selected channel (an unfiltered section
  // shows downloads for channels the user filtered out).
  const visibleDownloads = $derived(
    activeChannel === null
      ? liveDownloads
      : liveDownloads.filter((v) => streams.find((s) => s.id === v.streamId)?.streamer === activeChannel),
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
      folderPath: pathInput.trim(),
      title: pathInput.trim().split('/').filter(Boolean).pop(),
    });
    pathInput = '';
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
    <!-- Import bar (P0-2): URL + local folder, always first -->
    <section>
      <div class="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 transition-colors focus-within:border-accent">
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
          disabled={importUrlMutation.isPending || !hasStreamUrl}
        >
          Download
        </button>
      </div>

      {#if hasStreamUrl}
        <!-- Download options — only for a valid stream URL. The proxy
             dropdown picks a separate lower-quality proxy pass (none =
             single chunk-live download whose chunks become scrubbable as
             they land). -->
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
            <span class="font-mono text-xs text-ash-dim">Proxy:</span>
            <select
              bind:value={proxyHeightCap}
              class="rounded border border-border bg-surface-2 px-2 py-1 text-xs text-ink focus:border-accent focus:outline-none"
              aria-label="Proxy video quality"
            >
              <option value={null}>— none —</option>
              {#each proxyChoices as q (q.name)}
                <option value={q.height}>
                  {q.name} ({q.width}×{q.height})
                </option>
              {/each}
            </select>
          {/if}
        </div>
      {/if}
      <div class="mt-2 flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 transition-colors focus-within:border-accent">
        <Icon name="folder" size={15} fill={false} />
        <input
          type="text"
          bind:value={pathInput}
          onkeydown={(e) => e.key === 'Enter' && handlePathImport()}
          placeholder="Or enter a local folder path"
          class="flex-1 bg-transparent text-sm text-ink placeholder:text-ash-dim focus:outline-none"
          aria-label="Local folder path"
        />
        <button
          class="rounded-md border border-border px-3 py-1.5 text-xs font-medium text-ash transition-colors hover:text-ink hover:border-border-strong disabled:opacity-50"
          onclick={handlePathImport}
          disabled={importFileMutation.isPending || !pathInput.trim()}
        >
          Import
        </button>
      </div>
      {#if pathInput.trim()}
        <p class="mt-1 px-3 text-xs text-ash-dim">First video file in the folder becomes the HQ video; a proxy file (proxy.ts / scrub.ts) and chat.json are picked up automatically.</p>
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

    <!-- Download progress (unified bar + itemized popover). Filtered by the
         selected channel; a satisfied download (fully done, playable files
         on disk) leaves the list — the stream lives in the library rows. -->
    {#if visibleDownloads.length > 0}
      <section class="flex flex-col gap-2" aria-label="Download progress">
        {#each visibleDownloads as v (v.streamId)}
          <DownloadProgress
            streamId={v.streamId}
            title={streamTitle(v.streamId)}
          />
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
        <p class="font-display text-base text-ash">Paste a Twitch VOD URL to begin</p>
        <p class="text-sm text-ash-dim">or point at a local folder above</p>
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