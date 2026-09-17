/**
 * A download that has just started must be VISIBLE as running immediately.
 *
 * The reported regression: starting a VOD download from the Library showed no progress
 * container until the page was refreshed or navigated away and back.
 *
 * Two causes, both fixed:
 *  1. server: `markRunLive(id, true)` only registered the stream in `liveRuns`, while
 *     `getState()` answers from `liveStates` and otherwise falls back to the persisted
 *     snapshot. A just-imported stream has no snapshot, so it returned idle() and the
 *     client polling right after the import saw no download at all. The import does not
 *     await the download, so that window is real.
 *  2. client: the Library's import mutations invalidated only ['streams'], never the
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

Deno.test("markRunLive(true) makes the state RUNNING at once — no downloader tick needed", async () => {
  const orch = orchestrator();
  const id = "just-imported";

  // This is what ImportStream calls before it starts the download, synchronously.
  orch.markRunLive(id, true);

  const st = await orch.getState(id);
  assertEquals(
    st.phase,
    "running",
    "the container renders from this: an idle phase here is the regression, because " +
      "the client's first poll can arrive before the downloader's first progress tick",
  );
  assert(st.startedAt, "a running state must carry a start time");
});

Deno.test("markRunLive(true) does not clobber progress a resume is carrying", async () => {
  const orch = orchestrator();
  const id = "resuming";

  // A run already in flight with real progress.
  orch.markRunLive(id, true);
  const first = await orch.getState(id);
  const startedAt = first.startedAt;

  // A second markRunLive (e.g. resume) must not reset the clock or the progress.
  orch.markRunLive(id, true);
  const second = await orch.getState(id);
  assertEquals(second.phase, "running");
  assertEquals(second.startedAt, startedAt, "the start time must survive a re-mark");
});

Deno.test("markRunLive(false) drops the live state so disk becomes the truth", async () => {
  const orch = orchestrator();
  const id = "finished";
  orch.markRunLive(id, true);
  assertEquals((await orch.getState(id)).phase, "running");

  orch.markRunLive(id, false);
  // With the RAM copy gone and no persisted record, the honest answer is idle.
  assertEquals((await orch.getState(id)).phase, "idle");
});
