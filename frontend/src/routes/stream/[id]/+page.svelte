<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { wsStore } from '$lib/stores/ws';
  import { playerStore, selectClip, setZoom, pan, frameClip, setView } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import VideoPlayer from '$lib/components/VideoPlayer.svelte';
  import Timeline from '$lib/components/Timeline.svelte';
  import SignalBar from '$lib/components/SignalBar.svelte';
  import KeyboardHelp from '$lib/components/KeyboardHelp.svelte';
  import ProjectSettings from '$lib/components/ProjectSettings.svelte';
  import RightPanel from '$lib/components/RightPanel.svelte';
  import CaptionEditor from '$lib/components/CaptionEditor.svelte';
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

  /** Persist an endpoint change locally + to the backend (fire-and-forget with
   *  rollback on failure — a silently dropped edit desyncs UI and DB). */
  function setEndpoint(which: 'start' | 'end', time: number) {
    if (!currentClip) return;
    const next = which === 'start'
      ? { startTime: Math.min(time, currentClip.endTime - 1) }
      : { endTime: Math.max(time, currentClip.startTime + 1) };
    const before = { startTime: currentClip.startTime, endTime: currentClip.endTime };
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
    // Local optimistic update — the backend persists via a dedicated endpoint if needed.
    // For now, update in the query cache.
    queryClient.setQueryData<Clip[]>(['clips', streamId], (old) =>
      old?.map((c) => (c.id === clip.id ? { ...c, startTime: start, endTime: end } : c)),
    );
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
      case 'Escape':
        // SPA navigation — full reload (v1) dropped all client state.
        window.location.href = `/stream/${streamId}/processing`;
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
          <div class="mb-3 flex items-center justify-between">
            <div class="flex items-center gap-3">
              <span class="font-mono text-xs text-ash-dim">{String(currentClipIndex + 1).padStart(2, '0')}</span>
              <span class="font-display text-sm font-medium text-accent uppercase">{currentClip.axis}</span>
              <span class="font-mono text-sm text-ink">{currentClip.score.toFixed(2)}</span>
            </div>
            <div class="flex items-center gap-2">
              <button
                class="flex items-center gap-1 rounded-md border border-success/50 px-2 py-1 text-xs text-success transition-colors hover:bg-success/10"
                onclick={acceptClip}
                aria-label="Accept clip"
                title="Accept (A) — marks reviewed and advances"
              >
                <Icon name="check" size={12} /> Accept
              </button>
              <button
                class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
                onclick={exportClip}
                aria-label="Export this clip"
              >
                <Icon name="scissors" size={12} /> Export
              </button>
              <button
                class="flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-ash transition-colors hover:border-error hover:text-error"
                onclick={discardClip}
                aria-label="Discard clip"
              >
                <Icon name="trash" size={12} /> Discard
              </button>
            </div>
          </div>

          {#if currentClip.justification}
            <p class="mb-3 text-sm text-ash leading-relaxed">{currentClip.justification}</p>
          {:else}
            <p class="mb-3 text-sm text-ash-dim italic">No justification provided.</p>
          {/if}

          <div class="grid grid-cols-3 gap-4">
            <!-- Signals: real engine evidence, or an honest absence. -->
            <div class="col-span-1">
              <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Signals</div>
              {#if currentClip.signals}
                <div class="flex flex-col gap-1.5">
                  <SignalBar label="chat" value={currentClip.signals.chatExcitement} />
                  <SignalBar label="emote" value={currentClip.signals.emoteVelocity} />
                  <SignalBar label="audio" value={currentClip.signals.audioEnergy} />
                  <SignalBar label="speech" value={currentClip.signals.speechCoverage} />
                </div>
              {:else}
                <div class="text-xs text-ash-dim italic">No signal data from engine.</div>
              {/if}
            </div>

            <!-- Endpoints -->
            <div class="col-span-1">
              <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Endpoints</div>
              <div class="flex flex-col gap-1 font-mono text-xs">
                <div class="flex justify-between"><span class="text-ash-dim">Start</span><span class="text-ink">{fmtTime(currentClip.startTime)}</span></div>
                <div class="flex justify-between"><span class="text-ash-dim">Peak</span><span class="text-accent">{fmtTime(currentClip.peakTime)}</span></div>
                <div class="flex justify-between"><span class="text-ash-dim">End</span><span class="text-ink">{fmtTime(currentClip.endTime)}</span></div>
                <div class="flex justify-between border-t border-border pt-1"><span class="text-ash-dim">Dur</span><span class="text-ink">{(currentClip.endTime - currentClip.startTime).toFixed(0)}s</span></div>
              </div>
            </div>

            <!-- Actions -->
            <div class="col-span-1 flex flex-col gap-2">
              <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Actions</div>
              <button
                class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-ash transition-colors hover:border-accent hover:text-accent"
                onclick={() => playClip(currentClip)}
              >
                <Icon name="play" size={12} fill /> Play from start
              </button>
              <button
                class="flex items-center gap-2 rounded-md border border-border px-3 py-1.5 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
                onclick={exportClip}
              >
                <Icon name="scissors" size={12} /> Export clip
              </button>
            </div>
          </div>

          <!-- Captions (P0-8): line-level transcript editing for this clip's window -->
          <div class="mt-4 border-t border-border pt-3">
            <CaptionEditor {streamId} clipStart={currentClip.startTime} clipEnd={currentClip.endTime} />
          </div>
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
      onSelectClip={(i) => { currentClipIndex = i; if (visibleClips[i]) jumpToClip(visibleClips[i]); }}
    />
  </div>
</div>

{#if showKeyboardHelp}
  <KeyboardHelp onClose={() => (showKeyboardHelp = false)} />
{/if}
