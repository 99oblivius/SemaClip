<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from '$lib/components/Icon.svelte';
  import DownloadProgress from '$lib/components/DownloadProgress.svelte';
  import { DOWNLOADS_KEY, downloadsQuery, viewFor, markDownloadsChanged } from '$lib/api/downloads';
  import { needsAttention, isUnreachable } from '$lib/api/download';
  import ProjectSettings from '$lib/components/ProjectSettings.svelte';
  import { fadeIn, staggerIn, hoverLift } from '$lib/actions/gsap';
  import type { Stream, Job, ImportByUrlInput, ImportByFileInput } from '$shared/types';
  import type { QualityInfo } from '$lib/api/download';

  const queryClient = useQueryClient();

  // The shared downloads query drives the progress section: a container is
  // rendered for exactly the streams whose download is live (or failed) and
  // not yet satisfied — so it appears the moment a download starts, without
  // a page refresh.
  const downloads = downloadsQuery();

  /**
   * Imports in flight, shown from the instant Download is pressed.
   *
   * The server's first download view cannot arrive before the request does: the stream
   * id is generated server-side and the GQL metadata fetch happens inside the request,
   * so a container rendered only from `liveDownloads` appears one round-trip after the
   * click. These placeholders close that gap with the only thing knowable at press time
   * (the chosen pieces), and are dropped the moment the real view takes over. They live
   * client-side by design: the server has nothing to say about a stream it has not
   * created yet, so this is not a second owner of server state.
   */
  type PendingImport = { key: string; title: string; includeProxy: boolean };
  let pendingImports = $state<PendingImport[]>([]);

  // Anything that needs attention: actively downloading, failed, or
  // incomplete (an artifact is missing and can be downloaded again).
  const liveDownloads = $derived(
    (downloads.data?.views ?? []).filter((v) => needsAttention(v)),
  );

  /**
   * Whether a project's chat/video is MISSING, from the one server-composed view.
   *
   * The row labels read `stream.chatPath` — a field on the stream RECORD, a different
   * owner from the view's stat-based presence — so a label could disagree with the truth
   * it described. An artifact that is actively downloading is not "missing" either: it
   * gets no label until the outcome is known, rather than reading "no chat" while its
   * bytes are still arriving.
   */
  function missingArtifacts(streamId: string): { chat: boolean; video: boolean } {
    const v = viewFor(downloads.data?.views, streamId);
    const absent = (kind: 'chat' | 'video') => {
      const a = v?.artifacts.find((x) => x.kind === kind);
      return Boolean(a) && !a!.onDisk && a!.status !== 'running';
    };
    return { chat: absent('chat'), video: absent('video') };
  }

  const streamsQuery = createQuery(() => ({
    queryKey: ['streams'],
    queryFn: () => apiClient.listStreams(),
  }));

  const jobsQuery = createQuery(() => ({
    queryKey: ['jobs'],
    queryFn: () => apiClient.listJobs(),
    // The layout invalidates this on every `job_status` event, so the transition itself is the
    // trigger. This interval is a SAFETY NET for a dropped socket, not the mechanism: polling
    // every 3s while the socket already announced the same changes was redundant work, and the
    // owner has asked for this app not to lean on polling.
    refetchInterval: 30000,
  }));

  const importUrlMutation = createMutation(() => ({
    mutationFn: (input: ImportByUrlInput) => apiClient.importByUrl(input),
    onSuccess: () => {
      // The real view is now (or is about to be) in the downloads query, so the
      // placeholder has done its job — leaving it would double the container.
      pendingImports = [];
      // An import STARTS a progressive download server-side (progressive: true), so
      // the downloads query is the surface that must learn about it immediately.
      // Invalidating only ['streams'] left the progress container showing whatever it
      // had cached, so it appeared only after a refresh or a navigation away and back
      // — the reported regression. markDownloadsChanged() also switches the poller out
      // of its idle heartbeat so progress is continuous from the first second rather
      // than up to 30 s later.
      markDownloadsChanged();
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] });
    },
    onError: () => {
      // A rejected import creates no server view to take over, so the placeholder
      // must go or it would sit at 0% forever.
      pendingImports = [];
    },
  }));

  const importFileMutation = createMutation(() => ({
    mutationFn: (input: ImportByFileInput) => apiClient.importByFile(input),
    onSuccess: () => {
      // A folder import adopts real files, so presence changes even though no
      // download runs. The downloads view is where presence is rendered.
      markDownloadsChanged();
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] });
    },
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
    // Seed the visualisation BEFORE the request goes out: the container must appear the
    // instant the button is pressed, and the server cannot answer until it has fetched
    // metadata and created the stream record. The pieces listed are exactly what was
    // chosen, so a placeholder never claims a download the server was not asked for.
    const includeProxy = proxyHeightCap !== null;
    pendingImports = [
      ...pendingImports,
      { key: `pending-${Date.now()}`, title: urlInput.trim(), includeProxy },
    ];
    importUrlMutation.mutate({
      url: urlInput.trim(),
      progressive: true,
      proxyHeightCap: proxyHeightCap ?? 540,
      maxQualityHeight,
      includeProxy,
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
    {#if pendingImports.length > 0}
      {#each pendingImports as p (p.key)}
        <section class="flex flex-col gap-2" aria-label="Download progress">
          <div class="rounded-md border border-border bg-surface px-3 py-2" role="status">
            <div class="flex w-full items-center gap-2.5">
              <Icon name="download" size={14} class="text-accent" />
              <span class="max-w-40 shrink-0 truncate font-mono text-[10px] text-ash-dim">{p.title}</span>
              <div class="min-w-0 flex-1">
                <div class="flex items-center justify-between gap-2 font-mono text-[10px]">
                  <span class="truncate text-ash">downloading</span>
                  <span class="text-ash-dim">0%</span>
                </div>
                <div class="mt-1 h-1 overflow-hidden rounded-full bg-surface-3"></div>
              </div>
            </div>
            <!-- Itemized rows listed from the start, at pending, so the shape of the
                 download is known before its first byte lands. -->
            <div class="mt-2 flex flex-col gap-1.5 border-t border-border pt-2">
              {#each ['Chat', ...(p.includeProxy ? ['Proxy'] : []), 'Video'] as label (label)}
                <div class="flex items-center gap-2">
                  <span class="w-24 shrink-0 font-mono text-[10px] text-ash">{label}</span>
                  <div class="h-0.5 min-w-0 flex-1 overflow-hidden rounded-full bg-surface-3"></div>
                  <span class="w-24 shrink-0 text-right font-mono text-[10px] text-ash-dim">pending</span>
                </div>
              {/each}
            </div>
          </div>
        </section>
      {/each}
    {/if}

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
            {@const unreachable = isUnreachable(viewFor(downloads.data?.views, stream.id))}
            <div
              class="flex items-center gap-3 rounded-md border bg-surface px-4 py-3 transition-colors hover:bg-surface-2
              {unreachable ? 'border-warning/40 stripe-unreachable' : 'border-transparent hover:border-border-strong'}"
              title={unreachable ? 'This project\'s folder is not there — the drive may be unmounted, or the folder moved. Use Change Location in the settings panel.' : undefined}
            >
              <button class="flex flex-1 items-center gap-3 text-left" onclick={() => openStream(stream.id)} use:hoverLift>
                <div class="flex min-w-0 flex-1 flex-col gap-0.5">
                  <span class="truncate text-sm font-medium text-ink">{stream.title ?? 'Untitled Stream'}</span>
                  <span class="font-mono text-xs text-ash">
                    {stream.streamer ?? 'unknown'} · {fmtDuration(stream.duration)} · {fmtDate(stream.createdAt)}
                  </span>
                </div>
                <div class="flex items-center gap-2">
                  {#if unreachable}
                    <!-- The one thing this project needs is its location, so the chip and the
                         action sit together. The panel is reachable from HERE as well as from
                         Review, because an unreachable project is exactly the one you cannot
                         usefully open. -->
                    <span class="flex items-center gap-1 font-mono text-xs text-warning">
                      <Icon name="alert" size={12} /> path not found
                    </span>
                  {:else if stream.status === 'processing'}
                    <span class="flex items-center gap-1 font-mono text-xs text-warning"><Icon name="cpu" size={13} /> processing</span>
                  {:else if stream.status === 'completed'}
                    <span class="font-mono text-xs text-success">✓</span>
                  {:else if stream.status === 'failed'}
                    <span class="font-mono text-xs text-error">failed</span>
                  {/if}
                  <!-- Presence comes from the download view's stat-based report, so the
                       labels track reality live: a download finishing, a file deleted or
                       dragged into the folder all converge here without a refresh. Hidden
                       while an artifact is still downloading — its absence is not yet a
                       fact. Suppressed entirely for an unreachable project: every artifact
                       reads absent there, and "no chat · no video" beside "path not found"
                       says nothing that is not already explained. -->
                  {#if !unreachable && missingArtifacts(stream.id).chat}
                    <span class="font-mono text-xs text-ash-dim">no chat</span>
                  {/if}
                  {#if !unreachable && missingArtifacts(stream.id).video}
                    <span class="font-mono text-xs text-ash-dim">no video</span>
                  {/if}
                </div>
              </button>
              <!-- Outside the row button so a press here cannot also open the project. -->
              <ProjectSettings {stream} />
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