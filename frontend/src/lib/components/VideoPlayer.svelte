<script lang="ts">
  import { apiClient } from '$lib/api/client';
  import { playerStore } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import type { Clip } from '$shared/types';
  import { onDestroy } from 'svelte';

  interface Props {
    streamId: string;
    duration: number | null;
    clips: Clip[];
    currentClip: Clip | undefined;
    onTimeUpdate: (time: number) => void;
    onClipEnd: () => void;
  }

  let {
    streamId,
    duration,
    clips,
    currentClip,
    onTimeUpdate,
    onClipEnd,
  }: Props = $props();

  let videoEl = $state<HTMLVideoElement | undefined>(undefined);
  let containerEl = $state<HTMLDivElement | undefined>(undefined);

  // Local UI state — updated directly in handlers for immediate reactivity.
  let isPlaying = $state(false);
  let isMuted = $state(false);
  let currentRate = $state(1);
  let isFullscreen = $state(false);
  let currentTime = $state(0);
  let videoDuration = $state(0);

  // Auto-advance guard: only auto-pause when playing through a clip
  // that was explicitly started via playClip(). Manual seeks clear this.
  let autoAdvanceClip = $state<Clip | null>(null);

  function handleTimeUpdate(e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    currentTime = v.currentTime;
    onTimeUpdate(v.currentTime);
    playerStore.update((s) => ({ ...s, currentTime: v.currentTime }));

    // Only auto-advance if we're explicitly playing through a clip
    // AND the user hasn't manually seeked away from it.
    if (autoAdvanceClip && v.currentTime >= autoAdvanceClip.endTime) {
      autoAdvanceClip = null;
      v.pause();
      onClipEnd();
    }
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      void videoEl.play();
    } else {
      videoEl.pause();
    }
  }

  function seekTo(time: number) {
    if (!videoEl) return;
    // Manual seek — disable auto-advance so we don't immediately pause.
    autoAdvanceClip = null;
    videoEl.currentTime = time;
    currentTime = time;
  }

  function seekRelative(delta: number) {
    if (!videoEl) return;
    autoAdvanceClip = null;
    videoEl.currentTime = Math.max(0, Math.min(videoDuration, videoEl.currentTime + delta));
  }

  function frameStep(delta: number) {
    if (!videoEl) return;
    autoAdvanceClip = null;
    videoEl.currentTime = Math.max(0, Math.min(videoDuration, videoEl.currentTime + delta));
  }

  function toggleMute() {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
    isMuted = videoEl.muted;
  }

  function toggleFullscreen() {
    if (!containerEl) return;
    if (!document.fullscreenElement) {
      void containerEl.requestFullscreen?.();
      isFullscreen = true;
    } else {
      void document.exitFullscreen?.();
      isFullscreen = false;
    }
  }

  function setRate(rate: number) {
    if (!videoEl) return;
    videoEl.playbackRate = rate;
    currentRate = rate;
  }

  function scrubTo(e: MouseEvent) {
    if (!videoEl || !e.currentTarget) return;
    autoAdvanceClip = null;
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    const t = pct * (videoEl.duration || 0);
    videoEl.currentTime = t;
    currentTime = t;
  }

  function fmtTime(sec: number): string {
    if (!isFinite(sec) || sec < 0) return '--:--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // ── Exposed methods for parent keyboard shortcuts ──

  export function playClip(clip: Clip) {
    if (!videoEl) return;
    autoAdvanceClip = clip;
    videoEl.currentTime = clip.startTime;
    currentTime = clip.startTime;
    void videoEl.play();
  }

  export function jumpToClipPeak(clip: Clip) {
    if (!videoEl) return;
    autoAdvanceClip = null;
    videoEl.currentTime = clip.peakTime;
    currentTime = clip.peakTime;
  }

  export function togglePlayExported() { togglePlay(); }
  export function seekRelativeExported(delta: number) { seekRelative(delta); }
  export function frameStepExported(delta: number) { frameStep(delta); }
  export function toggleMuteExported() { toggleMute(); }
  export function toggleFullscreenExported() { toggleFullscreen(); }
  export function setRateExported(rate: number) { setRate(rate); }
  export function seekToExported(time: number) { seekTo(time); }

  function onFullscreenChange() {
    isFullscreen = !!document.fullscreenElement;
  }

  onDestroy(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
  });
