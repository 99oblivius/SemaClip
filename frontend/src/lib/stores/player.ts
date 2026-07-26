import { writable } from 'svelte/store';

export interface PlayerState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  currentClipId: string | null;
  zoomLevel: number;        // 1 = full VOD, higher = zoomed in
  viewStart: number;       // seconds, left edge of visible window
  viewEnd: number;         // seconds, right edge of visible window
  muted: boolean;
  volume: number;          // 0-1
  playbackRate: number;    // 0.25-2
  isFullscreen: boolean;
  isScrubbing: boolean;
}

export const playerStore = writable<PlayerState>({
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  currentClipId: null,
  zoomLevel: 1,
  viewStart: 0,
  viewEnd: 0,
  muted: false,
  volume: 1,
  playbackRate: 1,
  isFullscreen: false,
  isScrubbing: false,
});

export function seek(time: number) {
  playerStore.update((s) => ({ ...s, currentTime: time }));
}

export function setPlaying(playing: boolean) {
  playerStore.update((s) => ({ ...s, isPlaying: playing }));
}

export function selectClip(clipId: string | null) {
  playerStore.update((s) => ({ ...s, currentClipId: clipId }));
}

export function setZoom(level: number, duration: number, centerTime: number) {
  const clamped = Math.max(1, Math.min(200, level));
  const windowSec = duration / clamped;
  let start = centerTime - windowSec / 2;
  if (start < 0) start = 0;
  let end = start + windowSec;
  if (end > duration) {
    end = duration;
    start = Math.max(0, end - windowSec);
  }
  playerStore.update((s) => ({ ...s, zoomLevel: clamped, viewStart: start, viewEnd: end }));
}

export function pan(deltaSec: number, duration: number) {
  playerStore.update((s) => {
    const windowSec = s.viewEnd - s.viewStart;
    let start = s.viewStart + deltaSec;
    if (start < 0) start = 0;
    let end = start + windowSec;
    if (end > duration) {
      end = duration;
      start = Math.max(0, end - windowSec);
    }
    return { ...s, viewStart: start, viewEnd: end };
  });
}
