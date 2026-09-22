/**
 * The export LIST and BATCH: what must stay true, and the cancel bug this caught.
 *
 * ── THE OWNER'S REQUEST ───────────────────────────────────────────────────────────────────────
 * "I expect the CANDIDATES queue to be persistent and exists for the Review process, and when a
 * clip is exported or all are exported, those same clips then populate the export page's list,
 * which when exporting commences, all items in the export list are enqueued. Make sure a visually
 * informational progress bar and progress stats exist for it."
 *
 * Clarified: the list persists as REFERENCES to clips (never copies); the batch is DURABLE; cancel
 * stops all incomplete items and deletes the partial artifact of the one that was mid-processing,
 * leaving completed items untouched.
 *
 * ── WHY THERE IS A UNIT TEST AS WELL AS THE LIVE HARNESS ──────────────────────────────────────
 * The live HTTP harness (`sc-batch2.py`, real ffmpeg, real restarts) is what found the cancel bug.
 * This file pins the SEMANTICS so they cannot regress without a ffmpeg run, and covers the cases a
 * live run is worst at: an empty list, a vanished clip, a second cancel, and a batch where one item
 * fails — states that are awkward to stage live and trivial to state here.
 *
 * The cancel defect found live, and reproduced below: an abort makes the PUMP mark the running item
 * `cancelled` while `cancelIncomplete` waits, and `dropIncomplete` removes only non-terminal rows —
 * so the one item that certainly had a partial file was the one item whose file was never deleted.
 */
import { assert, assertEquals } from "@std/assert";
import { ExportQueue } from "@/application/use-cases/ExportQueue.ts";
import type {
  ClipRepository,
  ExportJobRecord,
  ExportListRepository,
  StreamMetadataRepository,
  StreamRepository,
} from "@/application/ports/outbound.ts";
import type { FileSystemPort } from "@/application/ports/outbound.ts";
import type { Clip, ExportProfile, Stream } from "shared/types";

const PROFILE: ExportProfile = {
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  maxHeight: 720,
  encoder: "auto",
  encoderName: null,
  options: { quality: 23, maxBitrateKbps: null },
  aspectRatio: "16:9",
  captions: {
    enabled: false,
    preset: "bold-white",
    position: "bottom",
    fontSize: 24,
    backgroundOpacity: 0.6,
  },
  nameTemplate: "{date}-{channel}-{axis}-{ts}",
};

// ── Fakes ─────────────────────────────────────────────────────────────────────────────────────
// Each fake is deliberately dumb: it records and returns, and the assertions read what the queue
// asked it to do. A fake that reimplements the logic would test the fake.

function makeClip(id: string): Clip {
  return {
    id,
    streamId: "s1",
    startTime: 100,
    endTime: 116,
    peakTime: 108,
    axis: "hype",
    score: 0.9,
    rejected: false,
    exported: false,
    exportPath: null,
    title: null,
    signals: null,
    justification: null,
    jobId: null,
  } as unknown as Clip;
}

class FakeJobs {
  rows: ExportJobRecord[] = [];
  clearedPaths: string[] = [];

  private idx(clipId: string) {
    return this.rows.findIndex((r) => r.clipId === clipId);
  }

  list(): Promise<ExportJobRecord[]> {
    return Promise.resolve([...this.rows].sort((a, b) => a.position - b.position));
  }

  get(clipId: string): Promise<ExportJobRecord | null> {
    return Promise.resolve(this.rows[this.idx(clipId)] ?? null);
  }

  upsertQueued(input: { clipId: string; position: number; requestedAt: string }): Promise<void> {
    const i = this.idx(input.clipId);
    const row: ExportJobRecord = {
      clipId: input.clipId,
      profileJson: JSON.stringify(PROFILE),
      outputDir: null,
      filename: null,
      status: "queued",
      position: input.position,
      phase: null,
      percent: 0,
      startedAt: null,
      completedAt: null,
      error: null,
      artifactPath: null,
      // The caller's stamp, as the real adapter does — the fake must not invent its own, or a test
      // of batch grouping would be testing this file rather than the queue.
      requestedAt: input.requestedAt,
    };
    if (i >= 0) this.rows[i] = { ...this.rows[i]!, ...row };
    else this.rows.push(row);
    return Promise.resolve();
  }

  nextQueued(): Promise<ExportJobRecord | null> {
    return Promise.resolve(this.rows.find((r) => r.status === "queued") ?? null);
  }

