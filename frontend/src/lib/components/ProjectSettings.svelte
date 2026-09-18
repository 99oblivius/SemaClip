<script lang="ts">
  import { createMutation, useQueryClient, createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import Icon from './Icon.svelte';
  import ConfirmModal from './ConfirmModal.svelte';
  import DeleteConfirmModal from './DeleteConfirmModal.svelte';
  import type { Stream } from '$shared/types';
  import type { ArtifactView, DownloadView, QualityInfo } from '$lib/api/download';
  import { fmtBytes as fmtBytesShared } from '$lib/api/download';
  import { DOWNLOADS_KEY, downloadsQuery, viewFor, markDownloadsChanged } from '$lib/api/downloads';
  import { untrack } from 'svelte';
  import {
    adoptServerValues,
    canRedo,
    canUndo,
    commit,
    createHistory,
    rebase,
    redo,
    revertTarget,
    undo,
    type FieldSnapshot,
  } from './field-history';

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

  /**
   * The six editable fields as one unit, so undo/redo and revert-on-close have something to
   * record. The panel binds the fields individually (bind:value), so the history is maintained
   * alongside them rather than derived from them — by the time an edit is visible in state, the
   * information that it HAPPENED is already gone.
   */
  const snapshot = $derived<FieldSnapshot>({ title, streamer, game, streamLink, vodPath, chatPath });
  /**
   * The history starts from the INITIAL values on purpose — reading `snapshot` here without
   * untracking would re-create the history every time a field changed and erase the undo steps
   * as they were made. The record-sync effect below is what moves the baseline to the server's
   * values once they arrive.
   */
  let history = $state(untrack(() => createHistory(snapshot)));

  /** Push the current values as an undo step. Called at points a human calls a change. */
  function commitHistory() {
    history = commit(history, snapshot);
  }

  /** Write a snapshot back into the bound fields (undo, redo, revert). */
  function applySnapshot(snap: FieldSnapshot) {
    title = snap.title;
    streamer = snap.streamer;
    game = snap.game;
    streamLink = snap.streamLink;
    vodPath = snap.vodPath;
    chatPath = snap.chatPath;
  }

  function undoEdit() {
    const next = undo(history);
    if (next === history) return;
    history = next;
    applySnapshot(next.present);
  }

  function redoEdit() {
    const next = redo(history);
    if (next === history) return;
    history = next;
    applySnapshot(next.present);
  }

  /**
   * Closing without saving discards the pending edits.
   *
   * The same rule the UI-scale preview follows: an unsaved change must not outlive the surface
   * that made it. Reverting here (not on every keystroke) is what keeps the panel usable — the
   * fields stay editable while it is open, and the server's values are what survive a close.
   */
  function closePanel() {
    if (!open) return;
    open = false;
    if (dirty) {
      applySnapshot(revertTarget(history));
      history = createHistory(revertTarget(history));
    }
  }

  // Re-sync the editable copies when the stream RECORD changes — not only
  // when the id changes. Gating on the id alone meant a delete (which clears
  // vodPath/chatPath server-side) never updated the fields or the dirty
  // check, so the panel kept showing the old paths.
  let lastRecordSig = $state('');
  $effect(() => {
    const sig = [
      stream.id,
      stream.title ?? '', stream.streamer ?? '', stream.game ?? '',
      stream.sourceUrl ?? '', stream.vodPath ?? '', stream.chatPath ?? '',
    ].join('\u0000');
    if (sig === lastRecordSig) return;
    // Never clobber unsaved edits: `adoptServerValues` refuses while something is pending, which
    // is the same rule the UI-scale store follows. The server's values become the new revert
    // target and the undo history is dropped, because it describes fields that no longer relate
    // to anything.
    const server: FieldSnapshot = {
      title: stream.title ?? '',
      streamer: stream.streamer ?? '',
      game: stream.game ?? '',
      streamLink: stream.sourceUrl ?? '',
      vodPath: stream.vodPath ?? '',
      chatPath: stream.chatPath ?? '',
    };
    const next = adoptServerValues(history, server, dirty);
    if (next !== history) {
      history = next;
      applySnapshot(next.present);
    } else if (!dirty) {
      applySnapshot(server);
    }
    lastRecordSig = sig;
    loaded = true;
  });

  const updateMutation = createMutation(() => ({
    mutationFn: (patch: Parameters<typeof apiClient.updateStream>[1]) =>
      apiClient.updateStream(stream.id, patch),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
      queryClient.invalidateQueries({ queryKey: ['streams'] });
      // The saved values become the revert target, so closing the panel no longer throws them
      // away — and the undo history survives, so the user can still step back through what they
      // typed before saving.
      history = rebase(history, history.present);
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

  // ── Media section ──
  // Rows render the SERVER's composed view verbatim. Nothing here derives
  // "is it on disk", "is a download happening" or "what size" — those local
  // derivations are exactly what produced the reported inconsistencies
  // (instant checkmarks, sizes on the wrong row, no bar while downloading).
  const downloads = downloadsQuery();
  const view = $derived(viewFor(downloads.data?.views, stream.id));
  const mediaBusy = $derived(Boolean(view?.active));

  /** Resolutions a proxy may use: strictly BELOW the video's resolution —
   *  a proxy at the video's own quality is a duplicate, not a preview. */
  const proxyChoices = $derived.by(() => {
    const videoHeight = hqHeight ?? (qualityList.length > 0 ? Math.max(...qualityList.map((q) => q.height)) : null);
    return qualityList.filter((q) => videoHeight === null || q.height < videoHeight);
  });

  /** Artifact rows in display order, straight from the view. */
  const artifacts = $derived<ArtifactView[]>(view?.artifacts ?? []);
  const chatArt = $derived(artifacts.find((a) => a.kind === 'chat'));
  const proxyArt = $derived(artifacts.find((a) => a.kind === 'proxy'));
  const videoArt = $derived(artifacts.find((a) => a.kind === 'video'));

  // Per-piece quality selection: proxy defaults 540, HQ defaults source max.
  // Resolved from the download state's quality list; fetched lazily when the
  // settings open on a URL stream that hasn't resolved qualities yet.
  let proxyHeight = $state<number | null>(null);
  let hqHeight = $state<number | null>(null);   // — none — until chosen
  let qualityList = $state<QualityInfo[]>([]);
  const cancelPieceMutation = createMutation(() => ({
    mutationFn: (kind: 'proxy' | 'video' | 'chat') => apiClient.cancelPiece(stream.id, pieceKind(kind)),
    onSuccess: () => {
      pendingPiece = null;
      markDownloadsChanged();
      queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] });
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
      markDownloadsChanged();
      queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
    },
  }));
  let pendingPiece = $state<'proxy' | 'video' | 'chat' | null>(null);
  /** The server's piece kinds still speak hq/proxy; the view speaks video. */
  function pieceKind(kind: 'proxy' | 'video' | 'chat'): 'proxy' | 'hq' | 'chat' {
    return kind === 'video' ? 'hq' : kind;
  }
  /** A piece can be downloaded only with a source AND a chosen resolution. */
  function canDownload(kind: 'proxy' | 'video' | 'chat'): boolean {
    if (mediaBusy || pieceMutation.isPending || !streamLink.trim()) return false;
    if (kind === 'chat') return true;
    if (kind === 'proxy') return proxyHeight !== null;
    return hqHeight !== null;
  }

  function downloadTitle(kind: 'proxy' | 'video' | 'chat'): string {
    if (!streamLink.trim()) return 'Set the stream link first';
    if (kind !== 'chat') {
      const chosen = kind === 'proxy' ? proxyHeight : hqHeight;
      if (chosen === null) {
        return kind === 'proxy' && proxyChoices.length === 0
          ? 'No proxy resolution is available below the video quality'
          : 'Choose a resolution first';
      }
    }
    return 'Download from the stream link';
  }

  function startPiece(kind: 'proxy' | 'video' | 'chat') {
    pendingPiece = kind;
    if (kind === 'proxy' && proxyHeight === null) return; // — none — selected
    pieceMutation.mutate(
      kind === 'proxy'
        ? { kind: 'proxy', proxyHeightCap: proxyHeight ?? 540 }
        : kind === 'video'
          ? { kind: 'hq', maxHeight: hqHeight }
          : { kind: 'chat' },
    );
  }
  // Fetch the quality list once when the modal opens on a URL stream.
  $effect(() => {
    if (!open || !stream.sourceUrl || qualityList.length > 0 || (stream as { game?: string }).game === undefined) return;
    apiClient.listQualities(stream.sourceUrl)
      .then((d) => {
        qualityList = d.qualities;
        const heights = d.qualities.map((q) => q.height);
        // Selections start at — none —; drop any height the source does not
        // actually offer rather than leaving a value that cannot download.
        if (proxyHeight !== null && !heights.includes(proxyHeight)) proxyHeight = null;
        if (hqHeight !== null && !heights.includes(hqHeight)) hqHeight = null;
      })
      .catch(() => {});
  });
  // Progress comes from the view's artifact rows; the pending marker only
  // covers the in-flight window before the server reports the run.
  function fmtPieceTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`;
  }

  const fmtBytes = fmtBytesShared;

  // Clear the optimistic marker once the server reports the run (running) or
  // a terminal status. A REJECTED piece must not silently resolve: the
  // mutation's error is rendered inline instead.
  $effect(() => {
    if (!pendingPiece) return;
    const art = artifacts.find((a) => a.kind === pendingPiece);
    if (art && art.status !== 'pending') pendingPiece = null;
  });

  // ── Trash confirmations: one modal shared by the three artifact rows ──
  type TrashTarget = 'video' | 'proxy' | 'chat';
  let trashTarget = $state<TrashTarget | null>(null);
  const TRASH_LABELS: Record<TrashTarget, string> = {
    video: 'the video file',
    proxy: 'the proxy video',
    chat: 'the chat file',
  };

  /**
   * Open the project's folder in the OS file manager.
   *
   * The server opens it (the browser cannot), and it now REPORTS the outcome, so a refusal is
   * shown rather than swallowed: this button used to `void` the fetch, which made "nothing
   * happened" indistinguishable from "the folder opened behind this window".
   */
  let folderError = $state('');
  async function openFolder() {
    folderError = '';
    try {
      const res = await fetch(`/api/streams/${stream.id}/folder`);
      const body = await res.json() as { opened?: boolean; error?: string };
      if (!res.ok) { folderError = body?.error ?? `Could not open the folder (HTTP ${res.status}).`; return; }
      if (!body?.opened) { folderError = body?.error ?? 'Could not open the folder.'; }
    } catch (err) {
      folderError = err instanceof Error ? err.message : 'Could not open the folder.';
    }
  }

  const deleteProxyMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteProxy(stream.id),
    onSuccess: () => {
      markDownloadsChanged();
      queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] });
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
  const deleteVideoMutation = createMutation(() => ({
    mutationFn: () => apiClient.deleteVideo(stream.id),
    onSuccess: () => {
      markDownloadsChanged();
      queryClient.invalidateQueries({ queryKey: DOWNLOADS_KEY as unknown as string[] });
      queryClient.invalidateQueries({ queryKey: ['stream', stream.id] });
      vodPath = '';
    },
  }));

  /**
   * Deleting the video file makes exports impossible (ExportClip hard-requires
   * it). Say so loudly, and say what playback falls back to — a silent
   * deletion that quietly downgrades the project is what the owner flagged.
   */
  const trashWarning = $derived.by(() => {
    const base = 'This file will be removed from disk. This cannot be undone.';
    if (trashTarget === 'video') {
      const stillPlayable = artifacts.find((a) => a.kind === 'proxy')?.onDisk;
      return `NO EXPORTS WILL BE POSSIBLE unless the video is downloaded again. ` +
        (stillPlayable
          ? 'Only the proxy remains — playback continues at preview quality.'
          : 'No playable video will remain for this project.') +
        ` ${base}`;
    }
    if (trashTarget === 'proxy') {
      return 'The proxy is the preview copy used for fast scrubbing and mid-download playback. ' +
        `The video file is unaffected. ${base}`;
    }
    return base;
  });

  function confirmTrash() {
    if (!trashTarget) return;
    if (trashTarget === 'proxy') deleteProxyMutation.mutate();
    else if (trashTarget === 'chat') deleteChatMutation.mutate();
    else deleteVideoMutation.mutate();
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
    if (open) closePanel();
    else open = true;
  }

  function handleClickOutside(e: MouseEvent) {
    const target = e.target as HTMLElement;
    if (open && target && !target.closest('[data-project-settings]')) {
      closePanel();
    }
  }

  /**
   * Undo/redo shortcuts, scoped to the open panel.
   *
   * Ctrl+Z / Ctrl+Shift+Z (and Ctrl+Y, which is what Windows users reach for). The no-gating rule
   * requires a visible surface AND a keybinding, so the panel also carries buttons.
   */
  function onHistoryKey(e: KeyboardEvent) {
    if (!open) return;
    if (!(e.ctrlKey || e.metaKey)) return;
    const key = e.key.toLowerCase();
    if (key === 'z' && !e.shiftKey) {
      e.preventDefault();
      undoEdit();
      return;
    }
    if ((key === 'z' && e.shiftKey) || key === 'y') {
      e.preventDefault();
      redoEdit();
      return;
    }
    // Enter commits the current values as an undo step; leaving a field does too, so a typed
    // value is never lost between steps.
    if (key === 'enter') {
      e.preventDefault();
      commitHistory();
    }
  }
</script>

<svelte:window onclick={handleClickOutside} onkeydown={onHistoryKey} />

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
          <div class="flex items-center gap-1">
            {#if saved}
              <span class="font-mono text-xs text-success">✓ Saved</span>
            {/if}
            <!-- Undo/redo over the edited fields. Disabled rather than hidden, so the
                 affordance is always visible (no-gating rule) and its state is readable. -->
            <button
              type="button"
              class="rounded px-1.5 py-0.5 font-mono text-xs transition-colors
                {canUndo(history) ? 'text-ash hover:bg-surface-2 hover:text-ink' : 'cursor-not-allowed text-ash-dim/40'}"
              disabled={!canUndo(history)}
              title="Undo (Ctrl+Z)"
              aria-label="Undo edit"
              onclick={undoEdit}
            >↶</button>
            <button
              type="button"
              class="rounded px-1.5 py-0.5 font-mono text-xs transition-colors
                {canRedo(history) ? 'text-ash hover:bg-surface-2 hover:text-ink' : 'cursor-not-allowed text-ash-dim/40'}"
              disabled={!canRedo(history)}
              title="Redo (Ctrl+Shift+Z)"
              aria-label="Redo edit"
              onclick={redoEdit}
            >↷</button>
          </div>
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
              onclick={openFolder}
              title="Open the artifact folder on disk"
            >
              <Icon name="folder" size={12} /> Open folder
            </button>
            {#if folderError}
              <span class="text-xs text-danger" role="alert">{folderError}</span>
            {/if}
          </div>

          <!-- One row per artifact, rendered from the server's view. A
               single-download project has ONE video row (no proxy row),
               because there is only one file. -->
          {#each artifacts as art (art.kind)}
            <div class="flex flex-col gap-0.5">
              <div class="flex items-center gap-2">
                <span class="w-24 shrink-0 font-mono text-xs text-ash">{art.label}</span>
                {#if art.status === 'running'}
                  <button
                    class="flex items-center gap-1 rounded-md border border-accent px-2 py-1 text-xs text-accent transition-colors hover:border-error hover:text-error"
                    onclick={() => cancelPieceMutation.mutate(art.kind)}
                    title="Cancel this download (partial file is kept)"
                  >
                    <Icon name="close" size={11} /> Cancel
                  </button>
                {:else if art.onDisk}
                  <span class="flex items-center gap-1 font-mono text-[11px] text-success" title="On disk">
                    <Icon name="check" size={11} /> on disk
                  </span>
                {:else}
                  <!-- The resolution picker is ALWAYS present, defaulting to
                       — none —. With no resolution selected there is nothing
                       to download, so the Download button is disabled (and a
                       proxy with no available resolutions stays visible but
                       cannot be downloaded). -->
                  {#if art.kind === 'proxy'}
                    <select
                      bind:value={proxyHeight}
                      class="rounded border border-border bg-surface-2 px-1.5 py-1 text-[10px] text-ink focus:border-accent focus:outline-none"
                      aria-label="Proxy resolution"
                      title={proxyChoices.length === 0
                        ? 'No resolution is available below the video quality'
                        : 'Proxy resolution'}
                    >
                      <option value={null}>— none —</option>
                      {#each proxyChoices as q (q.name)}
                        <option value={q.height}>{q.name}</option>
                      {/each}
                    </select>
                  {:else if art.kind === 'video'}
                    <select
                      bind:value={hqHeight}
                      class="rounded border border-border bg-surface-2 px-1.5 py-1 text-[10px] text-ink focus:border-accent focus:outline-none"
                      aria-label="Video resolution"
                    >
                      <option value={null}>— none —</option>
                      {#each qualityList as q (q.name)}
                        <option value={q.height}>{q.name}</option>
                      {/each}
                    </select>
                  {/if}
                  <button
                    class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-accent hover:text-accent disabled:opacity-50"
                    onclick={() => startPiece(art.kind)}
                    disabled={!canDownload(art.kind)}
                    title={downloadTitle(art.kind)}
                  >
                    <Icon name="download" size={11} /> Download
                  </button>
                {/if}
                {#if art.bytes > 0}
                  <span class="font-mono text-[10px] text-ash-dim">{fmtBytes(art.bytes)}</span>
                {/if}
                <span class="flex-1"></span>
                {#if art.removable && !mediaBusy}
                  <button
                    class="flex h-6 w-6 items-center justify-center rounded text-ash-dim transition-colors hover:text-error"
                    onclick={() => (trashTarget = art.kind as TrashTarget)}
                    aria-label={`Delete ${art.label}`}
                  >
                    <Icon name="trash" size={12} />
                  </button>
                {/if}
              </div>
              {#if art.status === 'running'}
                <div class="flex items-center gap-2 pl-[6.5rem]">
                  {#if art.kind === 'chat'}
                    <!-- GQL chat has no total: indeterminate pulse -->
                    <div class="h-1 flex-1 animate-pulse overflow-hidden rounded-full bg-accent/40"></div>
                    <span class="font-mono text-[10px] text-ash-dim">{Math.floor(art.frontierSec ?? 0)} comments</span>
                  {:else}
                    <div class="h-1 flex-1 overflow-hidden rounded-full bg-surface-3">
                      <div class="h-full bg-accent transition-all" style="width: {art.percent * 100}%"></div>
                    </div>
                    <span class="font-mono text-[10px] text-ash-dim">
                      {art.bytes > 0 ? `${fmtBytes(art.bytes)} · ` : ''}{Math.round(art.percent * 100)}%
                    </span>
                  {/if}
                </div>
              {/if}
              {#if art.error && art.status === 'failed'}
                <p class="pl-[6.5rem] font-mono text-[10px] text-error">{art.error}</p>
              {/if}
            </div>
          {/each}
          {#if view?.media.previewOnly}
            <p class="font-mono text-[10px] text-warning">
              Only the proxy remains — exports are not possible until the video is re-downloaded.
            </p>
          {/if}
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
    body={trashWarning}
    confirmLabel="Delete"
    onConfirm={confirmTrash}
    onCancel={() => (trashTarget = null)}
  />
{/if}