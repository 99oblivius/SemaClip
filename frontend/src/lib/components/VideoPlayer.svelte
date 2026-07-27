<script lang="ts">
  import { apiClient } from '$lib/api/client';
  import { playerStore, seek } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import VolumeControl from '$lib/components/VolumeControl.svelte';
  import SpeedControl from '$lib/components/SpeedControl.svelte';
  import type { Clip } from '$shared/types';
  import { onDestroy } from 'svelte';
  import { browser } from '$app/environment';

  interface Props {
    streamId: string;
    duration: number | null;
    clips: Clip[];
    currentClip: Clip | undefined;

    onClipEnd: () => void;
  }

  let {
    streamId,
    duration,
    clips,
    currentClip,

    onClipEnd,
  }: Props = $props();

  let videoEl = $state<HTMLVideoElement | undefined>(undefined);
  let containerEl = $state<HTMLDivElement | undefined>(undefined);

  // Local UI state — restored from localStorage for persistence across refreshes.
  let isPlaying = $state(false);
  let isMuted = $state(browser && localStorage.getItem('semaclip-muted') === '1');
  let currentVolume = $state(browser ? Number(localStorage.getItem('semaclip-volume') ?? '1') : 1);
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
    // Update store — externalSeek stays false so the seek effect skips
    // (the video is already at this position, no need to seek back).
    playerStore.update((s) => ({ ...s, currentTime: v.currentTime }));

    if (autoAdvanceClip && v.currentTime >= autoAdvanceClip.endTime) {
      autoAdvanceClip = null;
      v.pause();
      onClipEnd();
    }
  }
  // ── Single seek path: all seeks update the store, this effect applies
  // them to the video element. ontimeupdate also updates the store, but
  // since the video is already at that position, the delta is ~0 and the
  // effect skips — no feedback loop. ──
  // A guard distinguishes "the video reported its own position" (via
  // ontimeupdate) from "an external seek changed the store" (ChatView,
  // keyboard, etc.). Only external seeks apply to the video element.
  let externalSeek = false;

  $effect(() => {
    if (!videoEl) return;
    const p = $playerStore;
    if (!externalSeek) return;
    externalSeek = false;
    videoEl.currentTime = p.currentTime;
    currentTime = p.currentTime;
    autoAdvanceClip = null;
  });

  function seekTo(time: number) {
    if (!videoEl) return;
    externalSeek = true;
    seek(time);
  }

  function seekRelative(delta: number) {
    if (!videoEl) return;
    externalSeek = true;
    seek(Math.max(0, Math.min(videoDuration, videoEl.currentTime + delta)));
  }

  function frameStep(delta: number) {
    if (!videoEl) return;
    externalSeek = true;
    seek(Math.max(0, Math.min(videoDuration, videoEl.currentTime + delta)));
  }

  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) void videoEl.play();
    else videoEl.pause();
  }
  function toggleMute() {
    if (!videoEl) return;
    if (videoEl.muted) {
      // Unmuting: restore to full volume if currently at 0.
      if (videoEl.volume === 0) {
        videoEl.volume = 1;
        currentVolume = 1;
      }
      videoEl.muted = false;
    } else {
      videoEl.muted = true;
    }
    isMuted = videoEl.muted;
  }

  function setVolume(v: number) {
    if (!videoEl) return;
    videoEl.volume = v;
    currentVolume = v;
    if (v === 0) {
      videoEl.muted = true;
      isMuted = true;
    } else if (videoEl.muted) {
      videoEl.muted = false;
      isMuted = false;
    }
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
    externalSeek = true;
    seek(clip.startTime);
    void videoEl.play();
  }

  export function jumpToClipPeak(clip: Clip) {
    if (!videoEl) return;
    autoAdvanceClip = null;
    externalSeek = true;
    seek(clip.peakTime);
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

  // Persist volume/mute to localStorage for session survival.
  $effect(() => { localStorage.setItem('semaclip-muted', isMuted ? '1' : '0'); });
  $effect(() => { localStorage.setItem('semaclip-volume', String(currentVolume)); });

  onDestroy(() => {
    if (browser && document.fullscreenElement) void document.exitFullscreen?.();
  });
</script>

<!-- No bg-black — video element handles its own aspect; container is transparent -->
<div bind:this={containerEl} class="relative flex-1 overflow-hidden rounded-lg">
  <video
    bind:this={videoEl}
    src={apiClient.videoUrl(streamId)}
    class="h-full w-full"
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={(e: Event & { currentTarget: HTMLVideoElement }) => {
      videoDuration = e.currentTarget.duration;
      // Restore persisted volume/mute, overriding browser defaults.
      e.currentTarget.volume = currentVolume;
      e.currentTarget.muted = isMuted;
      playerStore.update((s) => ({ ...s, duration: e.currentTarget.duration }));
    }}
    onplay={() => { isPlaying = true; playerStore.update((s) => ({ ...s, isPlaying: true })); }}
    onpause={() => { isPlaying = false; playerStore.update((s) => ({ ...s, isPlaying: false })); }}
    onvolumechange={() => { if (videoEl) { isMuted = videoEl.muted; currentVolume = videoEl.volume; } }}
  ><track kind="captions" /></video>


  <!-- Minimal control bar — sits at the bottom, subtle gradient only behind controls -->
  <div class="absolute bottom-0 left-0 right-0 bg-gradient-to-t from-black/70 to-transparent px-4 pb-2 pt-6">
    <div class="flex items-center gap-3">
      <!-- Play/pause -->
      <button onclick={togglePlay} class="text-white transition-colors hover:text-accent" aria-label={isPlaying ? 'Pause' : 'Play'}>
        <Icon name={isPlaying ? 'pause' : 'play'} size={22} fill />
      </button>

      <!-- Seek to start / end of video -->
      <button onclick={() => seekTo(0)} class="text-white/70 transition-colors hover:text-white" aria-label="Go to start">
        <Icon name="skip-back" size={18} />
      </button>
      <button onclick={() => seekTo(videoDuration)} class="text-white/70 transition-colors hover:text-white" aria-label="Go to end">
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

      <!-- Playback rate (hover to reveal snap-slider) -->
      <SpeedControl rate={currentRate} onRate={setRate} />

      <!-- Volume (YouTube-style hover-expand slider) -->
      <VolumeControl
        volume={currentVolume}
        muted={isMuted}
        onVolume={setVolume}
        onToggleMute={toggleMute}
      />

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