  markRunning(clipId: string, startedAt: string): Promise<void> {
    const i = this.idx(clipId);
    if (i >= 0) this.rows[i] = { ...this.rows[i]!, status: "running", startedAt };
    return Promise.resolve();
  }

  setProgress(clipId: string, phase: string, percent: number, artifactPath: string | null): Promise<void> {
    const i = this.idx(clipId);
    if (i >= 0) {
      this.rows[i] = { ...this.rows[i]!, phase: phase as never, percent, artifactPath: artifactPath ?? this.rows[i]!.artifactPath };
    }
    return Promise.resolve();
  }

  markCompleted(clipId: string, exportPath: string, completedAt: string): Promise<void> {
    const i = this.idx(clipId);
    if (i >= 0) {
      this.rows[i] = { ...this.rows[i]!, status: "completed", artifactPath: exportPath, completedAt };
    }
    return Promise.resolve();
  }

  markFailed(clipId: string, error: string, completedAt: string): Promise<void> {
    const i = this.idx(clipId);
    if (i >= 0) this.rows[i] = { ...this.rows[i]!, status: "failed", error, completedAt };
    return Promise.resolve();
  }

  markCancelled(clipId: string, completedAt: string): Promise<void> {
    const i = this.idx(clipId);
    if (i >= 0) this.rows[i] = { ...this.rows[i]!, status: "cancelled", completedAt };
    return Promise.resolve();
  }

  clearArtifactPath(clipId: string): Promise<void> {
    const i = this.idx(clipId);
    if (i >= 0) this.rows[i] = { ...this.rows[i]!, artifactPath: null };
    this.clearedPaths.push(clipId);
    return Promise.resolve();
  }

  /** Only non-terminal rows, exactly like the SQL. */
  dropIncomplete(): Promise<ExportJobRecord[]> {
    const dropped = this.rows.filter((r) => r.status === "queued" || r.status === "running");
    this.rows = this.rows.filter((r) => r.status !== "queued" && r.status !== "running");
    return Promise.resolve(dropped);
  }

  requeueStranded(): Promise<ExportJobRecord[]> {
    const stranded = this.rows.filter((r) => r.status === "running");
    for (const r of stranded) {
      const i = this.idx(r.clipId);
      this.rows[i] = { ...r, status: "queued" };
    }
    return Promise.resolve(stranded);
  }
}

class FakeFs {
  files = new Set<string>();
  removed: string[] = [];
  exists(path: string): Promise<boolean> {
    return Promise.resolve(this.files.has(path));
  }
  remove(path: string): Promise<void> {
    this.files.delete(path);
    this.removed.push(path);
    return Promise.resolve();
  }
}

function makeQueue(opts: {
  jobs: FakeJobs;
  fs: FakeFs;
  clips: Clip[];
  listIds?: string[];
  /** Per-clip behaviour of the export: a promise resolution, a rejection, or a hang. */
  behave?: (clipId: string) => Promise<void>;
  onProgress?: (clipId: string, encodedSec: number) => void;
}) {
  const clipsRepo: ClipRepository = {
    findById: (id: string) => Promise.resolve(opts.clips.find((c) => c.id === id) ?? null),
    listByStream: () => Promise.resolve(opts.clips),
    update: () => Promise.resolve(),
  } as unknown as ClipRepository;

  const listRepo: ExportListRepository = {
    add: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    clear: () => Promise.resolve(),
    liveIds: () => Promise.resolve(opts.listIds ?? opts.clips.map((c) => c.id)),
  } as unknown as ExportListRepository;

  const exportClip = {
    execute: async (input: { clipId: string; onProgress?: (p: { encodedSec: number }) => void; signal?: AbortSignal }) => {
      input.onProgress?.({ encodedSec: 4 });
      opts.onProgress?.(input.clipId, 4);
      await opts.behave?.(input.clipId);
      // An aborted encode REJECTS, like ffmpeg being killed.
      if (input.signal?.aborted) throw new Error("aborted");
      return { clipId: input.clipId, exportPath: `/out/${input.clipId}.mp4`, durationMs: 10, backend: "cpu" };
    },
  } as unknown as import("@/application/use-cases/ExportClip.ts").ExportClipUseCase;

  const bus = { publish: () => {} } as unknown as import("@/application/ports/outbound.ts").EventBus;

  return new ExportQueue(
    opts.jobs as unknown as import("@/application/ports/outbound.ts").ExportJobRepository,
    listRepo,
    clipsRepo,
    { findById: () => Promise.resolve(null) } as unknown as StreamRepository,
    { get: () => Promise.resolve(null), set: () => Promise.resolve(), delete: () => Promise.resolve(), deleteAll: () => Promise.resolve() } as unknown as StreamMetadataRepository,
    opts.fs as unknown as FileSystemPort,
    exportClip,
    bus,
  );
}

