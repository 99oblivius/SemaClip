/**
 * Undo/redo over a set of editable form fields.
 *
 * ── WHY THIS IS A PURE MODULE ────────────────────────────────────────────────────────────────
 * The project-settings panel binds six values straight to inputs (`bind:value`), so an edit lands
 * in the component's state with no record that it happened. That makes undo impossible to add
 * later by inspecting state — the information is gone — and it is why the panel had none while
 * every other surface in the app has keyboard shortcuts.
 *
 * So the snapshots are kept here, in a shape that can be unit-tested without a browser: the
 * component only has to say "these values are now current" and hand over Ctrl+Z.
 *
 * The two behaviours this exists for:
 *   - **Undo/redo** over the fields the user edited.
 *   - **Revert on close.** Leaving the panel without saving discards the pending edits, which is
 *     the same rule the UI-scale preview already follows: an unsaved change must not outlive the
 *     surface that made it. `baseline()` is what the component reverts TO.
 */

/** The editable fields, as one comparable unit. */
export interface FieldSnapshot {
  title: string;
  streamer: string;
  game: string;
  streamLink: string;
  vodPath: string;
  chatPath: string;
}

/** The field names, so a snapshot can be built without listing them twice. */
export const FIELD_KEYS = [
  "title",
  "streamer",
  "game",
  "streamLink",
  "vodPath",
  "chatPath",
] as const satisfies readonly (keyof FieldSnapshot)[];

/** Deep equality for a snapshot: these are flat strings, so compare each field. */
export function sameSnapshot(a: FieldSnapshot, b: FieldSnapshot): boolean {
  for (const key of FIELD_KEYS) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

export interface FieldHistory {
  /** States before the present, oldest first. */
  past: FieldSnapshot[];
  present: FieldSnapshot;
  /** States undone away, newest first (the next redo). */
  future: FieldSnapshot[];
  /**
   * The last SERVER-confirmed values.
   *
   * Separate from `past`, because undo history and the save baseline answer different questions:
   * undo walks what the user typed, and reverting must return to what the server actually holds,
   * however many undo steps that took.
   */
  baseline: FieldSnapshot;
  /** How many snapshots to keep, so a long editing session cannot grow without bound. */
  limit: number;
}

export const HISTORY_LIMIT = 100;

export function createHistory(initial: FieldSnapshot): FieldHistory {
  return { past: [], present: initial, future: [], baseline: initial, limit: HISTORY_LIMIT };
}

/**
 * Record a new current state.
 *
 * A no-op change is IGNORED rather than pushed: `bind:value` fires on every keystroke, and each
 * character becoming its own undo step would make Ctrl+Z useless for anything but single letters.
 * Callers commit at the points a human would call a change — on blur, or on a debounce — and the
 * equality check here is what makes those points safe to fire more often than needed.
 */
export function commit(history: FieldHistory, next: FieldSnapshot): FieldHistory {
  if (sameSnapshot(history.present, next)) return history;
  const past = [...history.past, history.present];
  // Bound the history from the OLD end: the recent steps are the ones worth keeping.
  const trimmed = past.length > history.limit ? past.slice(past.length - history.limit) : past;
  return { ...history, past: trimmed, present: next, future: [] };
}

export function canUndo(history: FieldHistory): boolean {
  return history.past.length > 0;
}

export function canRedo(history: FieldHistory): boolean {
  return history.future.length > 0;
}

export function undo(history: FieldHistory): FieldHistory {
  if (!canUndo(history)) return history;
  const previous = history.past[history.past.length - 1]!;
  return {
    ...history,
    past: history.past.slice(0, -1),
    present: previous,
    future: [history.present, ...history.future],
  };
}

export function redo(history: FieldHistory): FieldHistory {
  if (!canRedo(history)) return history;
  const next = history.future[0]!;
  return {
    ...history,
    past: [...history.past, history.present],
    present: next,
    future: history.future.slice(1),
  };
}

/**
 * Accept the current values as what the server now holds.
 *
 * Called after a successful save. The undo history is kept — the user may still want to step back
 * through what they typed — but the revert-on-close target moves forward, so closing the panel
 * after a save does not throw the saved values away.
 */
export function rebase(history: FieldHistory, next: FieldSnapshot): FieldHistory {
  return { ...history, baseline: next, present: next };
}

/** What closing the panel without saving must restore. */
export function revertTarget(history: FieldHistory): FieldSnapshot {
  return history.baseline;
}

/**
 * Adopt server values that arrived from elsewhere.
 *
 * Refuses while the user has unsaved edits (`dirty`), because clobbering a pending choice is the
 * bug the UI-scale store had to solve the same way: the downloads poller fires this path on a
 * timer, so a blind adoption would overwrite what someone is in the middle of typing.
 */
export function adoptServerValues(
  history: FieldHistory,
  server: FieldSnapshot,
  dirty: boolean,
): FieldHistory {
  if (dirty) return history;
  if (sameSnapshot(history.present, server) && sameSnapshot(history.baseline, server)) {
    return history;
  }
  // The server's value becomes both the present and the baseline; the old history is dropped
  // because it describes values that no longer relate to anything.
  return { past: [], present: server, future: [], baseline: server, limit: history.limit };
}
