<script lang="ts">
  import { createQuery } from '@tanstack/svelte-query';
  import { apiClient } from '$lib/api/client';
  import { wsStore } from '$lib/stores/ws';
  import { playerStore, seek, selectClip } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn, keyLight } from '$lib/actions/gsap';
  import type { Clip, EngineEvent, Axis } from '$shared/types';
  import { onMount, onDestroy } from 'svelte';

  let { params } = $props();
  const streamId = $derived(params.id);

  const streamQuery = createQuery(() => ({
    queryKey: ['stream', streamId],
    queryFn: () => apiClient.getStream(streamId),
  }));

  const clipsQuery = createQuery(() => ({
    queryKey: ['clips', streamId],
    queryFn: () => apiClient.listClips(streamId),
  }));

  let videoEl = $state<HTMLVideoElement | undefined>(undefined);
  let currentClipIndex = $state(0);
  let axisFilter = $state<Axis | null>(null);

  const allClips = $derived(clipsQuery.data ?? []);
  const clips = $derived(
    allClips.filter((c) => !c.rejected).filter((c) => !axisFilter || c.axis === axisFilter)
  );
  const currentClip = $derived(clips[currentClipIndex]);
  const stream = $derived(streamQuery.data);

  let unsub: (() => void) | null = null;

  onMount(() => {
    unsub = wsStore.onEvent<EngineEvent>((event) => {
      if (event.type === 'clip') clipsQuery.refetch();
    });
  });

  onDestroy(() => unsub?.());

  function playClip(clip: Clip) {
    if (!videoEl) return;
    videoEl.currentTime = clip.startTime;
    void videoEl.play();
    selectClip(clip.id);
  }

  function nextClip() {
    if (currentClipIndex < clips.length - 1) {
      currentClipIndex++;
      const clip = clips[currentClipIndex];
      if (clip) playClip(clip);
    }
  }

  function prevClip() {
    if (currentClipIndex > 0) {
      currentClipIndex--;
      const clip = clips[currentClipIndex];
      if (clip) playClip(clip);
    }
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) void videoEl.play();
    else videoEl.pause();
  }

  function handleKey(e: KeyboardEvent) {
    const axes: Axis[] = ['hype', 'humor', 'skill', 'awkward', 'emotional', 'tension'];
    switch (e.key) {
      case ' ':
        e.preventDefault();
        togglePlay();
        break;
      case 'k':
        nextClip();
        break;
      case 'j':
        prevClip();
        break;
      case '1': case '2': case '3': case '4': case '5': case '6': {
        const idx = parseInt(e.key) - 1;
        const axis = axes[idx];
        if (axis) axisFilter = axisFilter === axis ? null : axis;
        break;
      }
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
  <div class="flex items-center justify-between">
    <div class="flex items-center gap-3">
      <a href="/" class="text-ash hover:text-ink"><Icon name="chevron-right" size={16} /></a>
      <span class="font-display text-base font-medium">{stream?.title ?? 'Loading...'}</span>
    </div>
    <span class="font-mono text-xs text-ash">
      {clips.length} clips · {stream ? fmtTime(stream.duration ?? 0) : '--'}
    </span>
  </div>

  <div class="flex flex-1 gap-3 overflow-hidden">
    <div class="flex flex-1 flex-col gap-3">
      <!-- Video player -->
      <div class="relative flex-1 overflow-hidden rounded-lg bg-black">
        {#if stream?.vodPath}
          <video
            bind:this={videoEl}
            src={apiClient.videoUrl(streamId)}
            class="h-full w-full"
            ontimeupdate={(e: Event & { currentTarget: HTMLVideoElement }) =>
              seek(e.currentTarget.currentTime)}
            onloadedmetadata={(e: Event & { currentTarget: HTMLVideoElement }) =>
              playerStore.update((s) => ({ ...s, duration: e.currentTarget.duration }))}
            onplay={() => playerStore.update((s) => ({ ...s, isPlaying: true }))}
            onpause={() => playerStore.update((s) => ({ ...s, isPlaying: false }))}
          ><track kind="captions" /></video>
          <div class="absolute bottom-0 left-0 right-0 flex items-center gap-3 bg-gradient-to-t from-black/80 to-transparent p-3">
            <button onclick={togglePlay} class="text-white hover:text-accent" aria-label="Play/Pause">
              <Icon name={videoEl?.paused ? 'play' : 'pause'} size={24} fill />
            </button>
            <button onclick={prevClip} class="text-white hover:text-accent" aria-label="Previous clip">
              <Icon name="skip-back" size={20} />
            </button>
            <button onclick={nextClip} class="text-white hover:text-accent" aria-label="Next clip">
              <Icon name="skip-forward" size={20} />
            </button>
            <span class="font-mono text-xs text-white">
              {$playerStore.currentTime.toFixed(0)}s / {stream ? fmtTime(stream.duration ?? 0) : '--'}
            </span>
          </div>
        {:else}
          <div class="flex h-full items-center justify-center text-ash">No video available</div>
        {/if}
      </div>

      <!-- Timeline -->
      <div class="h-20 rounded-md border border-border bg-surface p-2">
        <div class="relative h-full">
          {#each clips as clip, i (clip.id)}
            <button
              class="absolute top-0 w-0.5 transition-all hover:w-1
              {i === currentClipIndex ? 'bg-accent h-full accent-glow' : 'bg-ash h-3/4'}"
              style="left: {stream?.duration ? (clip.peakTime / stream.duration) * 100 : 0}%"
              onclick={() => { currentClipIndex = i; playClip(clip); }}
              title={`${clip.axis} ${clip.score.toFixed(2)}`}
              aria-label={`Clip ${i + 1}: ${clip.axis}, score ${clip.score.toFixed(2)}`}
            ></button>
          {/each}
          {#if stream?.duration}
            <div
              class="absolute top-0 h-full w-px bg-accent"
              style="left: {($playerStore.currentTime / (stream.duration || 1)) * 100}%"
            ></div>
          {/if}
        </div>
      </div>

      <!-- Clip detail -->
      {#if currentClip}
        <div class="rounded-md border border-border bg-surface p-4" use:keyLight>
          <div class="mb-2 flex items-center justify-between">
            <span class="font-display text-sm font-medium text-accent uppercase">{currentClip.axis}</span>
            <span class="font-mono text-sm text-ink">{currentClip.score.toFixed(2)}</span>
          </div>
          {#if currentClip.justification}
            <p class="mb-3 text-sm text-ash leading-relaxed">{currentClip.justification}</p>
          {/if}
          <div class="flex items-center gap-4 font-mono text-xs text-ash-dim">
            <span>start {fmtTime(currentClip.startTime)}</span>
            <span>peak {fmtTime(currentClip.peakTime)}</span>
            <span>end {fmtTime(currentClip.endTime)}</span>
            <span class="text-ash">{(currentClip.endTime - currentClip.startTime).toFixed(0)}s</span>
          </div>
        </div>
      {/if}
    </div>

    <!-- Clip queue -->
    <div class="flex w-72 flex-col gap-1 overflow-y-auto rounded-md border border-border bg-surface p-2">
      <div class="mb-2 flex items-center justify-between px-2">
        <span class="font-display text-xs font-medium text-ash uppercase">Clips</span>
        <div class="flex gap-1">
          {#each ['hype', 'humor', 'skill', 'awkward', 'emotional', 'tension'] as axis}
            <button
              class="rounded px-1.5 py-0.5 font-mono text-xs transition-colors
              {axisFilter === axis ? 'border border-accent text-accent' : 'text-ash-dim hover:text-ash'}"
              onclick={() => (axisFilter = axisFilter === axis ? null : (axis as Axis))}
            >
              {axis[0]?.toUpperCase()}
            </button>
          {/each}
        </div>
      </div>
      {#each clips as clip, i (clip.id)}
        <button
          class="flex items-center gap-3 rounded px-2 py-2 text-left transition-colors hover:bg-surface-2
          {i === currentClipIndex ? 'border-l-2 border-accent bg-surface-2' : 'border-l-2 border-transparent'}"
          onclick={() => { currentClipIndex = i; playClip(clip); }}
        >
          <span class="w-4 font-mono text-xs text-ash-dim">{i + 1}</span>
          <span class="flex-1 font-mono text-xs text-ash uppercase">{clip.axis}</span>
          <span class="font-mono text-xs text-ink">{clip.score.toFixed(2)}</span>
        </button>
      {/each}
    </div>
  </div>
</div>