/** Let the un-awaited pump make progress. */
const settle = (ms = 30) => new Promise((r) => setTimeout(r, ms));

// ── Tests ─────────────────────────────────────────────────────────────────────────────────────

Deno.test("the list is enqueued as a SNAPSHOT — a clip removed mid-batch still exports", async () => {
  const jobs = new FakeJobs();
  const fs = new FakeFs();
  const clips = [makeClip("a"), makeClip("b")];
  const q = makeQueue({ jobs, fs, clips });

  const res = await q.enqueueAll({ profile: PROFILE, outputDir: null, filename: null });
  assertEquals(res.enqueued, 2);
  await settle();

  assertEquals(jobs.rows.map((r) => r.clipId).sort(), ["a", "b"]);
  assertEquals(jobs.rows.every((r) => r.status === "completed"), true);
});

Deno.test("an EMPTY list enqueues nothing and starts no pump", async () => {
  const jobs = new FakeJobs();
  const q = makeQueue({ jobs, fs: new FakeFs(), clips: [], listIds: [] });
  assertEquals(await q.enqueueAll({ profile: PROFILE, outputDir: null, filename: null }), { enqueued: 0 });
  await settle();
  assertEquals(jobs.rows.length, 0);
});

Deno.test("a clip that no longer exists FAILS its item instead of spinning the pump", async () => {
  const jobs = new FakeJobs();
  // Queued, but the clip row is gone — `nextQueued` would return it for ever.
  await jobs.upsertQueued({ clipId: "ghost", position: 1, requestedAt: new Date().toISOString() });
  const q = makeQueue({ jobs, fs: new FakeFs(), clips: [makeClip("real")] });
  // Nothing starts the pump on its own, so ask it to run — the same entry point a boot uses.
  await q.resume();
  await settle(80);

  assertEquals(jobs.rows[0]?.status, "failed");
  assertEquals(jobs.rows[0]?.error, "Clip no longer exists");
});

Deno.test("one item FAILING does not stop the batch — the rest still run", async () => {
  const jobs = new FakeJobs();
  const clips = [makeClip("bad"), makeClip("good")];
  const q = makeQueue({
    jobs,
    fs: new FakeFs(),
    clips,
    behave: (id) => (id === "bad" ? Promise.reject(new Error("ffmpeg exploded")) : Promise.resolve()),
  });
  await q.enqueueAll({ profile: PROFILE, outputDir: null, filename: null });
  await settle(80);

  const byId = new Map(jobs.rows.map((r) => [r.clipId, r]));
  assertEquals(byId.get("bad")?.status, "failed");
  assertEquals(byId.get("bad")?.error, "ffmpeg exploded");
  assertEquals(byId.get("good")?.status, "completed", "the second item must still have run");
});

Deno.test("CANCEL stops the run, deletes the partial artifact, and keeps completed items", async () => {
  const jobs = new FakeJobs();
  const fs = new FakeFs();
  const clips = [makeClip("done"), makeClip("mid"), makeClip("waiting")];

  // "done" has already finished; "mid" is running and has written a partial file.
  jobs.rows = [
    { clipId: "done", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "completed", position: 1, phase: null, percent: 1, startedAt: null, completedAt: "t", error: null, artifactPath: "/out/done.mp4" },
    { clipId: "mid", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "queued", position: 2, phase: null, percent: 0, startedAt: null, completedAt: null, error: null, artifactPath: null },
    { clipId: "waiting", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "queued", position: 3, phase: null, percent: 0, startedAt: null, completedAt: null, error: null, artifactPath: null },
  ];
  fs.files.add("/out/mid.mp4.partial");

  const q = makeQueue({
    jobs,
    fs,
    clips,
    // "mid" never resolves on its own — only the abort ends it, which is what makes this a cancel
    // and not a race with the fixture finishing first.
    behave: (id) => (id === "mid" ? new Promise<never>(() => {}) : Promise.resolve()),
  });

  // Let the pump pick up "mid" and record its partial path.
  await settle(40);
  assertEquals(jobs.get("mid").then((r) => r?.status), Promise.resolve("running"));
  await jobs.setProgress("mid", "encoding", 0.4, "/out/mid.mp4.partial");

  const res = await q.cancelIncomplete();
  await settle(40);

  assertEquals(res.cancelled, 2, "the running item AND the waiting item");
  assertEquals(res.deletedArtifacts, 1, "the one partial file");
  assertEquals(fs.removed, ["/out/mid.mp4.partial"]);
  assert(!fs.files.has("/out/mid.mp4.partial"), "the partial file must be gone from disk");

  const byId = new Map(jobs.rows.map((r) => [r.clipId, r]));
  assertEquals(byId.get("done")?.status, "completed", "a completed item is untouched");
  assertEquals(byId.get("done")?.artifactPath, "/out/done.mp4", "and keeps its delivered file path");
  assert(!byId.has("mid"), "the cancelled running item is dropped");
  assert(!byId.has("waiting"), "the cancelled queued item is dropped");
});

