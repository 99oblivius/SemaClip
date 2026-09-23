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
  // Q toggles: "hide the clips set aside this session". A candidate stays visible until it is
  // discarded, so this OFF by default and reads the snooze set — which is the only thing that can
  // currently set a clip aside.
  let unreviewedOnly = $state(false);

  const allClips = $derived(clipsQuery.data ?? []);
  // Axis filters (keys 1–7): toggled sets, AND-composed across enabled axes;
  // empty active set = no filtering. Non-matching clips dim in the queue.
  let activeAxes = $state<Set<Axis>>(new Set());
  const visibleClips = $derived(
    allClips
      .filter((c) => !c.rejected && !discarded.has(c.id))
      // A manual clip has NO axis, so an axis filter must not hide it: the filters select which
      // ENGINE axes to look at, and a clip the user drew by hand is not an axis result. Treating
      // null as "no match" would make every hand-made clip vanish as soon as any filter is on.
      .filter((c) => activeAxes.size === 0 || c.axis === null || activeAxes.has(c.axis))
      .filter((c) => !unreviewedOnly || !snoozedIds.has(c.id))
      .sort((a, b) => {
        // Snoozed clips sort last, stable within their group.
        const aSnoozed = snoozedIds.has(a.id) ? 1 : 0;
        const bSnoozed = snoozedIds.has(b.id) ? 1 : 0;
        if (aSnoozed !== bSnoozed) return aSnoozed - bSnoozed;
        // Unranked clips (manual ones carry no score) sort by POSITION instead of being coerced
        // to a number — a null score must not rank as 0 or as NaN, which would scatter them
        // unpredictably through the engine's ranking.
        const score = (c: Clip) => c.score ?? -1;
        const byScore = score(b) - score(a);
        if (byScore !== 0) return byScore;
        return a.startTime - b.startTime;
      })
  );
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
  /** The project's own view: what says whether its folder is reachable right now. */
  const projectView = $derived(viewFor(downloads.data?.views, streamId));
  /**
   * The project's folder is gone (an unmounted drive, a moved folder).
   *
   * Everything below the header is blocked while this is true, because every action there
   * would fail against a missing file — exports, clip edits, playback. The HEADER stays live
   * so the settings panel (Change Location) can be reached to fix it: blocking the only route
   * to the repair would trap the user. Measured server-side on every read, so plugging the
   * drive back in clears this without a refresh.
   */
  const unreachable = $derived(
    viewFor(downloads.data?.views, streamId)?.reachable === false,
  );
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

  /**
   * S: move the current candidate to the end of the audit queue.
   *
   * `unreviewedOnly` is off by DEFAULT because a candidate must stay visible: discarding is the only
   * thing that removes a clip from view, so starting filtered would hide every existing clip behind
   * a toggle the user never asked for.
   */
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

  /**
   * Select a clip and move the playhead to it.
   *
   * The playhead goes to the clip's START, never its `peakTime`. Selecting a candidate used to jump
   * to the peak, which is the point the ENGINE found rather than where the clip begins — so the
   * player landed mid-clip and the timeline's start line did not agree with the playhead. A clip has
   * exactly two meaningful timestamps, and the one you land on when you open it is the start.
   */
  function jumpToClip(clip: Clip) {
    playerComp?.seekToExported(clip.startTime);
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
    // "Send to export" is a real WRITE, not just navigation: the clip is added to the durable
    // export list, so the Export page shows what the user actually chose. Navigating alone left the
    // list to be inferred from "every clip that still exists", which made the Review page's Export
    // button indistinguishable from doing nothing.
    if (!currentClip) return;
    sendToExportMutation.mutate([currentClip.id]);
  }

  function exportAllClips() {
    // Every VISIBLE candidate — what the reviewer can see is what they mean by "all". Discarded
    // clips are already excluded from the panel, so they are excluded here too.
    const ids = visibleClips.map((c) => c.id);
    if (ids.length === 0) return;
    sendToExportMutation.mutate(ids);
  }

  /**
   * Add clips to the export list, then open the Export screen.
   *
   * The navigation happens on SUCCESS: opening the page first would show a list that does not yet
   * contain what the user just clicked, which reads as the button having failed.
   */
  const sendToExportMutation = createMutation(() => ({
    mutationFn: (clipIds: string[]) => apiClient.addToExportList(clipIds),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['export-list'] });
      window.location.href = '/export';
    },
  }));

  /**
   * Create a clip at the playhead, ending at the next clip's start or the VOD's end.
   *
   * The server computes the end (one owner for that rule). The response is adopted and the new
   * clip is SELECTED, so pressing the button leaves the user editing what they just made rather
   * than wondering whether anything happened.
   */
  function createClipAtPlayhead() {
    if (!stream) return;
    const at = $playerStore.currentTime;
    createClipMutation.mutate({ streamId, startTime: at });
  }

  const createClipMutation = createMutation(() => ({
    mutationFn: (input: { streamId: string; startTime: number }) =>
      apiClient.createClip(input.streamId, { startTime: input.startTime }),
    onSuccess: (created: Clip) => {
      // Seed the cache so the new clip is present before the refetch lands, then invalidate so
      // the panel reconciles with the server's own ordering.
      queryClient.setQueryData<Clip[]>(['clips', streamId], (old) => [...(old ?? []), created]);
      queryClient.invalidateQueries({ queryKey: ['clips', streamId] });
      // Select it: creation is the one mutation whose result the user must immediately see.
      currentClipIndex = 0;
      jumpToClip(created);
    },
  }));

  /**
   * Rename a clip.
   *
   * The name is the `title` field, NOT the axis: `axis` is an engine enum (hype/humor/…) used by
   * validation, filtering and axis-weight feedback, so a typed name stored there would corrupt all
   * three. A clip keeps its axis while being renamed, and a manual clip stays axis-less.
   *
   * Saved through the same update route as the endpoints, optimistically into the cache so the
   * field does not flicker back to the old value while the request is in flight. A blank name is not
   * sent: the server refuses it, and an empty field should leave the previous name alone rather than
   * clear it — clearing is a deliberate act, not a side effect of blurring an empty box.
   */
  function renameClip(clip: Clip, name: string) {
    const trimmed = name.trim();
    if (trimmed.length === 0 || trimmed === clip.title) return;
    queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
      old?.map((c) => (c.id === clip.id ? { ...c, title: trimmed } : c)),
    );
    apiClient.updateClip(clip.id, { title: trimmed }).catch((err) => console.error('renameClip failed:', err));
  }

  /**
   * A drag in progress: move the UI, and NOTHING else.
   *
   * This used to push an undo entry and a PUT per mousemove — a 60Hz drag wrote ~60 history
   * entries, so a single gesture took 60 presses of Ctrl+Z to reverse and made the undo stack
   * useless for anything else. The live frames are deliberately local (query cache only); the
   * gesture is committed once by `commitEndpoints` below.
   */
  function adjustEndpoints(clip: Clip, start: number, end: number) {
    queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
      old?.map((c) => (c.id === clip.id ? { ...c, startTime: start, endTime: end } : c)),
    );
  }

  /**
   * The drag ended: ONE undo entry and ONE persist for the whole gesture.
   *
   * `before` comes from the component (captured at press, since the live frames above have
   * already overwritten it); `after` is read back from the cache, which by now holds the
   * dragged range. A drag that ends where it began pushes nothing (`pushEdit` drops it).
   */
  function commitEndpoints(clipId: string, before: { startTime: number; endTime: number }) {
    const after = queryClient
      .getQueryData<Clip[]>(['clips', streamId])
      ?.find((c) => c.id === clipId);
    if (!after) return;
    const range = { startTime: after.startTime, endTime: after.endTime };
    pushEdit(clipId, before, range);
    apiClient.updateClip(clipId, range).catch((err) => {
      console.error('updateClip failed:', err);
      queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
        old?.map((c) => (c.id === clipId ? { ...c, ...before } : c)),
      );
    });
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
      // `A` (accept) is GONE with the Accept button: candidates are never removed by accepting, so
      // the key marked a clip as reviewed for a state nothing read. `S` already snoozes — the one
      // "set this aside" verb the queue has — so aliasing A to it would only hide the removal.
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
      // Aliases for in/out that clip editors' hands already know. `[` opens the clip and `]`
      // closes it, and both are unclaimed here (I/O keep working).
      case '[':
        e.preventDefault();
        if (currentClip) setEndpoint('start', $playerStore.currentTime);
        break;
      case ']':
        e.preventDefault();
        if (currentClip) setEndpoint('end', $playerStore.currentTime);
        break;
      // Create a clip at the playhead. Deliberately NOT a chord: this is the primary action of
      // hand-cutting, and the no-gating rule wants it reachable in one keystroke.
      case 'n': case 'N':
        e.preventDefault();
        createClipAtPlayhead();
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
        class="flex items-center gap-1 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-accent-hover disabled:cursor-not-allowed disabled:opacity-40"
        onclick={exportAllClips}
        disabled={unreachable}
        title={unreachable ? 'This project\'s folder is not reachable — use Project settings → Change Location' : 'Export all clips'}
        aria-label="Export all clips"
      >
        <Icon name="upload" size={14} />
        Export All
      </button>
    </div>
  </div>

  <!--
    The project's folder is gone: block everything below the header.

    An overlay rather than a `pointer-events` toggle on each child, because the rule must hold
    for controls nobody enumerated — the player, the timeline's drag handles, the candidate
    queue, the chat. The HEADER sits outside this wrapper, so the settings panel and its
    Change Location button stay reachable; the panel itself renders at z-40, above this layer.
  -->
  <div class="relative flex flex-1 flex-col overflow-hidden">
  <div class="flex flex-1 gap-3 overflow-hidden {unreachable ? 'pointer-events-none select-none' : ''}">
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
            onCommitEndpoints={commitEndpoints}
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

      <!-- Active clip detail, with the manual-clip action rail to its LEFT.
           The timeline above keeps its full width: the rail takes a strip from the detail row
           only, so nothing about the timeline's geometry changes. The rail is frameless (no
           border, no background) — the icons read as tools belonging to the panel, not as a
           second container competing with it. Every button is icon-only with its name on hover,
           and every one also has a key (no-gating: a visible surface AND a keybinding). -->
      <div class="flex gap-3">
        <div class="flex shrink-0 flex-col items-center gap-1 pt-1" role="toolbar" aria-label="Clip actions" aria-orientation="vertical">
          <button
            class="rounded p-1.5 text-ash-dim transition-colors hover:bg-surface-2 hover:text-accent disabled:cursor-not-allowed disabled:opacity-30"
            onclick={createClipAtPlayhead}
            disabled={!stream}
            title="Create clip — from the playhead to the next clip or the end of the video (N)"
            aria-label="Create clip at playhead"
          >
            <Icon name="plus" size={16} />
          </button>

          <button
            class="rounded p-1.5 text-ash-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            onclick={() => currentClip && setEndpoint('start', $playerStore.currentTime)}
            disabled={!currentClip}
            title="Set clip start to the playhead ([)"
            aria-label="Set clip start"
          >
            <Icon name="bracket-left" size={16} />
          </button>

          <button
            class="rounded p-1.5 text-ash-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            onclick={() => currentClip && setEndpoint('end', $playerStore.currentTime)}
            disabled={!currentClip}
            title="Set clip end to the playhead (])"
            aria-label="Set clip end"
          >
            <Icon name="bracket-right" size={16} />
          </button>

          <button
            class="rounded p-1.5 text-ash-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            onclick={prevClip}
            disabled={visibleClips.length === 0}
            title="Previous clip (J)"
            aria-label="Previous clip"
          >
            <Icon name="arrow-left" size={16} />
          </button>

          <button
            class="rounded p-1.5 text-ash-dim transition-colors hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-30"
            onclick={nextClip}
            disabled={visibleClips.length === 0}
            title="Next clip (K)"
            aria-label="Next clip"
          >
            <Icon name="arrow-right" size={16} />
          </button>
        </div>

        <div class="min-w-0 flex-1 rounded-md border border-border bg-surface p-4">
          {#if currentClip}
            <ClipDetail
              clip={currentClip}
              clipIndex={currentClipIndex}
              {streamId}
              onPlay={() => playClip(currentClip)}
              onExport={exportClip}
              onDiscard={discardClip}
              onRename={(axis) => renameClip(currentClip, axis)}
            />
          {:else}
            <div class="flex items-center justify-center py-8">
              <p class="text-sm text-ash-dim">No clip selected. Create one at the playhead, or click a clip in the timeline or queue to inspect it.</p>
            </div>
          {/if}
        </div>
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
      snoozed={snoozedIds}
      onSelectClip={(i) => { currentClipIndex = i; if (visibleClips[i]) jumpToClip(visibleClips[i]); }}
    />
  </div>

  <!--
    The explanation, ON TOP of the blocked content: a dimming veil that also says what is
    wrong and where to fix it. It blocks input itself (the layer below is pointer-events-none
    AND this covers it), and it sits under the settings panel's z-40 so the Change Location
    control is never covered by it.
  -->
  {#if unreachable}
    <div
      class="pointer-events-auto absolute inset-0 z-30 flex items-start justify-center bg-black/55 pt-16"
      role="alert"
      aria-live="polite"
    >
      <div class="max-w-md rounded-md border border-warning/40 bg-surface px-4 py-3 shadow-lg">
        <p class="flex items-center gap-2 text-sm text-ink">
          <Icon name="alert" size={15} class="text-warning" />
          This project's folder is not there.
        </p>
        <p class="mt-1.5 text-xs text-ash">
          The drive may be unmounted, or the folder was moved. Everything here is blocked until
          it is found — use <span class="text-ink">Project settings → Change Location</span>
          {#if projectView?.streamId}<span class="text-ash-dim"> (top right)</span>{/if} to point
          this project at the folder again.
        </p>
      </div>
    </div>
  {/if}
  </div>
</div>

{#if showKeyboardHelp}
  <KeyboardHelp onClose={() => (showKeyboardHelp = false)} />
{/if}
