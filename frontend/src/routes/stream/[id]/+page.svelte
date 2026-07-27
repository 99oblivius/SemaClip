<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { wsStore } from '$lib/stores/ws';
  import { playerStore, seek, selectClip, setZoom, pan, frameClip, setView } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import VideoPlayer from '$lib/components/VideoPlayer.svelte';
  import Timeline from '$lib/components/Timeline.svelte';
  import SignalBar from '$lib/components/SignalBar.svelte';
  import ExportSheet from '$lib/components/ExportSheet.svelte';
  import KeyboardHelp from '$lib/components/KeyboardHelp.svelte';
  import ProjectSettings from '$lib/components/ProjectSettings.svelte';
  import ChatView from '$lib/components/ChatView.svelte';
  import { fadeIn } from '$lib/actions/gsap';
  import type { Clip, EngineEvent } from '$shared/types';
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
  let showExportSheet = $state(false);
  let exportAll = $state(false);
  let discarded = $state<Set<string>>(new Set());
  let pendingUndo = $state<{ id: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const allClips = $derived(clipsQuery.data ?? []);
  const visibleClips = $derived(
    allClips
      .filter((c) => !c.rejected && !discarded.has(c.id))
      .sort((a, b) => b.score - a.score)
  );
  const currentClip = $derived(visibleClips[currentClipIndex]);
  const stream = $derived(streamQuery.data);

  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = wsStore.onEvent<EngineEvent>((event) => {
      if (event.type === 'clip') clipsQuery.refetch();
      else if (event.type === 'complete') {
        queryClient.invalidateQueries({ queryKey: ['clips', streamId] });
      }
    });
  });

  onDestroy(() => {
    unsub?.();
    if (pendingUndo) clearTimeout(pendingUndo.timer);
  });

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

  function handleTimeUpdate(time: number) {
    seek(time);
  }

  function discardClip() {
    if (!currentClip) return;
    const id = currentClip.id;
    discarded = new Set(discarded).add(id);
    // API call to mark rejected
    apiClient.rejectClip(id).catch(() => {});
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
    showExportSheet = true;
    exportAll = false;
  }

  function exportAllClips() {
    showExportSheet = true;
    exportAll = true;
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
    if (showExportSheet || showKeyboardHelp) {
      if (e.key === 'Escape') {
        showExportSheet = false;
        showKeyboardHelp = false;
      }
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
      case 'd': case 'D':
        e.preventDefault();
        discardClip();
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
        onTimeUpdate={handleTimeUpdate}
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
            <!-- Signals (simulated — real signals come from clip data when available) -->
            <div class="col-span-1">
              <div class="mb-2 font-mono text-xs text-ash-dim uppercase">Signals</div>
              <div class="flex flex-col gap-1.5">
                <SignalBar label="chat" value={currentClip.score * 0.9} />
                <SignalBar label="voice" value={currentClip.score * 0.6} />
                <SignalBar label="emote" value={currentClip.score * 0.75} />
                <SignalBar label="lurker" value={currentClip.score * 0.4} />
              </div>
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

    <!-- Right: clip queue + chat -->
    <div class="flex w-72 flex-col gap-3 overflow-hidden">
      <!-- Clip queue -->
      <div class="flex flex-col gap-1 overflow-hidden rounded-md border border-border bg-surface" style="flex: 0 0 auto; max-height: 40%;">
        <div class="flex items-center justify-between border-b border-border px-3 py-2">
          <span class="font-display text-xs font-medium text-ash uppercase">Clips</span>
          <span class="font-mono text-xs text-ash-dim">{visibleClips.length}</span>
        </div>

        <!-- Clip list -->
        <div class="flex-1 overflow-y-auto">
          {#each visibleClips as clip, i (clip.id)}
            <button
              class="flex w-full items-center gap-3 border-l-2 px-3 py-2 text-left transition-colors hover:bg-surface-2
              {i === currentClipIndex ? 'border-accent bg-surface-2' : 'border-transparent'}"
              onclick={() => { currentClipIndex = i; jumpToClip(clip); }}
            >
              <span class="w-5 font-mono text-xs text-ash-dim">{i + 1}</span>
              <span class="flex-1 font-mono text-xs text-ash uppercase">{clip.axis}</span>
              <span class="font-mono text-xs text-ink">{clip.score.toFixed(2)}</span>
            </button>
          {/each}
          {#if visibleClips.length === 0}
            <div class="flex h-full flex-col items-center justify-center gap-2 p-4 text-center">
              <Icon name="waveform" size={32} fill={false} />
              <p class="text-xs text-ash-dim">No clips found yet.<br />Process the stream to detect moments.</p>
            </div>
          {/if}
        </div>
      </div>

      <!-- Chat view -->
      <div class="flex-1 min-h-0">
        <ChatView {streamId} duration={stream?.duration ?? null} />
      </div>
    </div>
  </div>
</div>

{#if showExportSheet && currentClip}
  <ExportSheet clip={currentClip} onClose={() => (showExportSheet = false)} />
{/if}

{#if showKeyboardHelp}
  <KeyboardHelp onClose={() => (showKeyboardHelp = false)} />
{/if}