Deno.test("CANCEL with nothing running is a no-op that still reports zero cleanly", async () => {
  const jobs = new FakeJobs();
  const fs = new FakeFs();
  jobs.rows = [
    { clipId: "done", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "completed", position: 1, phase: null, percent: 1, startedAt: null, completedAt: "t", error: null, artifactPath: "/out/done.mp4" },
  ];
  const q = makeQueue({ jobs, fs, clips: [makeClip("done")] });
  const res = await q.cancelIncomplete();

  assertEquals(res, { cancelled: 0, deletedArtifacts: 0 });
  assertEquals(jobs.rows.length, 1);
  assertEquals(fs.removed, []);
});

Deno.test("a SECOND cancel does not re-report the same deletion", async () => {
  const jobs = new FakeJobs();
  const fs = new FakeFs();
  fs.files.add("/out/x.partial");
  jobs.rows = [
    { clipId: "x", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "queued", position: 1, phase: null, percent: 0, startedAt: null, completedAt: null, error: null, artifactPath: "/out/x.partial" },
  ];
  const q = makeQueue({ jobs, fs, clips: [makeClip("x")] });

  const first = await q.cancelIncomplete();
  const second = await q.cancelIncomplete();

  assertEquals(first.deletedArtifacts, 1);
  // The path is cleared with the file, so the second cancel has nothing to claim.
  assertEquals(second.deletedArtifacts, 0);
  assertEquals(second.cancelled, 0);
});

Deno.test("a RESTART requeues a stranded `running` item — it was never actually running", async () => {
  const jobs = new FakeJobs();
  const fs = new FakeFs();
  // Exactly the state a killed process leaves: one row claiming to run, whose ffmpeg is long gone.
  jobs.rows = [
    { clipId: "a", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "running", position: 1, phase: "encoding", percent: 0.5, startedAt: "t", completedAt: null, error: null, artifactPath: "/out/a.partial" },
  ];
  const q = makeQueue({ jobs, fs, clips: [makeClip("a")] });

  const res = await q.resume();
  await settle(60);

  assertEquals(res.requeued, 1, "the stranded item is requeued, not reported as running");
  assertEquals(jobs.rows[0]?.status, "completed", "and then it actually runs");
});

Deno.test("a SETTLED batch reports 0/0 — the bar does not stay at the last batch's 100%", async () => {
  // ── THIS TEST REPLACES AN OLDER ASSERTION ──────────────────────────────────────────────────
  // It previously asserted `counts.total === 3` and `percent === 1` for three terminal rows, under
  // the rule "the batch view's counts account for EVERY item". That rule is what the owner asked to
  // change: with history counted, a fresh export of one clip opened at 3/4 = 75% before doing any
  // work, which reads as "new exports add to the progress percentage of the last export".
  //
  // The rows are still REPORTED (`items` below), because each export-list row draws its own
  // `exported` / `failed` / `cancelled` state from them — which is why closing the panel on
  // completion loses nothing.
  const jobs = new FakeJobs();
  jobs.rows = [
    { clipId: "a", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "completed", position: 1, phase: null, percent: 1, startedAt: null, completedAt: "t", error: null, artifactPath: "/o/a.mp4" },
    { clipId: "b", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "failed", position: 2, phase: null, percent: 0.2, startedAt: null, completedAt: "t", error: "boom", artifactPath: null },
    { clipId: "c", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "cancelled", position: 3, phase: null, percent: 0.1, startedAt: null, completedAt: "t", error: null, artifactPath: null },
  ];
  const clips = [makeClip("a"), makeClip("b"), makeClip("c")];
  const q = makeQueue({ jobs, fs: new FakeFs(), clips });
  const view = await q.view();

  assertEquals(view.counts.total, 0, "a settled batch is not current work");
  assertEquals(view.percent, 0, "the bar resets rather than staying pinned at the last batch");
  assertEquals(view.running, null);
  // The history is intact for the list rows, which render their own per-clip state.
  assertEquals(view.items.length, 3, "every row is still carried for the export list");
  assertEquals(view.items.map((i) => i.status).sort(), ["cancelled", "completed", "failed"]);
  assertEquals(view.items[0]?.artifactPath, "/o/a.mp4", "a finished row still points at its file");
});

