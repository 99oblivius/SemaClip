<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { wsStore } from '$lib/stores/ws';
  import { playerStore, selectClip, setZoom, pan, frameClip, setView } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import VideoPlayer from '$lib/components/VideoPlayer.svelte';
  import { downloadsQuery, viewFor } from '$lib/api/downloads';
  import Timeline from '$lib/components/Timeline.svelte';
  import SignalBar from '$lib/components/SignalBar.svelte';
  import KeyboardHelp from '$lib/components/KeyboardHelp.svelte';
  import ProjectSettings from '$lib/components/ProjectSettings.svelte';
  import RightPanel from '$lib/components/RightPanel.svelte';
  import ClipDetail from '$lib/components/ClipDetail.svelte';
  import type { Clip, EngineEvent, Axis } from '$shared/types';
  import { fadeIn } from '$lib/actions/gsap';
  import { onMount, onDestroy } from 'svelte';
  let { params } = $props();
  const streamId = $derived(params.id);
  const queryClient = useQueryClient();

  const streamQuery = createQuery(() => ({
    queryKey: ['stream', streamId],
    queryFn: () => apiClient.getStream(streamId),
  }));

  const clipsQuery = createQuery(() => ({
    queryKey: ['clips', streamId],
    queryFn: () => apiClient.listClips(streamId),
  }));

  let playerComp = $state<VideoPlayer | undefined>(undefined);
  let currentClipIndex = $state(0);
  let followClip = $state(false);
  let showKeyboardHelp = $state(false);
  let discarded = $state<Set<string>>(new Set());
  let pendingUndo = $state<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);
  // Q toggles: show only clips without a review decision (default view) or everything.
  let unreviewedOnly = $state(true);

  const allClips = $derived(clipsQuery.data ?? []);
  // Axis filters (keys 1–7): toggled sets, AND-composed across enabled axes;
  // empty active set = no filtering. Non-matching clips dim in the queue.
  let activeAxes = $state<Set<Axis>>(new Set());
  const visibleClips = $derived(
    allClips
      .filter((c) => !c.rejected && !discarded.has(c.id))
      .filter((c) => activeAxes.size === 0 || activeAxes.has(c.axis))
      .filter((c) => !unreviewedOnly || !reviewedLocal.has(c.id))
      .sort((a, b) => {
        // Snoozed clips sort last, stable within their group.
        const aSnoozed = snoozedIds.has(a.id) ? 1 : 0;
        const bSnoozed = snoozedIds.has(b.id) ? 1 : 0;
        if (aSnoozed !== bSnoozed) return aSnoozed - bSnoozed;
        return b.score - a.score;
      })
  );
  // Locally-reviewed = accepted (kept in view history) or snoozed this session.
  // Backend persistence of accept-state is B3; until then accepted clips simply
  // leave the unreviewed set when acted on.
  let reviewedLocal = $state<Set<string>>(new Set());
  const currentClip = $derived(visibleClips[currentClipIndex]);
  const stream = $derived(streamQuery.data);

  // Playback source rule: LOCAL MEDIA FIRST, the source URL only as a fallback.
  //
  // The source URL exists to DOWNLOAD from. Streaming it for playback made a fully
  // downloaded project depend on the network, which breaks the whole point of a
  // local-first clipper (and offline use). The download view already reports which
  // local file is playable, so playback is derived from it rather than from the
  // presence of a URL.
  const downloads = downloadsQuery();
  const localMedia = $derived(viewFor(downloads.data?.views, streamId)?.media ?? null);
  /**
   * What the player may play: LOCAL MEDIA ONLY, never the VOD URL.
   *
   * The source URL exists to DOWNLOAD from. It used to reach the player as an HLS
   * fallback ("no local file yet, so stream from Twitch"), which is why the player kept
   * showing the vod url despite repeated attempts to remove it: the fallback was still a
   * legitimate branch, so every state without a local file landed on it. It is gone. The
   * player receives `playablePath` or nothing, and nothing renders an explicit
   * "not downloaded yet" state rather than silently streaming the remote VOD.
   *
   * Review prefers the proxy (it lands first and scrubs cheaply); the video is the
   * export/render source, reported separately as `renderPath`.
   */
  const playableSrc = $derived(localMedia?.playablePath ?? null);


  // ── Undo/redo history (P0-12): endpoint edits push undo entries; Ctrl+Z /
  // Ctrl+Shift+Z walk the stack. Entries carry the clip id + before/after,
  // so undo works even after the selection moved. ──
  type EndpointEdit = { clipId: string; before: { startTime: number; endTime: number }; after: { startTime: number; endTime: number } };
  let undoStack = $state<EndpointEdit[]>([]);
  let redoStack = $state<EndpointEdit[]>([]);
  let lastUndoToast = $state<string | null>(null);

  function pushEdit(clipId: string, before: { startTime: number; endTime: number }, after: { startTime: number; endTime: number }) {
    if (before.startTime === after.startTime && before.endTime === after.endTime) return;
    undoStack = [...undoStack, { clipId, before, after }];
    if (undoStack.length > 100) undoStack = undoStack.slice(-100); // bounded
    redoStack = []; // new edit invalidates the redo branch
  }

  function applyEndpoint(clipId: string, e: { startTime: number; endTime: number }) {
    queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
      old?.map((c) => (c.id === clipId ? { ...c, startTime: e.startTime, endTime: e.endTime } : c)),
    );
    apiClient.updateClip(clipId, e).catch((err) => console.error('updateClip failed:', err));
  }

  function undoEdit() {
    const entry = undoStack[undoStack.length - 1];
    if (!entry) return;
    undoStack = undoStack.slice(0, -1);
    redoStack = [...redoStack, entry];
    applyEndpoint(entry.clipId, entry.before);
    lastUndoToast = 'Endpoint restored';
    setTimeout(() => (lastUndoToast = null), 2000);
  }

  function redoEdit() {
    const entry = redoStack[redoStack.length - 1];
    if (!entry) return;
    redoStack = redoStack.slice(0, -1);
    undoStack = [...undoStack, entry];
    applyEndpoint(entry.clipId, entry.after);
    lastUndoToast = 'Endpoint reapplied';
    setTimeout(() => (lastUndoToast = null), 2000);
  }

  /** Persist an endpoint change locally + to the backend (fire-and-forget with
   *  rollback on failure — a silently dropped edit desyncs UI and DB). */
  function setEndpoint(which: 'start' | 'end', time: number) {
    if (!currentClip) return;
    const next = which === 'start'
      ? { startTime: Math.min(time, currentClip.endTime - 1) }
      : { endTime: Math.max(time, currentClip.startTime + 1) };
    const before = { startTime: currentClip.startTime, endTime: currentClip.endTime };
    const after = { startTime: next.startTime ?? currentClip.startTime, endTime: next.endTime ?? currentClip.endTime };
    pushEdit(currentClip.id, before, after);
    queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
      old?.map((c) => (c.id === currentClip.id ? { ...c, ...next } : c)),
    );
    apiClient.updateClip(currentClip.id, next).catch((err) => {
      console.error('updateClip failed:', err);
      queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
        old?.map((c) => (c.id === currentClip.id ? { ...c, ...before } : c)),
      );
    });
  }

  /** S: move the current candidate to the end of the audit queue. */
  function snoozeClip() {
    if (!currentClip) return;
    snoozedIds = new Set([...snoozedIds, currentClip.id]);
    currentClipIndex = 0;
  }
  let snoozedIds = $state<Set<string>>(new Set());

  function toggleAxisFilter(axis: Axis) {
    const next = new Set(activeAxes);
    if (next.has(axis)) next.delete(axis);
    else next.add(axis);
    activeAxes = next;
    currentClipIndex = 0;
  }

  let unsub: (() => void) | null = null;
  let seekUnsub: (() => void) | null = null;

  onMount(() => {
    // Caption-editor cue clicks seek the player (component bridge event —
    // CustomEvent can't be typed on svelte:window, so addEventListener here).
    const onSeek = (e: Event) => {
      const t = (e as CustomEvent<number>).detail;
      if (typeof t === 'number') playerComp?.seekToExported(t);
    };
    window.addEventListener('semaclip:seek', onSeek);
    seekUnsub = () => window.removeEventListener('semaclip:seek', onSeek);

    unsub = wsStore.onEvent<EngineEvent>((event) => {
      if (event.type === 'clip') clipsQuery.refetch();
      else if (event.type === 'complete') {
        queryClient.invalidateQueries({ queryKey: ['clips', streamId] });
      }
    });
  });

  onDestroy(() => {
    unsub?.();
    seekUnsub?.();
    if (pendingUndo) clearTimeout(pendingUndo.timer);
  });

  // Caption-editor cue clicks seek the player (component bridge event).
  function handleSeekEvent(e: Event) {
    const t = (e as CustomEvent<number>).detail;
    if (typeof t === 'number') playerComp?.seekToExported(t);
  }

  function playClip(clip: Clip) {
    playerComp?.playClip(clip);
    selectClip(clip.id);
  }

  function jumpToClip(clip: Clip) {
    playerComp?.jumpToClipPeak(clip);
    selectClip(clip.id);
  }

  function nextClip() {
    if (currentClipIndex < visibleClips.length - 1) {
      currentClipIndex++;
      if (currentClip) jumpToClip(currentClip);
    }
  }

  function prevClip() {
    if (currentClipIndex > 0) {
      currentClipIndex--;
      if (currentClip) jumpToClip(currentClip);
    }
  }

  function handleClipEnd() {
    // Auto-advance to next clip's peak.
    nextClip();
  }

  function discardClip() {
    if (!currentClip) return;
    const id = currentClip.id;
    discarded = new Set(discarded).add(id);
    // Surface failure — a silently-failed reject would desync UI and DB.
    apiClient.rejectClip(id).catch((err) => {
      console.error('rejectClip failed:', err);
      discarded = new Set([...discarded].filter((d) => d !== id));
    });
    // Undo window (5s)
    if (pendingUndo) clearTimeout(pendingUndo.timer);
    const timer = setTimeout(() => (pendingUndo = null), 5000);
    pendingUndo = { id, timer };
    nextClip();
  }

  function undoDiscard() {
    if (!pendingUndo) return;
    discarded = new Set([...discarded].filter((id) => id !== pendingUndo!.id));
    pendingUndo = null;
  }

  function exportClip() {
    // Export is a first-class screen (P0-7); deep-link with the clip id.
    window.location.href = `/export?clip=${currentClip?.id ?? ''}`;
  }

  function exportAllClips() {
    window.location.href = '/export';
  }

  /** A: accept = mark reviewed and advance (persistence of accept-state is B3). */
  function acceptClip() {
    if (!currentClip) return;
    reviewedLocal = new Set([...reviewedLocal, currentClip.id]);
    nextClip();
  }

  function adjustEndpoints(clip: Clip, start: number, end: number) {
    const before = { startTime: clip.startTime, endTime: clip.endTime };
    const after = { startTime: start, endTime: end };
    pushEdit(clip.id, before, after);
    queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
      old?.map((c) => (c.id === clip.id ? { ...c, startTime: start, endTime: end } : c)),
    );
    apiClient.updateClip(clip.id, after).catch((err) => console.error('updateClip failed:', err));
  }

  /** Toggle clip-follow: frame the timeline to the selected clip's bounds
   *  with 10% padding, or reset to full VOD view. */
  function handleFollowClip() {
    if (!currentClip || !stream?.duration) return;
    if (followClip) {
      setView(0, stream.duration);
      followClip = false;
    } else {
      frameClip(currentClip.startTime, currentClip.endTime, stream.duration);
      followClip = true;
    }
  }

  // When followClip is active and the selected clip changes, auto-reframe.
  $effect(() => {
    if (!currentClip || !stream?.duration || !followClip) return;
    frameClip(currentClip.startTime, currentClip.endTime, stream.duration);
  });

  function handleKey(e: KeyboardEvent) {
    const target = e.target as HTMLElement;
    if (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA') return;
    if (showKeyboardHelp) {
      if (e.key === 'Escape') showKeyboardHelp = false;
      return;
    }

    switch (e.key) {
      case ' ':
        e.preventDefault();
        playerComp?.togglePlayExported();
        break;
      case 'k': case 'K':
        e.preventDefault();
        nextClip();
        break;
      case 'j': case 'J':
        e.preventDefault();
        prevClip();
        break;
      case 'ArrowLeft':
        e.preventDefault();
        if (e.shiftKey) playerComp?.seekRelativeExported(-1);
        else playerComp?.seekRelativeExported(-5);
        break;
      case 'ArrowRight':
        e.preventDefault();
        if (e.shiftKey) playerComp?.seekRelativeExported(1);
        else playerComp?.seekRelativeExported(5);
        break;
      case ',': case '<':
        e.preventDefault();
        playerComp?.frameStepExported(e.shiftKey ? -1 : -1 / 30);
        break;
      case '.': case '>':
        e.preventDefault();
        playerComp?.frameStepExported(e.shiftKey ? 1 : 1 / 30);
        break;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': {
        // Axis filters — toggles the corresponding axis chip.
        const axes = ['hype', 'humor', 'skill', 'awkward', 'emotional', 'tension', 'reaction'] as const;
        const axis = axes[parseInt(e.key, 10) - 1]!;
        toggleAxisFilter(axis);
        e.preventDefault();
        break;
      }
      case '+': case '=':
        e.preventDefault();
        if (stream?.duration) setZoom(($playerStore.zoomLevel || 1) * 1.5, stream.duration, $playerStore.currentTime);
        break;
      case '-': case '_':
        e.preventDefault();
        if (stream?.duration) setZoom(($playerStore.zoomLevel || 1) / 1.5, stream.duration, $playerStore.currentTime);
        break;
      case 'e': case 'E':
        e.preventDefault();
        if (e.shiftKey) exportAllClips();
        else exportClip();
        break;
      case 'a': case 'A':
        e.preventDefault();
        acceptClip();
        break;
      case 'd': case 'D':
        e.preventDefault();
        discardClip();
        break;
      case 'i': case 'I':
        e.preventDefault();
        if (currentClip) setEndpoint('start', $playerStore.currentTime);
        break;
      case 'o': case 'O':
        e.preventDefault();
        if (currentClip) setEndpoint('end', $playerStore.currentTime);
        break;
      case 's': case 'S':
        e.preventDefault();
        snoozeClip();
        break;
      case 'q': case 'Q':
        e.preventDefault();
        unreviewedOnly = !unreviewedOnly;
        currentClipIndex = 0;
        break;
      case 'u': case 'U':
        e.preventDefault();
        undoDiscard();
        break;
      case 'm': case 'M':
        e.preventDefault();
        playerComp?.toggleMuteExported();
        break;
      case 'f': case 'F':
        e.preventDefault();
        playerComp?.toggleFullscreenExported();
        break;
      case '?':
        e.preventDefault();
        showKeyboardHelp = true;
        break;
      case 'z': case 'Z':
        // Ctrl+Z undo / Ctrl+Shift+Z redo (endpoint edits, P0-12).
        if (e.ctrlKey || e.metaKey) {
          e.preventDefault();
          if (e.shiftKey) redoEdit();
          else undoEdit();
        }
        break;
      case 'Escape':
        // Back out one level: Review → Library (SPA nav preserves state).
        window.location.href = '/';
        break;
    }
  }

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

