<script lang="ts">
  import { createMutation, useQueryClient, createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from './Icon.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import DeleteConfirmModal from './DeleteConfirmModal.svelte';
  import type { Stream } from '$shared/types';
  import type { DownloadState, QualityInfo } from '$lib/api/download';

  interface Props {
    stream: Stream;
  }

  let { stream }: Props = $props();
  const queryClient = useQueryClient();

  let open = $state(false);
  let showDeleteModal = $state(false);

  // Editable local copies — synced via $effect when stream prop changes.
  let title = $state('');
  let streamer = $state('');
  let game = $state('');
  let streamLink = $state('');
  let vodPath = $state('');
  let chatPath = $state('');
  let loaded = $state(false);
  let prevId = $state('');

  $effect(() => {
    // Re-sync when the stream prop changes (e.g. after refetch or first load).
    if (!loaded || stream.id !== prevId) {
      title = stream.title ?? '';
      streamer = stream.streamer ?? '';
      game = stream.game ?? '';
      streamLink = stream.sourceUrl ?? '';
      vodPath = stream.vodPath ?? '';
      chatPath = stream.chatPath ?? '';
      prevId = stream.id;
      loaded = true;
    }
  });

  const updateMutation = createMutation(() => ({
    mutationFn: (patch: Parameters<typeof apiClient.updateStream>[1]) =>
      apiClient.updateStream(stream.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      saved = true;
      setTimeout(() => (saved = false), 2000);
    },
  }));

  const deleteMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteStream(stream.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      window.location.href = '/';
    },
  }));

  let saved = $state(false);

  // ── Media section: download state + per-artifact actions ──
  const downloadQuery = createQuery(() => ({
    queryKey: ['download', stream.id],
    queryFn: () => apiClient.getDownloadState(stream.id),
    refetchInterval: 1000,
    enabled: open && Boolean(stream.sourceUrl),
  }));
  const dlState = $derived(downloadQuery.data as DownloadState | undefined);
  const mediaBusy = $derived(dlState?.phase === 'running');

  // Per-artifact presence: proxy + HQ come from the download state, chat
  // from the stream record (present for file imports too).
  // Presence = disk truth from the server (stat-based), never state paths.
  const hasHq = $derived(Boolean(dlState?.presence?.hq?.onDisk) || Boolean(vodPath));
  const hasProxy = $derived(Boolean(dlState?.presence?.proxy?.onDisk));
  const hasChat = $derived(Boolean(dlState?.presence?.chat?.onDisk) || Boolean(chatPath));
  // Size labels from real stat bytes; while a part runs, the growing size
  // comes from the part's own byte tracking (files mid-write stat too).
  const presenceBytes = $derived.by(() => {
    const p = dlState?.presence;
    return {
      hq: p?.hq?.onDisk ? p.hq.bytes : 0,
      proxy: p?.proxy?.onDisk ? p.proxy.bytes : 0,
      chat: p?.chat?.onDisk ? p.chat.bytes : 0,
    };
  });

  // Per-piece quality selection: proxy defaults 540, HQ defaults source max.
  // Resolved from the download state's quality list; fetched lazily when the
  // settings open on a URL stream that hasn't resolved qualities yet.
  let proxyHeight = $state<number | null>(540);
  let hqHeight = $state<number | null>(null);
  let qualityList = $state<QualityInfo[]>([]);
  const cancelPieceMutation = createMutation(() => ({
    mutationFn: (kind: 'proxy' | 'hq' | 'chat') => apiClient.cancelPiece(stream.id, kind),
    onSuccess: () => {
      pendingPiece = null;
      queryClient.invalidateQueries({ queryKey: ['download', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
    },
  }));
  const pieceMutation = createMutation(() => ({
    mutationFn: (input: { kind: 'proxy' | 'hq' | 'chat'; maxHeight?: number | null; proxyHeightCap?: number | null }) =>
      apiClient.downloadPiece(stream.id, input.kind, {
        maxHeight: input.maxHeight ?? null,
        proxyHeightCap: input.proxyHeightCap ?? null,
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
    },
  }));
  let pendingPiece = $state<'proxy' | 'hq' | 'chat' | null>(null);
  function startPiece(kind: 'proxy' | 'hq' | 'chat') {
    pendingPiece = kind;
    pieceMutation.mutate(
      kind === 'proxy'
        ? { kind, proxyHeightCap: proxyHeight ?? 540 }
        : { kind, maxHeight: hqHeight },
    );
  }
  // Fetch the quality list once when the modal opens on a URL stream.
  $effect(() => {
    if (!open || !stream.sourceUrl || qualityList.length > 0 || (stream as { game?: string }).game === undefined) return;
    apiClient.listQualities(stream.sourceUrl)
      .then((d) => {
        qualityList = d.qualities;
        const heights = d.qualities.map((q) => q.height);
        if (proxyHeight === null) proxyHeight = heights.includes(540) ? 540 : (heights.find((h) => h >= 360) ?? heights[0] ?? 540);
        if (hqHeight === null) hqHeight = heights.length > 0 ? Math.max(...heights) : null;
      })
      .catch(() => {});
  });
  // Piece live progress from the polled download state (1s refresh).
  const pieceProgress = $derived.by(() => {
    if (!dlState) return null;
    const kind = pendingPiece;
    if (!kind || kind === 'chat') return null;
    const part = dlState.parts.find((p) => p.kind === kind);
    if (!part || part.status !== 'running') return null;
    return { kind, percent: part.percent, frontier: part.downloadedSec ?? 0 };
  });

  function fmtPieceTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  function fmtBytes(bytes: number): string {
    if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)}GB`;
    if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)}MB`;
    return `${Math.round(bytes / 1024)}KB`;
  }

  // Clear the pending marker when the piece reaches a terminal status.
  $effect(() => {
    if (!pendingPiece || !dlState) return;
    const part = dlState.parts.find((p) => p.kind === pendingPiece);
    if (part && part.status !== 'running') pendingPiece = null;
    if (!mediaBusy && pendingPiece === 'chat') pendingPiece = null;
  });

  // ── Trash confirmations: one modal shared by the three artifact rows ──
  type TrashTarget = 'hq' | 'proxy' | 'chat';
  let trashTarget = $state<TrashTarget | null>(null);
  const TRASH_LABELS: Record<TrashTarget, string> = {
    hq: 'the video file',
    proxy: 'the proxy video',
    chat: 'the chat file',
  };

  const deleteProxyMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteProxy(stream.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
    },
  }));

  const deleteChatMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteChat(stream.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
      // Chat path is also a stream-record field the settings input mirrors.
      chatPath = '';
    },
  }));

  // HQ trash: deletes ONLY the video (hq.ts/.mp4 + chunk map). Proxy and
  // chat stay untouched (deleteDownload nukes everything — that's the
  // Download-section Delete, not this row's trash).
  const deleteHqMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteVideo(stream.id),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['download', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
      vodPath = '';
    },
  }));

  function confirmTrash() {
    if (!trashTarget) return;
    if (trashTarget === 'proxy') deleteProxyMutation.mutate();
    else if (trashTarget === 'chat') deleteChatMutation.mutate();
    else deleteHqMutation.mutate();
    trashTarget = null;
  }

  const dirty = $derived(
    loaded && (
      title !== (stream.title ?? '') ||
      streamer !== (stream.streamer ?? '') ||
      game !== (stream.game ?? '') ||
      streamLink !== (stream.sourceUrl ?? '') ||
      vodPath !== (stream.vodPath ?? '') ||
      chatPath !== (stream.chatPath ?? '')
    )
  );

  function save() {
    updateMutation.mutate({
      title: title.trim() || null,
      streamer: streamer.trim() || null,
      game: game.trim() || null,
      sourceUrl: streamLink.trim() || null,
      vodPath: vodPath.trim(),
      chatPath: chatPath.trim() || null,
    });
  }

  function confirmDelete() {
    deleteMutation.mutate();
  }

  function toggle() {
    open = !open;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (open && target && !target.closest('[data-project-settings]')) {
      open = false;
    }
  }
