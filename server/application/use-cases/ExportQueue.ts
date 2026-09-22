/**
 * The export BATCH — a durable, resumable, cancellable FIFO over the existing single-clip exporter.
 *
 * WHY A QUEUE AT ALL
 *
 * `ExportClipUseCase` exports ONE clip and returns when its ffmpeg run finishes. The owner's
 * requirement is that exporting from the Export page takes the whole list and processes it, which
 * means several encodes in sequence, progress the user can watch, and a cancel that stops the run
 * in flight rather than only its own HTTP request.
 *
 * WHY DURABLE
 *
 * A batch is a claim about deliverables the user asked for. An interrupted batch that quietly
 * disappears, or reports itself finished having produced three files out of nine, is a lie about
 * their output — so the queue lives in `export_jobs` and a restart resumes what was pending.
 *
 * The pump is deliberately serial: one encode at a time. Two parallel ffmpeg runs on one machine
 * contend for the same GPU/CPU and the batch finishes no sooner, while progress reports become
 * ambiguous about which item is moving.
 */
import type {
  ClipRepository,
  ExportJobRepository,
  ExportJobRecord,
  ExportListRepository,
  FileSystemPort,
  StreamMetadataRepository,
  StreamRepository,
} from "@/application/ports/outbound.ts";
import type { ExportJobView, ExportProfile, ExportQueueView, ExportStatus } from "shared/types";
import { EXPORT_STATUSES, normaliseProfile } from "shared/types";
import type { ExportClipUseCase } from "./ExportClip.ts";
import type { EventBus } from "@/application/ports/outbound.ts";
import { EXPORT_CHANGED_TOPIC, EXPORT_PROGRESS_TOPIC } from "@/application/ports/outbound.ts";

/**
 * One item's live progress, kept in memory between samples so a view is cheap to compose.
 */
interface Live {
  clipId: string;
  phase: ExportJobView["phase"];
  percent: number;
  /** Seconds of media the encode had reached, for the rate estimate. */
  encodedSec: number;
  /** Clip length in seconds — the denominator for percent and the basis of the rate. */
  durationSec: number | null;
  startedAtMs: number;
  /**
   * Recent (time, encodedSec) samples, oldest first — the basis of the ETA.
   *
   * A WINDOW, not the whole run: the cumulative mean `elapsed / encoded` averages in the opening of
   * the encode, where ffmpeg is still probing, allocating and filling lookahead. Those first seconds
   * are genuinely slow and never repeat, so a cumulative mean keeps quoting them for the whole file
   * and the ETA walks down as the real rate asserts itself. Measuring the rate over a recent window
   * is the rate the encode is ACTUALLY running at.
   */
  samples: { atMs: number; encodedSec: number }[];
}

/** How much recent history a rate estimate uses. */
const RATE_WINDOW_MS = 10_000;
/**
 * The shortest window worth measuring over.
 *
 * Below this the estimate is two adjacent samples apart and noisy enough to jump around; at the
 * start of a run there is nothing to window yet, so no rate is claimed at all.
 */
const RATE_MIN_SPAN_MS = 2_500;

/**
 * How many wall-clock seconds this encode spends per second of media, measured over a recent window.
 *
 * Exported for test: the rule is arithmetic and a test drives it with a synthetic sample list rather
 * than a real encode, which is the only way to assert the WINDOWING rather than just its output.
 *
 * The function OWNS the windowing — it selects the samples itself rather than trusting the caller to
 * have trimmed. A previous shape measured across the whole list it was handed, which made its answer
 * depend on a trim performed somewhere else: the caller's list and the function agreed only as long as
 * both kept the same rule, and a second caller with an untrimmed list would silently get a CUMULATIVE
 * mean out of a function named for a window. The producer still trims, but that is now only memory
 * hygiene (a bounded array), not the correctness of this number.
 *
 * Returns null when there is no honest answer yet — fewer than two samples, or a window too short to
 * measure across. `null` is what makes the UI print nothing rather than a fabricated estimate.
 */
