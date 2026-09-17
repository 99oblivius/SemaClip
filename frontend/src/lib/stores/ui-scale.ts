import { writable } from 'svelte/store';
import { UI_SCALE_FACTOR, type UiScale } from '$shared/types';

/**
 * The single owner of the applied interface scale.
 *
 * Two things must both be true and they pull in opposite directions: selecting a
 * scale rescales the window immediately (the change is visual and the user is
 * looking at it), and the same selection must still count as UNSAVED until the
 * page's Save writes it. Writing the value straight into the query cache satisfied
 * the first and broke the second — the settings page computes `dirty` against that
 * cache, so an optimistic cache write made the page believe the server already had
 * the value and Save stayed disabled.
 *
 * The value also has two possible sources, and they must not overwrite each other:
 *
 *   - the PERSISTED setting, re-read whenever the settings query updates (and that
 *     cache fires on every query's activity, including the download poller's, so
 *     this happens constantly);
 *   - an explicit user choice, which is pending until Save succeeds.
 *
 * Seeding blindly from the cache clobbers a pending choice: select Large, then any
 * unrelated cache event re-reads the persisted Medium and the UI snaps back mid-
 * interaction. So each write declares its source, and a pending user choice wins
 * until it is confirmed saved.
 */
type Source = 'persisted' | 'user';

export const uiScale = writable<UiScale>('medium');
let source: Source = 'persisted';

/** Apply a value that came from the server. Ignored while a user choice is pending. */
export function seedUiScale(scale: UiScale): void {
  if (source === 'user') return;
  uiScale.set(scale);
}

/** Apply an explicit user selection; it stays on screen until saved. */
export function selectUiScale(scale: UiScale): void {
  source = 'user';
  uiScale.set(scale);
}

/** The pending choice is now the persisted one, so server values may win again. */
export function confirmUiScaleSaved(): void {
  source = 'persisted';
}

/** Apply a scale to the document. The layout is the only caller. */
export function applyUiScale(scale: UiScale): void {
  document.documentElement.style.fontSize = `${14 * UI_SCALE_FACTOR[scale]}px`;
}
