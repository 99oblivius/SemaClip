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

/** Set the visible timeline window directly. */
export function setView(start: number, end: number): void {
  playerStore.update((s) => ({ ...s, viewStart: start, viewEnd: end, zoomLevel: s.duration / Math.max(1, end - start) }));
}

/** Frame the timeline view around a clip with 10% padding on each side.
 *  Padding never shrinks below 2.5s per side (5s minimum total window)
 *  so very short clips remain navigable. */
export function frameClip(clipStart: number, clipEnd: number, duration: number): void {
  const clipLen = clipEnd - clipStart;
  // 10% padding, but at least 2.5s per side so short clips get a usable view.
  const pad = Math.max(clipLen * 0.1, 2.5);
  let start = Math.max(0, clipStart - pad);
  let end = Math.min(duration, clipEnd + pad);
  // If padding clipped at 0 or duration, redistribute the saved pad to the other side.
  const leftover = (pad - (clipStart - start)) + (pad - (end - clipEnd));
  if (leftover > 0) {
    if (start === 0) end = Math.min(duration, end + leftover);
    else if (end === duration) start = Math.max(0, start - leftover);
  }
  playerStore.update((s) => ({ ...s, viewStart: start, viewEnd: end, zoomLevel: duration / Math.max(1, end - start) }));
}
/** Zoom anchored at a specific time (the cursor position). After zooming,
 *  the same time stays at the same screen position — the cursor doesn't move. */
export function setZoom(level: number, duration: number, anchorTime: number) {
  const clamped = Math.max(1, Math.min(200, level));
  const windowSec = duration / clamped;
  playerStore.update((s) => {
    const curStart = s.viewStart || 0;
    const curEnd = s.viewEnd || duration;
    const curSpan = curEnd - curStart;
    // Fraction of the current view to the left of the anchor — preserve it.
    const leftFrac = curSpan > 0 ? (anchorTime - curStart) / curSpan : 0.5;
    let start = anchorTime - leftFrac * windowSec;
    if (start < 0) start = 0;
    let end = start + windowSec;
    if (end > duration) {
      end = duration;
      start = Math.max(0, end - windowSec);
    }
    return { ...s, zoomLevel: clamped, viewStart: start, viewEnd: end };
  });
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
