import { writable } from 'svelte/store';

export interface PlayerState {
  currentTime: number;
  duration: number;
  isPlaying: boolean;
  currentClipId: string | null;
  zoomLevel: number;
  muted: boolean;
}

export const playerStore = writable<PlayerState>({
  currentTime: 0,
  duration: 0,
  isPlaying: false,
  currentClipId: null,
  zoomLevel: 1,
  muted: false,
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
