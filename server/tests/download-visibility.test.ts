/**
 * A download that has just started must be VISIBLE as active immediately, WITHOUT
 * blocking the run it is announcing.
 *
 * The reported regression: starting a VOD download from the Library showed no progress
 * container until the page was refreshed or navigated away and back.
 *
 * Three causes, all fixed:
 *  1. server: `markRunLive(id, true)` only registered the stream in `liveRuns`, while
 *     `getState()` answers from `liveStates` and otherwise falls back to the persisted
 *     snapshot. A just-imported stream has no snapshot, so it returned idle() and a
 *     client polling right after the import saw no download at all.
 *  2. server: the first fix for (1) seeded phase "running", which made `run()` refuse
 *     the very download it was announcing — `run()` treats an existing "running" phase
 *     as a second concurrent download. Every URL import then failed with "A download is
 *     already running for this stream". The seeded phase is "starting": active, but not
 *     the value the guard tests for.
 *  3. client: the Library's import mutations invalidated only ['streams'], never the
 *     downloads query the container renders from. (Covered structurally by
 *     frontend/tests/download-mutation-invalidates.test.mjs.)
 */
import { assert, assertEquals } from "@std/assert";
import { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";

/** A metadata store with nothing recorded, i.e. a freshly imported stream. */
function emptyMetadata() {
  return {
    get: (_id: string, _key: string) => Promise.resolve(null),
    set: (_id: string, _key: string, _value: string) => Promise.resolve(),
  };
}

function orchestrator(): DownloadOrchestrator {
  return new DownloadOrchestrator(emptyMetadata() as never, {} as never);
}

Deno.test("a stream with no recorded state reads as idle (the pre-start case)", async () => {
  const orch = orchestrator();
  const st = await orch.getState("fresh");
  assertEquals(st.phase, "idle");
});

Deno.test("markRunLive(true) makes the download ACTIVE at once, with no downloader tick", async () => {
  const orch = orchestrator();
  const id = "just-imported";

  // This is what ImportStream calls before it starts the download, synchronously.
  orch.markRunLive(id, true);

  const st = await orch.getState(id);
  assertEquals(
    st.phase,
    "starting",
    "the container renders on an active phase: an idle answer here is the regression, " +
      "because the client's first poll can arrive before the downloader's first tick",
  );
  assert(st.startedAt, "an active state must carry a start time");
});

Deno.test("the seeded state must NOT block the run it announces", async () => {
  // THE REGRESSION FROM THE FIRST FIX: run() reads getState() and refuses a stream
  // whose phase is already "running", and ImportStream calls markRunLive(true)
  // immediately before run(). Seeding "running" therefore made every URL import fail
  // with "A download is already running for this stream" — the download never started
  // and no container could ever appear.
  const orch = orchestrator();
  const id = "announced";
  orch.markRunLive(id, true);
  const st = await orch.getState(id);
  assert(
    st.phase !== "running",
    "a freshly announced run must not present the phase that the concurrency guard " +
      "rejects, or the download refuses to start",
  );
  assertEquals(st.phase, "starting");
});

Deno.test("the view reports an announced download as ACTIVE and labels it", async () => {
  const { projectDownloadView } = await import("@/application/view/project-download-view.ts");
  const orch = orchestrator();
  const id = "announced-view";
  orch.markRunLive(id, true);
  const state = await orch.getState(id);

  const view = projectDownloadView({
    streamId: id,
    state,
    markers: null,
    hasSource: true,
    revision: 1,
  });

  assertEquals(view.active, true, "the container renders on active");
  assertEquals(view.phase, "starting");
  assertEquals(
    view.label,
    "downloading",
    "an unstarted part should read as downloading rather than an empty label",
  );
});

Deno.test("markRunLive(true) does not clobber progress a resume is carrying", async () => {
  const orch = orchestrator();
  const id = "resuming";

  orch.markRunLive(id, true);
  const first = await orch.getState(id);
  const startedAt = first.startedAt;

  // A second markRunLive (e.g. resume) must not reset the clock or the progress.
  orch.markRunLive(id, true);
  const second = await orch.getState(id);
  assertEquals(second.phase, "starting");
  assertEquals(second.startedAt, startedAt, "the start time must survive a re-mark");
});

Deno.test("markRunLive(false) drops the live state so disk becomes the truth", async () => {
  const orch = orchestrator();
  const id = "finished";
  orch.markRunLive(id, true);
  assertEquals((await orch.getState(id)).phase, "starting");

  orch.markRunLive(id, false);
  // With the RAM copy gone and no persisted record, the honest answer is idle.
  assertEquals((await orch.getState(id)).phase, "idle");
});
