/**
 * The full-VOD download queue.
 *
 * ── WHY ───────────────────────────────────────────────────────────────────────────────────
 * Two imports used to run at once. The owner's own data shows the cost: two VODs imported
 * five seconds apart, both left with an EMPTY `vod_path` — every download splitting the link
 * until neither finished. Serialising them keeps the bandwidth on one transfer, and means a
 * network drop or a closed laptop interrupts one download instead of all of them.
 *
 * ── WHAT IT SERIALISES ───────────────────────────────────────────────────────────────────
 * FULL VOD downloads only: an import, or a resume. Manual per-artifact downloads (a single
 * proxy, video or chat re-fetched from project settings) stay immediate — the owner's call,
 * and the right one: they are small, deliberate, and usually repair something. The FIFO is
 * for the multi-GB transfers that compete with each other.
 *
 * ── SHAPE ────────────────────────────────────────────────────────────────────────────────
 * Insertion-ordered, one run in flight. `enqueue` returns immediately and starts the run when
 * the queue reaches it, which is what lets the caller answer the HTTP request at once and let
 * the UI show the project as queued.
 *
 * The queue owns exactly one piece of truth — the order and what is running. It does NOT own
 * download state: the orchestrator does, and the UI reads it there. `snapshot()` is how the
 * view learns a project's position in that one queue.
 */

export interface QueueEntry {
  streamId: string;
  /** Human label for the UI ("the project title", or the stream id prefix). */
  label: string;
  /** The work. Must resolve when the download reaches a terminal state, not when it starts. */
  run: () => Promise<void>;
}

export interface QueueSnapshot {
  /** The streamId currently running, or null. */
  running: string | null;
  /** Queued streamIds, in the order they will run. */
  waiting: string[];
}

export class DownloadQueue {
  /** Waiting entries, in order. Not yet started. */
  private waiting: QueueEntry[] = [];
  private running: QueueEntry | null = null;
  /** Set when a run is being started, so a re-entrant enqueue cannot double-start. */
  private pumping = false;

  /** The queue's own view, for composing "queued" into the download view model. */
  snapshot(): QueueSnapshot {
    return {
      running: this.running?.streamId ?? null,
      waiting: this.waiting.map((e) => e.streamId),
    };
  }

  /** 1-based position for display, or 0 when this stream is not waiting. */
  positionOf(streamId: string): number {
    const index = this.waiting.findIndex((e) => e.streamId === streamId);
    return index === -1 ? 0 : index + 1;
  }

  isWaiting(streamId: string): boolean {
    return this.positionOf(streamId) > 0;
  }

  isRunning(streamId: string): boolean {
    return this.running?.streamId === streamId;
  }

  /** Total entries in the queue, running included. */
  get size(): number {
    return this.waiting.length + (this.running ? 1 : 0);
  }

  /**
   * Add a download and return its position (1-based; 1 means it started immediately).
   *
   * A stream already queued is NOT added twice — a double-press on Download must not produce
   * two runs of the same VOD, which would have them fight over one destination folder. The
   * existing entry's position is returned instead.
   */
  enqueue(entry: QueueEntry): number {
    if (this.running?.streamId === entry.streamId) return 1;
    const existing = this.positionOf(entry.streamId);
    if (existing > 0) return existing + (this.running ? 1 : 0);
    this.waiting.push(entry);
    const position = this.waiting.length + (this.running ? 1 : 0);
    void this.pump();
    return position;
  }

  /**
   * Start the next entry if nothing is running.
   *
   * The `finally` is load-bearing: a run that throws, or is aborted, must still release the
   * queue. A run left un-released would stall every later download for the life of the
   * process — a queue that silently stops working is worse than no queue.
   */
  private async pump(): Promise<void> {
    if (this.pumping || this.running) return;
    const next = this.waiting.shift();
    if (!next) return;
    this.pumping = true;
    this.running = next;
    try {
      await next.run();
    } catch (err) {
      // The caller's run() reports its own failures into the download state; the queue's job
      // is only to not become the reason the next download never starts.
      console.error(`[queue] run for ${next.streamId} ended with an error:`, err);
    } finally {
      this.running = null;
      this.pumping = false;
      void this.pump();
    }
  }

  /**
   * Cancel a download: a waiting entry is dropped; a running one is aborted by the caller.
   *
   * Returns whether anything was removed from the QUEUE. Aborting the in-flight download is
   * the caller's business (it owns the AbortController) — this only guarantees the entry does
   * not sit in the queue afterwards, which is what a cancel has to mean.
   */
  cancel(streamId: string): boolean {
    const before = this.waiting.length;
    this.waiting = this.waiting.filter((e) => e.streamId !== streamId);
    return this.waiting.length !== before;
  }

  /** Drop everything queued. Used when a project is deleted. */
  clear(): void {
    this.waiting = [];
  }
}
