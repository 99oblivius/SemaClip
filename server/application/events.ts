/**
 * App-wide notifications the UI must hear the INSTANT they happen.
 *
 * WHY THIS EXISTS. A staged update is the one event where "the UI notices within a poll"
 * is not good enough: the user should be told the moment the runtime finishes staging, so
 * they can choose to restart into it, rather than discovering it later in Settings. Every
 * other surface in this app is a query with a poll cadence; this is a push, because the
 * event has no state the client can observe any other way (the update lives on disk next
 * to the runtime dylib, not in our database).
 *
 * Deliberately tiny: a set of listeners, a monotonic id, and SSE framing. The one
 * subscriber is `GET /api/events`; the one publisher is the update check.
 */

export interface AppEvent {
  /** Monotonic, so a client can tell a replayed frame from a new one. */
  id: number;
  type: "update-staged" | "update-rollback" | "update-progress";
  /** Human-facing version, or the rollback reason. */
  version: string;
  /**
   * True when restarting this app actually applies it.
   *
   * Optional so a progress frame does not have to assert something about applying — it is not a
   * statement about the update being ready, and making it required pushed callers into writing a
   * misleading value to satisfy the type.
   */
  canApplyByRestart?: boolean;
  /**
   * Download progress. Present only on `update-progress`.
   *
   * `fraction` is null when the server did not declare a length, and the UI must not invent one.
   */
  received?: number;
  total?: number;
  fraction?: number | null;
}

type Listener = (e: AppEvent) => void;

const listeners = new Set<Listener>();
const recent: AppEvent[] = [];
let nextId = 1;

/**
 * The last few events, replayed to a NEW subscriber.
 *
 * Without this a client that connects after the staging missed the event entirely — the
 * app can stage an update before the webview has finished loading, which is a real race
 * on a cold start (the update check runs during server boot).
 */
const REPLAY_LIMIT = 8;

export function emitAppEvent(e: Omit<AppEvent, "id">): AppEvent {
  const event: AppEvent = { ...e, id: nextId++ };
  recent.push(event);
  if (recent.length > REPLAY_LIMIT) recent.shift();
  for (const fn of listeners) {
    try {
      fn(event);
    } catch {
      // One broken subscriber must not stop the others, and must not surface as a
      // server error from a background update check.
    }
  }
  return event;
}

/** Subscribe; returns the unsubscribe. Replays what a late subscriber missed. */
export function subscribeAppEvents(fn: Listener): () => void {
  for (const e of recent) {
    try {
      fn(e);
    } catch {
      // as above
    }
  }
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Test seam: forget listeners and history. */
export function resetAppEvents(): void {
  listeners.clear();
  recent.length = 0;
  nextId = 1;
}

/** Server-sent-event framing for one event. */
export function sseFrame(e: AppEvent): string {
  return `id: ${e.id}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`;
}
