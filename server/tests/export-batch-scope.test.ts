/**
 * The batch bar must describe the CURRENT batch, not every row that ever finished.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * Reported: "reset the queue size so that new exports won't add to the progress percentage of the
 * last export". Completed rows are deliberately KEPT — the export list still shows which clips
 * produced a file — so a naive count made a fresh single-clip export open at 3/4 = 75% before it had
 * done anything. These tests pin the boundary between "history that is displayed" and "the batch
 * being measured", which are now different things read from the same rows.
 */
import { assertEquals } from "@std/assert";
import { ExportQueue } from "../application/use-cases/ExportQueue.ts";

type Row = {
  clipId: string; status: string; position: number; requestedAt: string;
  percent: number; startedAt: string | null; completedAt: string | null;
  artifactPath: string | null; error: string | null; phase: string | null;
  profileJson: string; outputDir: string | null; filename: string | null;
};

/** A queue whose only real collaborator is the job list — the rest is inert. */
function queueWith(rows: Row[]): ExportQueue {
  const jobs = {
    list: () => Promise.resolve(rows),
    get: () => Promise.resolve(null),
    nextQueued: () => Promise.resolve(null),
    upsertQueued: () => Promise.resolve(),
    markRunning: () => Promise.resolve(),
    markCompleted: () => Promise.resolve(),
    setProgress: () => Promise.resolve(),
    dropIncomplete: () => Promise.resolve([]),
  };
  const clips = {
    findById: (id: string) => Promise.resolve({
      id, streamId: "s1", title: `clip-${id}`, axis: null, startTime: 0, endTime: 10, peakTime: 5,
    }),
  };
  const streams = { findById: () => Promise.resolve(null) };
  const list = { liveIds: () => Promise.resolve([]), add: () => Promise.resolve(), remove: () => Promise.resolve(), clear: () => Promise.resolve() };
  const metadata = { get: () => Promise.resolve(null) };
  const fs = { exists: () => Promise.resolve(false), ensureDir: () => Promise.resolve(), remove: () => Promise.resolve(), listFiles: () => Promise.resolve([]), joinPath: (...p: string[]) => p.join("/"), nativePath: (p: string) => p };
  const exporter = { execute: () => Promise.reject(new Error("not used")) };
  const bus = { publish: () => {}, subscribe: () => () => {} };
  return new ExportQueue(
    jobs as never, list as never, clips as never, streams as never, metadata as never,
    fs as never, exporter as never, bus as never,
  );
}

const row = (over: Partial<Row> & { clipId: string; status: string; requestedAt: string }): Row => ({
  position: 0, percent: 1, startedAt: null, completedAt: null, artifactPath: null, error: null,
  phase: null, profileJson: "{}", outputDir: null, filename: null, ...over,
});

Deno.test("a FINISHED batch reports 0/0, so the panel closes and the bar resets", async () => {
  // Three completed rows from a batch that is over. This is the state the page must read as "nothing
  // to show" — before the fix it reported 3/3 = 100%, so the bar stayed pinned and the next export
  // continued from it.
  const q = queueWith([
    row({ clipId: "a", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
    row({ clipId: "b", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
    row({ clipId: "c", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
  ]);
  const view = await q.view();
  assertEquals(view.counts.total, 0, "a finished batch has no current items");
  assertEquals(view.percent, 0, "the bar must not stay at the previous batch's 100%");
  // The rows are still REPORTED, because the export list draws `exported` from them.
  assertEquals(view.items.length, 3, "history is still carried for the list rows");
});

Deno.test("a NEW export starts from zero even with completed history present", async () => {
  // The exact reported symptom: history exists, one new clip is queued, and the bar must describe
  // only the new work.
  const q = queueWith([
    row({ clipId: "old1", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
    row({ clipId: "old2", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
    row({ clipId: "new1", status: "queued", requestedAt: "2026-01-02T00:00:00Z" }),
  ]);
  const view = await q.view();
  assertEquals(view.counts.total, 1, "only the new item belongs to the current batch");
  assertEquals(view.counts.completed, 0, "the old completions are not part of this batch");
  assertEquals(view.percent, 0, "one queued of one is 0% done, not 2/3");
});

Deno.test("the batch FRACTION advances within the current batch", async () => {
  const q = queueWith([
    row({ clipId: "old", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
    row({ clipId: "n1", status: "completed", requestedAt: "2026-01-02T00:00:00Z" }),
    row({ clipId: "n2", status: "running", requestedAt: "2026-01-02T00:00:00Z", percent: 0.5 }),
    row({ clipId: "n3", status: "queued", requestedAt: "2026-01-02T00:00:00Z" }),
  ]);
  const view = await q.view();
  assertEquals(view.counts.total, 3, "the three current items");
  // (1 done + 0.5 running) / 3 = 0.5 — the running item's own fraction is included, so the bar
  // advances during a long encode rather than jumping only when a file completes.
  assertEquals(view.percent, 0.5);
});

Deno.test("the ETA is measured from the CURRENT batch's rate, not the history's", async () => {
  // A rate carried over from a finished batch would quote the wrong speed for this one.
  const q = queueWith([
    row({ clipId: "old", status: "completed", requestedAt: "2026-01-01T00:00:00Z" }),
    row({ clipId: "n1", status: "queued", requestedAt: "2026-01-02T00:00:00Z" }),
  ]);
  const view = await q.view();
  // Nothing is running, so there is no measured rate and nothing honest to say.
  assertEquals(view.etaSec, null, "an ETA with no measured rate must be absent, not invented");
});

Deno.test("an ALL-COMPLETED history with no new work leaves `running` null", async () => {
  const q = queueWith([row({ clipId: "a", status: "completed", requestedAt: "2026-01-01T00:00:00Z" })]);
  const view = await q.view();
  assertEquals(view.running, null);
  assertEquals(view.startedAt, null, "elapsed time must not tick against a finished batch");
});