export function rateOverWindow(
  live: { samples: { atMs: number; encodedSec: number }[] } | undefined,
): number | null {
  // A CRASH guard, not the rate rule: it exists because `last` indexes into the array below. It is
  // deliberately NOT `length < 2` — a single sample is already rejected by the span guard (one sample
  // always spans zero milliseconds), so a count of two here would be a second owner of a rule the span
  // guard already enforces, and the two could drift apart without any test noticing.
  if (!live || live.samples.length === 0) return null;
  const last = live.samples[live.samples.length - 1]!;
  // The MOST RECENT sample is the reference point, not a wall clock: it is the newest measurement
  // there is, and it keeps this function pure and deterministic for a test.
  const cutoff = last.atMs - RATE_WINDOW_MS;
  // The window's OLDEST sample: the earliest one still inside the cutoff. Walking from the front is
  // correct because samples are appended in time order.
  let first = last;
  for (const s of live.samples) {
    if (s.atMs >= cutoff) {
      first = s;
      break;
    }
  }
  const spanMs = last.atMs - first.atMs;
  const mediaSec = last.encodedSec - first.encodedSec;
  // A too-short span is noise; a zero/negative media delta means the encode is not advancing (a
  // stalled or just-started run) and dividing by it would report an infinite rate.
  if (spanMs < RATE_MIN_SPAN_MS || mediaSec <= 0) return null;
  return spanMs / 1000 / mediaSec;
}

export class ExportQueue {
  /** In-flight progress, keyed by clip id. Cleared when the item ends. */
  private live = new Map<string, Live>();
  /** The abort handle for the running encode. Absent when nothing is running. */
  private abort: AbortController | null = null;
  /** Guards against a second pump starting while one is deciding. */
  private pumping = false;

  constructor(
    private readonly jobs: ExportJobRepository,
    private readonly list: ExportListRepository,
    private readonly clips: ClipRepository,
    private readonly streams: StreamRepository,
    private readonly metadata: StreamMetadataRepository,
    private readonly fs: FileSystemPort,
    private readonly exportClip: ExportClipUseCase,
    private readonly bus: EventBus,
  ) {}

  /**
   * Enqueue every clip currently on the export list.
   *
   * Takes the SNAPSHOT of the list at this moment rather than reading it lazily as it drains: the
   * user asked for "these", and a clip removed from the list while the batch runs must still be
   * exported, because the request was made when it was on the list.
   */
  async enqueueAll(input: {
    profile: ExportProfile;
    outputDir: string | null;
    filename: string | null;
    /** Override the list — used by single-clip "Export" so one clip need not be on the list. */
    clipIds?: string[];
  }): Promise<{ enqueued: number }> {
    const clipIds = input.clipIds ?? (await this.list.liveIds());
    if (clipIds.length === 0) return { enqueued: 0 };

    const existing = await this.jobs.list();
    let position = existing.reduce((m, r) => Math.max(m, r.position), 0);
    // ONE stamp for the whole enqueue — this is what makes the batch's rows identifiable as one
    // batch. Taken here rather than per row (see `upsertQueued`): per-row stamps make a batch's own
    // earlier-settled item indistinguishable from a previous batch's.
    const requestedAt = new Date().toISOString();
    for (const clipId of clipIds) {
      position += 1;
      await this.jobs.upsertQueued({
        clipId,
        profileJson: JSON.stringify(input.profile),
        outputDir: input.outputDir,
        filename: input.filename,
        position,
        requestedAt,
      });
    }
    this.publish({ type: "export_queue", reason: "enqueued" });
    void this.pump();
    return { enqueued: clipIds.length };
  }

  /**
   * Run the next queued item, and keep going.
   *
   * Serial by construction: the loop re-enters itself only after the current encode finishes, and
   * `pumping` makes a concurrent call a no-op, so two encodes can never run at once.
   */
  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const todo = await this.nextRunnable();
        if (!todo) break;

        const startedAt = new Date().toISOString();
        await this.jobs.markRunning(todo.clipId, startedAt);
        const clip = await this.clips.findById(todo.clipId);
        const durationSec = clip ? Math.max(0, clip.endTime - clip.startTime) : null;
        this.live.set(todo.clipId, {
          clipId: todo.clipId,
          phase: "probing",
          percent: 0,
          encodedSec: 0,
          durationSec,
          startedAtMs: Date.now(),
          samples: [],
        });
        this.publish({ type: "export_queue", reason: "started" });