</script>

<svelte:window onfullscreenchange={onFullscreenChange} />

<div bind:this={containerEl} class="relative flex-1 overflow-hidden rounded-lg bg-black">
  <video
    bind:this={videoEl}
    src={apiClient.videoUrl(streamId)}
    class="h-full w-full"
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={(e: Event & { currentTarget: HTMLVideoElement }) => {
      videoDuration = e.currentTarget.duration;
      playerStore.update((s) => ({ ...s, duration: e.currentTarget.duration }));
    }}
    onplay={() => { isPlaying = true; playerStore.update((s) => ({ ...s, isPlaying: true })); }}
    onpause={() => { isPlaying = false; playerStore.update((s) => ({ ...s, isPlaying: false })); }}
    onvolumechange={() => { if (videoEl) { isMuted = videoEl.muted; } }}
  ><track kind="captions" /></video>

  <!-- Custom controls overlay -->
  <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pb-3 pt-8">
    <!-- Progress bar (clickable scrub) -->
    <button
      type="button"
      class="group relative mb-2 block h-1.5 w-full cursor-pointer rounded-full bg-white/20 transition-[height] hover:h-2"
      onclick={scrubTo}
      aria-label="Video progress"
    >
      <div
        class="absolute inset-y-0 left-0 rounded-full bg-accent"
        style="width: {videoDuration ? (currentTime / videoDuration) * 100 : 0}%"
      ></div>
    </button>

    <div class="flex items-center gap-3">
      <!-- Play/pause -->
      <button onclick={togglePlay} class="text-white transition-colors hover:text-accent" aria-label={isPlaying ? 'Pause' : 'Play'}>
        <Icon name={isPlaying ? 'pause' : 'play'} size={22} fill />
      </button>

      <!-- Skip prev/next clip -->
      <button onclick={() => {
        const idx = clips.findIndex((c) => c.id === currentClip?.id);
        if (idx > 0) playClip(clips[idx - 1]);
      }} class="text-white/70 transition-colors hover:text-white" aria-label="Previous clip">
        <Icon name="skip-back" size={18} />
      </button>
      <button onclick={() => {
        const idx = clips.findIndex((c) => c.id === currentClip?.id);
        if (idx >= 0 && idx < clips.length - 1) playClip(clips[idx + 1]);
      }} class="text-white/70 transition-colors hover:text-white" aria-label="Next clip">
        <Icon name="skip-forward" size={18} />
      </button>

      <!-- Seek ±5s -->
      <button onclick={() => seekRelative(-5)} class="text-white/70 transition-colors hover:text-white" aria-label="Back 5 seconds">
        <Icon name="rewind" size={16} />
      </button>
      <button onclick={() => seekRelative(5)} class="text-white/70 transition-colors hover:text-white" aria-label="Forward 5 seconds">
        <Icon name="fast-forward" size={16} />
      </button>

      <!-- Time display -->
      <span class="font-mono text-xs text-white/80">
        {fmtTime(currentTime)} <span class="text-white/40">/</span> {fmtTime(videoDuration)}
      </span>

      <div class="flex-1"></div>

      <!-- Playback rate -->
      <div class="flex items-center gap-1">
        {#each [0.5, 1, 1.5, 2] as r}
          <button
            class="rounded px-1.5 font-mono text-xs transition-colors
            {currentRate === r ? 'text-accent' : 'text-white/50 hover:text-white'}"
            onclick={() => setRate(r)}
            aria-label="{r}× speed"
          >
            {r}×
          </button>
        {/each}
      </div>

      <!-- Volume -->
      <button onclick={toggleMute} class="text-white/70 transition-colors hover:text-white" aria-label={isMuted ? 'Unmute' : 'Mute'}>
        <Icon name={isMuted ? 'volume-mute' : 'volume'} size={18} />
      </button>

      <!-- Fullscreen -->
      <button onclick={toggleFullscreen} class="text-white/70 transition-colors hover:text-white" aria-label="Fullscreen">
        <Icon name={isFullscreen ? 'compress' : 'expand'} size={18} />
      </button>
    </div>
  </div>

  {#if !streamId}
    <div class="flex h-full items-center justify-center text-ash">No video available</div>
  {/if}
</div>