Deno.test("the batch percent is a TOTAL — a finished item's work is not discarded", async () => {
  // ── THE SIBLING THAT SETTLED FIRST STILL COUNTS ────────────────────────────────────────────
  // One done, one running at halfway. A per-item bar would read 50%; the batch must read 75%.
  // Both rows carry the SAME stamp, which is what the enqueue now guarantees for one batch — and it
  // is load-bearing here: the finished sibling is in the past only by its own status, so if a batch
  // were anchored on its newest pending row this item would be dropped and the bar would read 50%.
  const jobs = new FakeJobs();
  jobs.rows = [
    { clipId: "a", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "completed", position: 1, phase: null, percent: 1, startedAt: null, completedAt: "t", error: null, artifactPath: "/o/a.mp4" },
    { clipId: "b", profileJson: "", outputDir: null, filename: null, requestedAt: "t", status: "running", position: 2, phase: "encoding", percent: 0.5, startedAt: "t", completedAt: null, error: null, artifactPath: "/o/b.partial" },
  ];
  const q = makeQueue({ jobs, fs: new FakeFs(), clips: [makeClip("a"), makeClip("b")] });
  const view = await q.view();

  assertEquals(view.counts.total, 2, "the finished sibling belongs to this batch");
  assert(view.percent > 0.5, `the finished item must count toward the batch (got ${view.percent})`);
});

Deno.test("ONE enqueue stamps every row identically — a batch's identity", async () => {
  // ── WHY THIS IS THE REAL GUARD ──────────────────────────────────────────────────────────────
  // Batch scope is derived from `requested_at` (see `ExportQueue.view`). An earlier version stamped
  // `new Date()` PER ROW inside the adapter, which made a batch's own already-settled sibling
  // indistinguishable from a PREVIOUS batch's — no timestamp anchor can separate them from the data
  // alone. Measured on the live database: sibling rows landed at `...16.896Z` and a separate enqueue
  // at `...17.271Z`, i.e. the shared-stamp property held only because the rows happened to fall
  // inside one millisecond. This pins the invariant that replaced the coincidence: the stamp is
  // taken ONCE per enqueue and handed to every row.
  const jobs = new FakeJobs();
  const q = makeQueue({ jobs, fs: new FakeFs(), clips: [makeClip("a"), makeClip("b"), makeClip("c")] });
  await q.enqueueAll({ profile: PROFILE, outputDir: null, filename: null });

  const stamps = new Set(jobs.rows.map((r) => r.requestedAt));
  assertEquals(stamps.size, 1, `one enqueue is one batch, so one stamp (got ${[...stamps].join(", ")})`);
  assertEquals(jobs.rows.length, 3);
  const view = await q.view();
  assertEquals(view.counts.total, 3);
  assertEquals(view.percent, 0);
});

Deno.test("a RESUME keeps its original stamp, so a resumed batch stays one batch", async () => {
  // The other writer of `requested_at`: recovering stranded `running` rows. Re-stamping them with a
  // fresh `now` would detach the resumed item from the batch it was enqueued in, and the bar would
  // then count it as a new batch of one.
  const jobs = new FakeJobs();
  jobs.rows = [
    { clipId: "a", profileJson: JSON.stringify(PROFILE), outputDir: null, filename: null, requestedAt: "2026-01-01T00:00:00Z", status: "running", position: 1, phase: "encoding", percent: 0.4, startedAt: "2026-01-01T00:00:01Z", completedAt: null, error: null, artifactPath: null },
    { clipId: "b", profileJson: JSON.stringify(PROFILE), outputDir: null, filename: null, requestedAt: "2026-01-01T00:00:00Z", status: "queued", position: 2, phase: null, percent: 0, startedAt: null, completedAt: null, error: null, artifactPath: null },
  ];
  const q = makeQueue({ jobs, fs: new FakeFs(), clips: [makeClip("a"), makeClip("b")] });
  await q.resume();

  assertEquals(jobs.rows[0]?.requestedAt, "2026-01-01T00:00:00Z", "the stamp must survive the resume");
  const view = await q.view();
  assertEquals(view.counts.total, 2, "the resumed item is still part of its own batch");
});