</script>

<svelte:window onclick={handleClickOutside} />

<div class="relative" data-project-settings>
  <button
    class="flex h-8 w-8 items-center justify-center rounded-md text-ash transition-colors hover:bg-surface-2 hover:text-ink {open ? 'bg-surface-2 text-ink' : ''}"
    onclick={toggle}
    aria-label="Project settings"
    aria-expanded={open}
  >
    <Icon name="settings" size={16} />
  </button>

  {#if open}
    <div
      class="absolute right-0 top-full z-40 mt-1 w-[26rem] rounded-lg border border-border bg-surface shadow-xl"
      role="dialog"
      aria-label="Project settings"
    >
      <div class="flex flex-col gap-4 p-4">
        <div class="flex items-center justify-between">
          <h3 class="font-display text-sm font-medium">Project Settings</h3>
          {#if saved}
            <span class="font-mono text-xs text-success">✓ Saved</span>
          {/if}
        </div>

        <!-- Metadata -->
        <div class="flex flex-col gap-3">
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Title</span>
            <input
              type="text"
              bind:value={title}
              class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
            />
          </label>
          <!-- Streamer gets priority width; game shrinks but never overflows
               the card (min-w-0 truncation + flex-basis weighting). -->
          <div class="flex w-full min-w-0 gap-2">
            <label class="flex min-w-0 flex-col gap-1" style="flex: 3 1 0;">
              <span class="font-mono text-xs text-ash">Streamer</span>
              <input
                type="text"
                bind:value={streamer}
                class="w-full min-w-0 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
            <label class="flex min-w-0 flex-col gap-1" style="flex: 2 1 0;">
              <span class="font-mono text-xs text-ash">Game</span>
              <input
                type="text"
                bind:value={game}
                class="w-full min-w-0 rounded-md border border-border bg-surface-2 px-2 py-1.5 text-sm text-ink focus:border-accent focus:outline-none"
              />
            </label>
          </div>
          <label class="flex flex-col gap-1">
            <span class="font-mono text-xs text-ash">Stream link</span>
            <input
              type="text"
              bind:value={streamLink}
              placeholder="https://www.twitch.tv/videos/…"
              class="rounded-md border border-border bg-surface-2 px-3 py-1.5 text-sm text-ink placeholder:text-ash-dim focus:border-accent focus:outline-none"
            />
            <span class="text-[10px] text-ash-dim">Used to (re)download video, proxy and chat</span>
          </label>
        </div>

        <!-- Files: per-artifact rows — presence check / download, trash -->
        <div class="flex flex-col gap-2 border-t border-border pt-3">
          <div class="flex items-center justify-between">
            <span class="font-mono text-xs uppercase tracking-wider text-ash">Files</span>
            <button
              class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent"
              onclick={() => { void fetch(`/api/streams/${stream.id}/folder`); }}
              title="Open the artifact folder"
            >
              <Icon name="folder" size={12} /> Open folder
            </button>
          </div>

          {#each [
              { key: 'hq', label: 'Video (HQ)', has: hasHq, running: pendingPiece === 'hq', part: dlState?.parts.find((p) => p.kind === 'hq') },
              { key: 'proxy', label: 'Proxy video', has: hasProxy, running: pendingPiece === 'proxy', part: dlState?.parts.find((p) => p.kind === 'proxy') },
              { key: 'chat', label: 'Chat', has: hasChat, running: pendingPiece === 'chat', part: dlState?.parts.find((p) => p.kind === 'chat') },
            ] as row (row.key)}
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span class="w-24 shrink-0 font-mono text-xs text-ash">{row.label}</span>
                {#if row.running}
                  <button
                    class="flex items-center gap-1 rounded-md border border-accent px-2 py-1 text-xs text-accent transition-colors hover:border-error hover:text-error"
                    onclick={() => cancelPieceMutation.mutate(row.key as 'proxy' | 'hq' | 'chat')}
                    title="Cancel this download (partial file is kept)"
                  >
                    <Icon name="close" size={11} /> Cancel
                  </button>
                {:else if row.has}
                  <span class="flex items-center gap-1 font-mono text-[11px] text-success" title="On disk">
                    <Icon name="check" size={11} /> on disk
                  </span>
                {:else}
                  {#if row.key === 'proxy' && !row.has && qualityList.length > 0}
                    <select
                      bind:value={proxyHeight}
                      class="rounded border border-border bg-surface-2 px-1.5 py-1 text-[10px] text-ink focus:border-accent focus:outline-none"
                      aria-label="Proxy resolution"
                    >
                      {#each qualityList as q (q.name)}
                        <option value={q.height}>{q.name}</option>
                      {/each}
                    </select>
                  {:else if row.key === 'hq' && !row.has && qualityList.length > 0}
                    <select
                      bind:value={hqHeight}
                      class="rounded border border-border bg-surface-2 px-1.5 py-1 text-[10px] text-ink focus:border-accent focus:outline-none"
                      aria-label="HQ resolution"
                    >
                      {#each qualityList as q (q.name)}
                        <option value={q.height}>{q.name}</option>
                      {/each}
                    </select>
                  {/if}
                  <button
                    class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                    onclick={() => startPiece(row.key as 'proxy' | 'hq' | 'chat')}
                    disabled={mediaBusy || pieceMutation.isPending || !streamLink.trim()}
                    title={streamLink.trim() ? 'Download from the stream link' : 'Set the stream link first'}
                  >
                    <Icon name="download" size={11} /> Download
                  </button>
                {/if}
                {#if row.key === 'chat' && hasChat && presenceBytes.chat > 0}
                  <span class="font-mono text-[10px] text-ash-dim">{fmtBytes(presenceBytes.chat)}</span>
                {:else if row.key !== 'chat' && row.has && row.part && row.part.downloadedBytes > 0}
                  <span class="font-mono text-[10px] text-ash-dim">{fmtBytes(row.part.downloadedBytes)}</span>
                {/if}
                <span class="flex-1"></span>
                {#if row.has}
                  <button
                    class="flex h-6 w-6 items-center justify-center rounded text-ash-dim transition-colors hover:text-error"
                    onclick={() => (trashTarget = row.key as TrashTarget)}
                    aria-label={`Delete ${row.label}`}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                {/if}
              </div>
              {#if row.running && row.part && row.part.status === 'running'}
                <div class="flex items-center gap-2 pl-[6.5rem]">
                  {#if row.key === 'chat'}
                    <!-- GQL chat has no total: indeterminate pulse -->
                    <div class="h-1 flex-1 animate-pulse overflow-hidden rounded-full bg-accent/40"></div>
                    <span class="font-mono text-[10px] text-ash-dim">{Math.floor((row.part.downloadedSec ?? 0))} comments</span>
                  {:else}
                    <div class="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <div class="h-full bg-accent transition-all" style="width: {row.part.percent * 100}%"></div>
                    </div>
                    <span class="font-mono text-[10px] text-ash-dim">
                      {row.part.downloadedBytes > 0 ? `${fmtBytes(row.part.downloadedBytes)} · ` : ''}{Math.round(row.part.percent * 100)}%
                    </span>
                  {/if}
                </div>
              {/if}
            </div>
          {/each}
          {#if pieceMutation.isError}
            <p class="font-mono text-[10px] text-error">{pieceMutation.error?.message}</p>
          {/if}
        </div>

        <!-- Actions -->
        <div class="flex items-center justify-between gap-2 border-t border-border pt-3">
          <button
            class="flex items-center gap-1 rounded-md border border-error/30 px-3 py-1.5 text-xs text-error transition-colors hover:bg-error/10"
            onclick={() => (showDeleteModal = true)}
          >
            <Icon name="trash" size={14} />
            Delete Project
          </button>
          <button
            class="flex items-center gap-1 rounded-md bg-accent px-4 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
            onclick={save}
            disabled={!dirty || updateMutation.isPending}
          >
            <Icon name="check" size={14} />
            {updateMutation.isPending ? 'Saving...' : 'Save'}
          </button>
        </div>

        {#if updateMutation.isError}
          <div class="rounded-md border border-error bg-surface-2 px-3 py-2 text-xs text-error">
            {updateMutation.error?.message ?? 'Save failed'}
          </div>
        {/if}
      </div>
    </div>
  {/if}
</div>

{#if showDeleteModal}
  <DeleteConfirmModal
    {stream}
    onConfirm={confirmDelete}
    onCancel={() => (showDeleteModal = false)}
  />
{/if}

{#if trashTarget}
  <ConfirmModal
    title="Delete {TRASH_LABELS[trashTarget]}?"
    body="This file will be removed from disk. This cannot be undone."
    confirmLabel="Delete"
    onConfirm={confirmTrash}
    onCancel={() => (trashTarget = null)}
  />
{/if}