</script>

<svelte:window onkeydown={handleKey} />

<div class="flex h-full flex-col gap-3 p-4" use:fadeIn>
  <!-- Header -->
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <a href="/" class="flex items-center gap-1 text-ash transition-colors hover:text-ink">
        <Icon name="back" size={16} />
        <span class="text-xs">Library</span>
      </a>
      <span class="text-ash-dim">/</span>
      <span class="font-display text-base font-medium">{stream?.title ?? 'Loading...'}</span>
      {#if stream?.streamer}
        <span class="font-mono text-xs text-ash-dim">· {stream.streamer}</span>
      {/if}
    </div>
    <div class="flex items-center gap-3">
      <span class="font-mono text-xs text-ash">
        {visibleClips.length} clips · {stream ? fmtTime(stream.duration ?? 0) : '--'}
      </span>
      <button
        class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
        onclick={() => (showKeyboardHelp = true)}
        aria-label="Keyboard shortcuts"
      >
        <Icon name="keyboard" size={14} />
      </button>
      {#if stream}
        <ProjectSettings {stream} />
      {/if}
      <button
        class="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover"
        onclick={exportAllClips}
        aria-label="Export all clips"
      >
        <Icon name="scissors" size={14} />
        Export All
      </button>
    </div>
  </div>

  <div class="flex flex-1 gap-3 overflow-hidden">
    <!-- Left: video + timeline + clip detail -->
    <div class="flex flex-1 flex-col gap-3">
      <!-- Video player -->
      <VideoPlayer
        bind:this={playerComp}
        {streamId}
        duration={stream?.duration ?? null}
        clips={visibleClips}
        currentClip={currentClip}
        onClipEnd={handleClipEnd}
      />
      <!-- Signal terrain timeline -->
      <div class="relative rounded-md border border-border bg-surface h-20">
        {#if stream?.duration}
          <Timeline
            {streamId}
            duration={stream.duration}
            clips={visibleClips}
            currentClipId={currentClip?.id ?? null}
            onSelectClip={(clip) => { currentClipIndex = visibleClips.findIndex((c) => c.id === clip.id); jumpToClip(clip); }}
            onAdjustEndpoints={adjustEndpoints}
            onSeek={(time) => playerComp?.seekToExported(time)}
          />
        {:else}
          <div class="flex h-full items-center justify-center text-xs text-ash-dim">Loading timeline...</div>
        {/if}

        <!-- Clip-follow toggle: minimal [ ] in top-right corner -->
        {#if currentClip}
          <button
            class="absolute top-1 right-1 z-10 rounded p-0.5 transition-colors
            {followClip ? 'bg-accent/15 text-accent' : 'text-ash-dim hover:bg-surface-2 hover:text-ash'}"
            onclick={handleFollowClip}
            aria-label={followClip ? 'Fit to full VOD' : 'Frame to clip'}
            title={followClip ? 'Fit to full VOD (framing timeline to clip bounds)' : 'Frame timeline to selected clip'}
          >
            <Icon name="frame" size={16} fill={followClip} />
          </button>
        {/if}
      </div>

      <!-- Active clip detail -->
      <div class="rounded-md border border-border bg-surface p-4">
        {#if currentClip}
          <ClipDetail
            clip={currentClip}
            clipIndex={currentClipIndex}
            {streamId}
            onPlay={() => playClip(currentClip)}
            onExport={exportClip}
            onDiscard={discardClip}
            onAccept={acceptClip}
          />
        {:else}
          <div class="flex items-center justify-center py-8">
            <p class="text-sm text-ash-dim">No clip selected. Click a clip in the timeline or queue to inspect it.</p>
          </div>
        {/if}
      </div>

      <!-- Undo toast for discarded clips -->
      {#if pendingUndo}
        <div class="fixed bottom-4 left-1/2 -translate-x-1/2 rounded-md border border-border bg-surface-2 px-4 py-2 text-xs text-ash shadow-lg">
          Clip discarded. <button class="text-accent hover:underline" onclick={undoDiscard}>Undo</button>
        </div>
      {/if}
    </div>

    <!-- Right: tabbed clips + chat -->
    <RightPanel
      {streamId}
      stream={stream}
      clips={visibleClips}
      {currentClipIndex}
      reviewed={reviewedLocal}
      onSelectClip={(i) => { currentClipIndex = i; if (visibleClips[i]) jumpToClip(visibleClips[i]); }}
    />
  </div>
</div>

{#if showKeyboardHelp}
  <KeyboardHelp onClose={() => (showKeyboardHelp = false)} />
{/if}