        const controller = new AbortController();
        this.abort = controller;
        try {
          const profile = normaliseProfile(JSON.parse(todo.profileJson) as Partial<ExportProfile>);
          const result = await this.exportClip.execute({
            clipId: todo.clipId,
            profile,
            outputPath: todo.outputDir,
            filename: todo.filename,
            // The batch shows a phase of "probing" until the first sample arrives, so the user can
            // tell "starting up" from "not moving".
            onProgress: ({ encodedSec }) => {
              const l = this.live.get(todo.clipId);
              if (!l) return;
              l.encodedSec = encodedSec;
              l.phase = "encoding";
              l.percent = l.durationSec && l.durationSec > 0
                ? Math.min(1, encodedSec / l.durationSec)
                : 0;
              // Record the sample the rate is measured over, and drop anything older than the window
              // so the list cannot grow for the length of a long encode.
              const nowMs = Date.now();
              l.samples.push({ atMs: nowMs, encodedSec });
              const cutoff = nowMs - RATE_WINDOW_MS;
              while (l.samples.length > 1 && (l.samples[0]?.atMs ?? nowMs) < cutoff) l.samples.shift();
              this.publish({
                type: "export_progress",
                clipId: todo.clipId,
                status: "running",
                percent: l.percent,
                phase: "encoding",
              });
            },
            signal: controller.signal,
          });
          await this.jobs.markCompleted(todo.clipId, result.exportPath, new Date().toISOString());
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          if (controller.signal.aborted) {
            // A cancel is a decision, not a failure: reporting it as one would put a red error on an
            // item the user themselves stopped.
            await this.jobs.markCancelled(todo.clipId, new Date().toISOString());
          } else {
            // ONE item failing must not stop the batch. The remaining items are still wanted, and a
            // batch that aborts on the first bad clip turns one problem into nine.
            await this.jobs.markFailed(todo.clipId, message, new Date().toISOString());
          }
        } finally {
          this.live.delete(todo.clipId);
          this.abort = null;
        }
        this.publish({ type: "export_queue", reason: "item_done" });
      }
    } finally {
      this.pumping = false;
      this.publish({ type: "export_queue", reason: "finished" });
    }
  }

  /**
   * The next item to run, skipping any whose clip has vanished.
   *
   * A missing clip is marked failed rather than retried forever: `nextQueued` would keep returning
   * it and the pump would spin.
   */
  private async nextRunnable(): Promise<ExportJobRecord | null> {
    for (;;) {
      const todo = await this.jobs.nextQueued();
      if (!todo) return null;
      const clip = await this.clips.findById(todo.clipId);
      if (clip) return todo;
      await this.jobs.markFailed(todo.clipId, "Clip no longer exists", new Date().toISOString());
    }
  }

  /**
   * Delete a cancelled item's partial file, if it recorded one.
   *
   * ONE owner for cancel-time cleanup. Every path that decides an export is not going to finish
   * calls this, rather than each remembering to: the artifact is the thing that must not survive a
   * cancel ("delete any artifacts of the clip that was mid processing"), and a cleanup that lives in
   * two places is one that will be missing from one of them.
   *
   * Returns true when it actually removed something, so the caller's count is real.
   */
  private async deleteArtifact(row: ExportJobRecord): Promise<boolean> {
    if (!row.artifactPath) return false;
    // A COMPLETED row's `artifact_path` is its FINISHED export, not a partial file — the column
    // carries the live output path while a job runs and the delivered file once it lands. Deleting
    // it would destroy a file the user asked for and was told was ready, so a completed row is
    // refused here rather than trusted to be filtered out by every caller.
    if (row.status === "completed" || row.status === "failed") return false;
    try {
      if (!(await this.fs.exists(row.artifactPath))) return false;
      await this.fs.remove(row.artifactPath);
      // The path is CLEARED after deleting, so a second cancel does not re-report the same file and
      // the row does not point at something that no longer exists.
      await this.jobs.clearArtifactPath(row.clipId);
      return true;
    } catch {
      // A partial file we could not delete is not worth failing the cancel over: the row is gone or
      // cancelled, so it will never be presented as a deliverable.
      return false;
    }
  }

  /**
   * Cancel the incomplete items and delete the partial artifacts they left.
   *
   * The owner's rule, verbatim: "cancel all incomplete clips, and delete any artifacts of the clip
   * that was mid processing (if anything can get leftover). Completed clips are untouched."
   *
   * Killing the encode FIRST is what makes the deletion safe — deleting a file ffmpeg is still
   * writing either fails or is recreated a moment later, and the download path taught exactly that
   * lesson (a cancelled run kept writing chunks).
   *
   * The subtlety this got wrong at first: aborting makes the PUMP mark the running item `cancelled`
   * during the wait, and `dropIncomplete` only removes non-terminal rows — so the one item that
   * certainly had a partial file was the one item whose file was never cleaned. Both populations are
   * swept here: the rows this call drops, and the rows the pump terminalised while stopping.
   */
  async cancelIncomplete(): Promise<{ cancelled: number; deletedArtifacts: number }> {
    this.abort?.abort();
    // Wait for the running item to actually stop before removing its file. Bounded, because a
    // stubborn process must not hold the whole cancel hostage.
    await this.waitForIdle(5000);

    // Read BEFORE dropping: the drop is what removes the rows, and the pump's own cancellations are
    // only visible as terminal rows carrying an artifact.
    const before = await this.jobs.list();
    const dropped = await this.jobs.dropIncomplete();
    const terminalised = before.filter((r) => r.status === "cancelled" && r.artifactPath);

    let deleted = 0;
    for (const row of [...dropped, ...terminalised]) {
      if (await this.deleteArtifact(row)) deleted += 1;
    }
    this.publish({ type: "export_queue", reason: "cancelled" });
    return { cancelled: dropped.length + terminalised.length, deletedArtifacts: deleted };
  }

  /** Cancel ONE item, leaving the rest of the batch alone. */
  async cancelItem(clipId: string): Promise<boolean> {
    const row = await this.jobs.get(clipId);
    if (!row || (row.status !== "queued" && row.status !== "running")) return false;
    // The artifact path is read from a FRESH row AFTER the abort: during the run, progress samples
    // update it, so a path read before the encode started can be absent or stale.
    let artifact = row;
    if (row.status === "running") {
      this.abort?.abort();
      await this.waitForIdle(5000);
      // The pump marks the row cancelled and clears its live entry; re-read for the recorded path.
      artifact = (await this.jobs.get(clipId)) ?? row;
    }
    await this.jobs.markCancelled(clipId, new Date().toISOString());
    await this.deleteArtifact(artifact);
    this.live.delete(clipId);
    this.publish({ type: "export_queue", reason: "cancelled" });
    void this.pump();
    return true;
  }

  /** Wait until nothing is running, bounded by `timeoutMs`. */
  private async waitForIdle(timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (this.pumping && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** The batch as the UI reads it: per-item state plus the totals a bar and its stats need. */
  async view(): Promise<ExportQueueView> {
    const records = await this.jobs.list();
    // ── WHICH ITEMS BELONG TO THE CURRENT BATCH ──
    //
    // Completed rows are KEPT (the export list still shows which clips produced a file), but the
    // batch's own progress must not inherit them: with `completed` rows counted, a fresh export of
    // one clip opened at 3/4 = 75% before it had done anything, which is the reported "new exports
    // add to the progress percentage of the last export".
    //
    // The boundary is TIME, derived from the rows themselves rather than from a stored batch counter
    // (a counter is a second owner of the same truth, needing its own reset path and its own
    // migration). Every row of one batch is enqueued together, so:
    //
    //   - NOTHING pending  → the batch is FINISHED, so the current batch is EMPTY and the bar reads
    //     0/0. That is what closes the panel and lets the next export start from zero.
    //   - SOMETHING pending → the current batch began at the EARLIEST pending row's `requestedAt`,
    //     and every row stamped at or after that belongs to it. This keeps a batch's own already-
    //     completed items in the fraction (so the bar advances during a multi-clip run) while
    //     excluding everything from previous batches.
    //
    // An earlier version anchored on the NEWEST SETTLED stamp with `>=`, which included the settled
    // rows themselves — so a finished batch still counted as current (3/3, the bug this fixes) and a
    // new export still absorbed the old completions. The tests in `export-batch-scope.test.ts` pin
    // both cases.
    const pendingStamps = records
      .filter((r) => r.status === "queued" || r.status === "running")
      .map((r) => r.requestedAt)
      .sort();
    const batchStart = pendingStamps[0] ?? null;
    const isCurrentBatch = (r: (typeof records)[number]) =>
      batchStart !== null && r.requestedAt >= batchStart;

    const counts: Record<ExportStatus, number> = {
      queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0,
    };
    const items: ExportJobView[] = [];
    /** The CURRENT batch's own items — the only ones the bar and its statistics describe. */
    const currentItems: ExportJobView[] = [];
    let pendingPosition = 0;
    for (const r of records) {
      if (!EXPORT_STATUSES.includes(r.status as ExportStatus)) continue;
      const status = r.status as ExportStatus;
      const current = isCurrentBatch(r);
      if (current) counts[status] += 1;
      if (status === "queued") pendingPosition += 1;

      const clip = await this.clips.findById(r.clipId);
      const live = this.live.get(r.clipId);
      const durationSec = clip ? Math.max(0, clip.endTime - clip.startTime) : null;
      const elapsedSec = live ? (Date.now() - live.startedAtMs) / 1000 : null;

      const item: ExportJobView = {
        clipId: r.clipId,
        streamId: clip?.streamId ?? null,
        // The clip's own name, else its axis, else the KIND — the same precedence the rest of the
        // app uses, so an unnamed item is never blank.
        label: clip?.title ?? clip?.axis ?? "clip",
        status,
        position: status === "queued" ? pendingPosition : 0,
        phase: live?.phase ?? (r.phase as ExportJobView["phase"] | null) ?? null,
        percent: live?.percent ?? r.percent,
        startedAt: r.startedAt,
        completedAt: r.completedAt,
        artifactPath: r.artifactPath,
        exportPath: status === "completed" ? r.artifactPath : null,
        error: r.error,
        durationSec,
        // Measured from THIS run, so an ETA on a second item is not estimated from the first item's
        // speed on a different clip. Measured over a RECENT WINDOW (see `Live.samples`) so the slow
        // opening of the encode stops being quoted once the real rate has established itself.
        secondsPerMediaSecond: rateOverWindow(live),
      };
      items.push(item);
      if (current) currentItems.push(item);
    }

    // The bar describes the CURRENT batch only. `items` still carries every row, so the export list
    // keeps its per-clip state; a finished batch therefore reports 0/0, which is what closes the
    // panel and lets the next export start from zero instead of continuing the previous bar.
    const total = currentItems.length;
    const done = counts.completed + counts.failed + counts.cancelled;
    const runningFraction = currentItems.find((i) => i.status === "running")?.percent ?? 0;
    const percent = total === 0 ? 0 : Math.min(1, (done + runningFraction) / total);

    const firstStarted = currentItems
      .map((i) => i.startedAt)
      .filter((s): s is string => Boolean(s))
      .sort()[0] ?? null;

    // ETA only from measured evidence. With no rate yet there is nothing honest to say, and a
    // fabricated "about 2 minutes" on a batch of unknown clips is worse than no estimate.
    const rate = currentItems.find((i) => i.status === "running")?.secondsPerMediaSecond ?? null;
    const remainingMedia = currentItems
      .filter((i) => i.status === "queued")
      .reduce((sum, i) => sum + (i.durationSec ?? 0), 0);
    const runningItem = currentItems.find((i) => i.status === "running") ?? null;
    const runningRemaining = runningItem?.durationSec !== null && runningItem?.durationSec !== undefined
      ? Math.max(0, runningItem.durationSec * (1 - runningItem.percent))
      : 0;
    const etaSec = rate !== null && remainingMedia > 0
      ? (remainingMedia + runningRemaining) * rate
      : null;

    return {
      items,
      counts: { ...counts, total },
      percent,
      startedAt: firstStarted,
      etaSec,
      running: runningItem?.clipId ?? null,
    };
  }

  /**
   * Resume after a restart.
   *
   * Every `running` row is a lie once the process is gone: the ffmpeg child died with it and no file
   * is being written. They are returned to `queued` so the batch continues, rather than being left
   * to report progress that will never advance.
   */
  async resume(): Promise<{ requeued: number }> {
    const records = await this.jobs.list();
    const stranded = records.filter((r) => r.status === "running");
    for (const r of stranded) {
      // Re-queued, not failed: the user's request still stands and the work is still doable. A
      // partial file from the interrupted run is deleted so the retry does not inherit half an
      // encode.
      if (r.artifactPath) {
        try {
          if (await this.fs.exists(r.artifactPath)) await this.fs.remove(r.artifactPath);
        } catch {
          // Ignore: the retry overwrites it anyway.
        }
      }
      await this.jobs.upsertQueued({
        clipId: r.clipId,
        profileJson: r.profileJson,
        outputDir: r.outputDir,
        filename: r.filename,
        position: r.position,
        // Its ORIGINAL stamp, not a fresh one: a resumed item is still part of the batch it was
        // enqueued in, and re-stamping it would make it look like a new batch and detach it from the
        // batch's own progress.
        requestedAt: r.requestedAt,
      });
    }
    if (stranded.length > 0) {
      this.publish({ type: "export_queue", reason: "enqueued" });
    }
    // Pump whenever there is ANY queued work, not only when a stranded row was found. A process
    // killed BETWEEN two items leaves rows that are still `queued` and none `running`, so gating
    // the pump on `stranded` left a durable batch sitting there for ever — the exact thing
    // durability is supposed to prevent.
    const pending = await this.jobs.list();
    if (pending.some((r) => r.status === "queued")) {
      void this.pump();
    }
    return { requeued: stranded.length };
  }

  private publish(event: { type: string; [k: string]: unknown }): void {
    const topic = event.type === "export_progress" ? EXPORT_PROGRESS_TOPIC : EXPORT_CHANGED_TOPIC;
    this.bus.publish(topic, event as never);
  }
}
