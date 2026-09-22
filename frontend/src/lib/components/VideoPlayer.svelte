<script lang="ts">
  import { apiClient } from '$lib/api/client';
  import { downloadsQuery, viewFor } from '$lib/api/downloads';
  import { playerStore, seek } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import VolumeControl from '$lib/components/VolumeControl.svelte';
  import SpeedControl from '$lib/components/SpeedControl.svelte';
  import type { Clip } from '$shared/types';
  import { onDestroy } from 'svelte';
  import { browser } from '$app/environment';
  import { shouldReloadMedia, shouldSwitchSource } from './player-reload';
  
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
    lastProgressTime = performance.now();
    // Update store — externalSeek stays false so the seek effect skips
    // (the video is already at this position, no need to seek back).
    playerStore.update((s) => ({ ...s, currentTime: v.currentTime }));

    if (autoAdvanceClip && v.currentTime >= autoAdvanceClip.endTime) {
      autoAdvanceClip = null;
      v.pause();
      onClipEnd();
    }
  }
  // ── Seek bridge: apply store.currentTime to the video element. ──
  // ontimeupdate writes the video's position to the store. When the
  // store changes from elsewhere (ChatView scroll, keyboard, Timeline),
  // the video's actual position won't match — that's a real seek.
  // The tolerance only guards against ontimeupdate's own sub-frame echo:
  // frameStep (1/30s) MUST pass, so the tolerance is one frame, not 0.5s.
  // During playback the deltas from timeupdate are ~0.1-0.25s, which is why
  // seeking is applied only while paused or when the delta exceeds it.
  $effect(() => {
    if (!videoEl) return;
    const storeTime = $playerStore.currentTime;
    const delta = Math.abs(videoEl.currentTime - storeTime);
    if (delta > 1 / 30 && (videoEl.paused || delta > 0.5)) {
      videoEl.currentTime = storeTime;
      currentTime = storeTime;
      autoAdvanceClip = null;
    }
  });

  // ── Growing-media playback ──
  // A downloading VOD is served as one growing fragmented MP4 read through
  // plain <video src> + Range requests (no hls.js, no MSE). Chromium plays
  // it happily while it grows, but it STOPS at the download frontier and
  // never resumes on its own: the response it received had a matching
  // Content-Length, so it believes the resource is complete (readyState
  // stays 4). Readiness is therefore a lying signal — the download's own
  // frontier is what drives a reload. Verified in
  // references/growing-media-formats.md.
  const STALL_MS = 1500;
  /** Growth (bytes) required before a reload is worth doing. */
  const REFRESH_MIN_GROWTH = 128 * 1024;
  let reloadCount = $state(0);
  let lastProgressTime = 0;
  let frontierBytes = 0;
  let frontierAtLastReload = 0;
  let reloadInFlight = false;
  /**
   * True when the download view says the artifact is COMPLETE (fully servable).
   *
   * A separate flag rather than a sentinel frontier: see shouldReloadMedia for the measurement, but
   * in short a complete file must never be reloaded, and a "huge bytes" sentinel cannot express that
   * inside a predicate that detects growth.
   */
  let mediaComplete = $state(false);

  /**
   * Media URL — always a LOCAL file served by the media route, never the VOD URL.
   *
   * The player plays what is on disk (the proxy during review, the video once the proxy
   * is gone). There is no remote fallback: streaming the source would make a
   * local-first clipper depend on the network and would bypass the proxy the project
   * downloaded for exactly this purpose. When nothing local exists, `srcUnavailable`
   * renders an explicit state instead.
   *
   * The reload counter busts Chromium's cache so a re-range picks up newly written bytes.
   */
  const videoSrc = $derived.by(() => {
    if (!srcUnavailable) return `${apiClient.videoUrl(streamId)}${reloadCount > 0 ? `?_r=${reloadCount}` : ''}`;
    return undefined;
  });

  // Frontier from the SHARED downloads query (one poller for the whole app).
  const downloads = downloadsQuery();
  const dlView = $derived(viewFor(downloads.data?.views, streamId));

  /**
   * Nothing local to play yet (a fresh project, or every artifact deleted).
   *
   * The state is derived from the same one view the rest of the app reads, so it clears
   * itself the moment the first bytes land — a download starting IS the transition out
   * of it, which is what makes the player follow the download live.
   */
  const srcUnavailable = $derived(
    downloads.isSuccess ? !dlView?.media.playablePath : false,
  );

  /**
   * Change the file being played when the VIEW says a different one should be.
   *
   * The view is the decider (it prefers the proxy for review and the video for render, and it
   * knows what is actually on disk), so this only follows it. Every path change is handled the
   * same way, which is what makes the reported cases behave:
   *
   *   - the proxy is deleted and the video takes over;
   *   - the video finishes downloading while review was playing the proxy;
   *   - a first download lands on a project that had nothing;
   *   - a re-download replaces a file entirely.
   *
   * The flush is the other half and is not optional: after a switch the element still holds the
   * previous file's duration, buffered ranges and position, and the stall detector's high-water
   * mark belonged to a file that may no longer exist. Carrying any of that over is what made a
   * replaced video "take an extremely long time to display" — the comparison ran against the
   * dead file's numbers.
   */
  let loadedPath = $state<string | null>(null);
  $effect(() => {
    const wanted = dlView?.media.playablePath ?? null;
    if (!shouldSwitchSource({ wantedPath: wanted, loadedPath })) return;
    loadedPath = wanted;
    // Flush everything tied to the old source.
    frontierBytes = 0;
    frontierAtLastReload = 0;
    reloadCount = 0;
    lastProgressTime = performance.now();
    currentTime = videoEl?.currentTime ?? 0;
    videoDuration = 0;
    // A fresh element load: the browser re-reads the new file and re-fires loadedmetadata,
    // which restores the volume/mute settings and the store's duration.
    try {
      videoEl?.load();
    } catch {
      // A rejected load is not fatal; the src change alone reloads in most engines.
    }
  });
  $effect(() => {
    const v = dlView;
    if (!v) return;
    if (!v.active) {
      // Complete: the file is fully servable, so there is nothing to reload. This is a FLAG, not
      // `frontierBytes = MAX_SAFE_INTEGER` — that sentinel satisfied the growth comparison and made
      // the stall detector reload a complete file, resetting the element and producing the reported
      // snap-to-zero on a finished project.
      mediaComplete = true;
      frontierBytes = 0;
      return;
    }
    mediaComplete = false;
    // The file review PLAYS is the proxy when it exists (the view picked it, so ask the
    // view), otherwise the video. Reading the video's bytes here once made a
    // still-growing proxy look complete, so the stall detector never fired.
    const playable = v.media.playableIsGrowing ? (v.artifacts.find((a) => a.kind === 'proxy') ?? v.artifacts.find((a) => a.kind === 'video')) : null;
    frontierBytes = playable?.bytes ?? Number.MAX_SAFE_INTEGER;
  });

  /**
   * Reload the media at the current position to pick up newly written bytes.
   *
   * ── THE SNAP-TO-ZERO THIS PREVENTS ────────────────────────────────────────────────────────
   * The resume was applied ONLY from the `loadedmetadata` handler, and `videoEl.load()` — which is
   * what a `src` change triggers — fires an `emptied` event that sets `currentTime` to 0 first.
   * Between `load()` and `loadedmetadata` the element therefore reports 0, and anything that writes
   * that 0 into the shared store (the seek effect reads the store, and `ontimeupdate` writes it)
   * makes the player jump to the start. That is the reported "pressing play returns to 00:00 and
   * pauses": a reload is attempted, the element resets, and nothing resumes it.
   *
   * Two changes make the resume reliable rather than a race:
   *
   *   1. `autoplay` re-requests playback as part of the load itself, so the element resumes WITHOUT
   *      waiting for a script callback to run `play()` — the rejected-play path cannot strand it.
   *   2. The position is applied from BOTH `loadedmetadata` and `loadeddata`, and a `durationchange`
   *      guard covers an element whose duration only becomes known slightly later. Re-applying is
   *      idempotent; missing the one event that matters is not.
   *
   * The store is deliberately NOT written here: while the reload is in flight the element's reported
   * time is meaningless, and echoing it back is what pulled the UI to zero.
   */
  function reloadMedia() {
    if (!videoEl || reloadInFlight) return;
    reloadInFlight = true;
    const resumeAt = videoEl.currentTime;
    const wasPlaying = !videoEl.paused;
    reloadCount++;
    const applyResume = () => {
      const v = videoEl;
      if (!v) return;
      try {
        // Only correct a position that is genuinely wrong, so a second event cannot undo a seek the
        // user made in the meantime.
        if (Math.abs(v.currentTime - resumeAt) > 0.5) v.currentTime = resumeAt;
      } catch {
        // seek rejected on a not-yet-seekable stream; the next event retries
      }
    };
    const finish = () => {
      videoEl?.removeEventListener('loadedmetadata', onMeta);
      videoEl?.removeEventListener('loadeddata', onMeta);
      reloadInFlight = false;
      lastProgressTime = performance.now();
    };
    const onMeta = () => {
      applyResume();
      if (wasPlaying && videoEl?.paused) void videoEl.play().catch(() => {});
      // Do not clear the guard on the FIRST event: loadeddata usually follows and is the more
      // reliable moment to seek a fragmented MP4.
      if (videoEl && videoEl.readyState >= 2) finish();
    };
    videoEl.addEventListener('loadedmetadata', onMeta);
    videoEl.addEventListener('loadeddata', onMeta);
    // If neither fires (an empty or rejected load), stop blocking the detector.
    setTimeout(finish, 4000);
  }

  // Stall detector: a growing file that stops advancing needs a reload.
  $effect(() => {
    if (!videoEl) return;
    const id = setInterval(() => {
      const v = videoEl;
      if (!v) return;
      if (v.paused || reloadInFlight) return;
      // A frontier BELOW the mark is not growth: it means the media was replaced (the video
      // was deleted and downloaded again) and the mark belonged to the file that is gone.
      // Without this the player kept comparing against the DELETED file's high-water mark,
      // so `frontier <= mark + growth` stayed true forever and the new video took an
      // extremely long time to appear (owner-reported).
      const replaced = frontierBytes < frontierAtLastReload;
      if (!shouldReloadMedia({
        frontierBytes,
        frontierAtLastReload,
        sinceProgressMs: performance.now() - lastProgressTime,
        paused: v.paused,
        inFlight: reloadInFlight,
        stallMs: STALL_MS,
        minGrowth: REFRESH_MIN_GROWTH,
        complete: mediaComplete,
      })) return;
      frontierAtLastReload = frontierBytes;
      if (replaced) reloadCount = 0; // a fresh source: start the cache-buster over
      reloadMedia();
    }, 500);
    return () => clearInterval(id);
  });

  function seekTo(time: number) {
    if (!videoEl) return;
    seek(time);
  }

  function seekRelative(delta: number) {
    if (!videoEl) return;
    seek(Math.max(0, Math.min(videoDuration, videoEl.currentTime + delta)));
  }

  function frameStep(delta: number) {
    if (!videoEl) return;
    seek(Math.max(0, Math.min(videoDuration, videoEl.currentTime + delta)));
  }

  /**
   * Toggle play/pause.
   *
   * The rejection is SURFACED, not swallowed. `void videoEl.play()` hides the two real failure modes
   * (a not-allowed autoplay policy, and `NotSupportedError` when no source is usable), and the owner's
   * symptom — the control appearing to do nothing — is precisely what a discarded rejection looks
   * like. A user who pressed play needs to know why nothing happened.
   */
  let playError = $state<string | null>(null);
  function togglePlay() {
    if (!videoEl) return;
    if (videoEl.paused) {
      playError = null;
      videoEl.play().catch((err: unknown) => {
        playError = err instanceof Error ? err.message : String(err);
      });
    } else {
      videoEl.pause();
    }
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
    seek(clip.startTime);
    void videoEl.play();
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
  {#if srcUnavailable}
    <!-- Explicit, not a silent fallback to the remote VOD: the player plays local media
         or says why it cannot. This is the state a project is in before its first
         download (and after deleting everything). -->
    <div class="flex h-full w-full flex-col items-center justify-center gap-2 text-center">
      <Icon name="download" size={22} class="text-ash-dim" />
      <p class="font-mono text-xs text-ash">nothing downloaded yet</p>
      <p class="max-w-72 font-mono text-[10px] text-ash-dim">
        The player runs from local media only. Start a download and playback begins as soon
        as the first chunks land.
      </p>
    </div>
  {/if}
  <video
    bind:this={videoEl}
    src={videoSrc}
    class="h-full w-full {srcUnavailable ? 'hidden' : ''}"
    ontimeupdate={handleTimeUpdate}
    onloadedmetadata={(e: Event & { currentTarget: HTMLVideoElement }) => {
      videoDuration = e.currentTarget.duration;
      // Restore persisted volume/mute, overriding browser defaults.
      e.currentTarget.volume = currentVolume;
      e.currentTarget.muted = isMuted;
      playerStore.update((s) => ({ ...s, duration: e.currentTarget.duration }));
    }}
    onplay={() => { isPlaying = true; playError = null; playerStore.update((s) => ({ ...s, isPlaying: true })); }}
    onpause={() => { isPlaying = false; playerStore.update((s) => ({ ...s, isPlaying: false })); }}
    onended={() => {
      // Playback reached the end. Without this there was NO handler at all, so "played to the end"
      // was indistinguishable from "stopped" in the UI and in the store.
      isPlaying = false;
      playerStore.update((s) => ({ ...s, isPlaying: false }));
    }}
    onerror={() => {
      const e = videoEl?.error;
      playError = e ? `${e.code}: ${e.message || 'media error'}` : 'media error';
    }}
    onvolumechange={() => { if (videoEl) { isMuted = videoEl.muted; currentVolume = videoEl.volume; } }}
  ><track kind="captions" /></video>

  {#if playError}
    <!-- Surfaced rather than swallowed: a play() rejection used to be invisible, which is how a
         control that does nothing looked like a control that worked. -->
    <div class="absolute left-3 top-3 z-10 rounded bg-black/70 px-2 py-1 font-mono text-[10px] text-error" role="alert">
      playback failed: {playError}
    </div>
  {/if}


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
