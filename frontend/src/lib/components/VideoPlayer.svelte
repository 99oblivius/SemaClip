<script lang="ts">
  import { apiClient } from '$lib/api/client';
  import { playerStore, setZoom, pan } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import type { Clip } from '$shared/types';
  import { onMount, onDestroy } from 'svelte';

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
  let wasPlaying = false;

  const player = $playerStore;

  // Auto-advance: pause at clip end if we started from clip start.
  function handleTimeUpdate(e: Event) {
    const v = e.currentTarget as HTMLVideoElement;
    onTimeUpdate(v.currentTime);
    if (currentClip && v.currentTime >= currentClip.endTime) {
      v.pause();
      onClipEnd();
    }
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) void videoEl.play();
    else videoEl.pause();
  }

  function seekTo(time: number) {
    if (videoEl) videoEl.currentTime = time;
  }

  function seekRelative(delta: number) {
    if (videoEl) videoEl.currentTime = Math.max(0, videoEl.currentTime + delta);
  }

  function frameStep(delta: number) {
    // Assume 30fps. Shift = 1s.
    const step = delta;
    if (videoEl) videoEl.currentTime = Math.max(0, videoEl.currentTime + step);
  }

  function toggleMute() {
    if (!videoEl) return;
    videoEl.muted = !videoEl.muted;
    playerStore.update((s) => ({ ...s, muted: videoEl!.muted }));
  }

  function toggleFullscreen() {
    if (!containerEl) return;
    if (!document.fullscreenElement) {
      void containerEl.requestFullscreen?.();
      playerStore.update((s) => ({ ...s, isFullscreen: true }));
    } else {
      void document.exitFullscreen?.();
      playerStore.update((s) => ({ ...s, isFullscreen: false }));
    }
  }

  function setRate(rate: number) {
    if (videoEl) videoEl.playbackRate = rate;
    playerStore.update((s) => ({ ...s, playbackRate: rate }));
  }

  function fmtTime(sec: number): string {
    if (!isFinite(sec)) return '--:--';
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }

  // Expose methods to parent for keyboard shortcuts.
  export function playClip(clip: Clip) {
    if (!videoEl) return;
    videoEl.currentTime = clip.startTime;
    void videoEl.play();
  }

  export function jumpToClipPeak(clip: Clip) {
    if (!videoEl) return;
    videoEl.currentTime = clip.peakTime;
  }

  export function getVideoEl(): HTMLVideoElement | undefined {
    return videoEl;
  }

  export function togglePlayExported() {
    togglePlay();
  }

  export function seekRelativeExported(delta: number) {
    seekRelative(delta);
  }

  export function frameStepExported(delta: number) {
    frameStep(delta);
  }

  export function toggleMuteExported() {
    toggleMute();
  }

  export function toggleFullscreenExported() {
    toggleFullscreen();
  }

  export function setRateExported(rate: number) {
    setRate(rate);
  }

  onDestroy(() => {
    if (document.fullscreenElement) void document.exitFullscreen?.();
  });
</script>

<div bind:this={containerEl} class="relative flex-1 overflow-hidden rounded-lg bg-black">
  <video
    bind:this={videoEl}
    src={apiClient.videoUrl(streamId)}
    class="h-full w-full"
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={(e: Event & { currentTarget: HTMLVideoElement }) =>
      playerStore.update((s) => ({ ...s, duration: e.currentTarget.duration }))}
    onplay={() => playerStore.update((s) => ({ ...s, isPlaying: true }))}
    onpause={() => playerStore.update((s) => ({ ...s, isPlaying: false }))}
  ><track kind="captions" /></video>

  <!-- Custom controls overlay -->
  <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/90 via-black/50 to-transparent px-4 pb-3 pt-8">
    <!-- Progress bar (clickable scrub) -->
    <button
      type="button"
      class="group relative mb-2 block h-1 w-full cursor-pointer rounded-full bg-white/20"
      onclick={(e) => {
        if (!videoEl || !e.currentTarget) return;
        const rect = e.currentTarget.getBoundingClientRect();
        const pct = (e.clientX - rect.left) / rect.width;
        videoEl.currentTime = pct * (videoEl.duration || 0);
      }}
      aria-label="Video progress"
    >
      <div
        class="absolute inset-y-0 left-0 rounded-full bg-accent transition-[width]"
        style="width: {player.duration ? (player.currentTime / player.duration) * 100 : 0}%"
      ></div>
    </button>

    <div class="flex items-center gap-3">
      <!-- Play/pause -->
      <button onclick={togglePlay} class="text-white transition-colors hover:text-accent" aria-label={player.isPlaying ? 'Pause' : 'Play'}>
        <Icon name={player.isPlaying ? 'pause' : 'play'} size={22} fill />
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
        {fmtTime(player.currentTime)} <span class="text-white/40">/</span> {fmtTime(player.duration)}
      </span>

      <div class="flex-1"></div>

      <!-- Playback rate -->
      <div class="flex items-center gap-1">
        {#each [0.5, 1, 1.5, 2] as r}
          <button
            class="rounded px-1.5 font-mono text-xs transition-colors
            {player.playbackRate === r ? 'text-accent' : 'text-white/50 hover:text-white'}"
            onclick={() => setRate(r)}
            aria-label="{r}× speed"
          >
            {r}×
          </button>
        {/each}
      </div>

      <!-- Volume -->
      <button onclick={toggleMute} class="text-white/70 transition-colors hover:text-white" aria-label={player.muted ? 'Unmute' : 'Mute'}>
        <Icon name={player.muted ? 'volume-mute' : 'volume'} size={18} />
      </button>

      <!-- Fullscreen -->
      <button onclick={toggleFullscreen} class="text-white/70 transition-colors hover:text-white" aria-label="Fullscreen">
        <Icon name={player.isFullscreen ? 'compress' : 'expand'} size={18} />
      </button>
    </div>
  </div>

  {#if !streamId}
    <div class="flex h-full items-center justify-center text-ash">No video available</div>
  {/if}
</div>
