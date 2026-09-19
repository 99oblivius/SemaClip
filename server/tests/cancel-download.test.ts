/**
 * Cancelling a download must CLEAN UP what it wrote.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────────
 * `cancelPiece` only called `controller.abort()`. Every caller treats "cancel" as "stop and tidy
 * up", so the reported behaviour was exactly what the code did: the download stopped, the partial
 * `.mp4` and its `.fragments` index stayed on disk, and the piece still read as present. The
 * owner's cache confirmed it — completed projects carried a `.mp4` plus a `.fragments` after a
 * cancel — and the same gesture behaved differently in the two panels because the library's
 * "Cancel" used the whole-download DELETE (which does sweep the directory) while project settings
 * used the per-piece cancel (which swept nothing).
 *
 * These tests are the difference between the two verbs: cancel removes ONLY its own piece and
 * leaves everything else alone, including a completed piece it was never asked to touch.
 */
import { assert, assertEquals } from "@std/assert";
import { MediaActionsUseCase } from "@/application/use-cases/MediaActions.ts";

const SLUG = "my-stream";
const DIR = "/cache/vods/s1";
const VIDEO = `${DIR}/${SLUG} - video.mp4`;
const VIDEO_IDX = `${DIR}/${SLUG} - video.fragments`;
const PROXY = `${DIR}/${SLUG} - proxy.mp4`;
const PROXY_IDX = `${DIR}/${SLUG} - proxy.fragments`;
const LEGACY_IDX = `${DIR}/video.fragments`;

function fakeFs(files: Set<string>) {
  return {
    exists: (p: string) => Promise.resolve(files.has(p)),
    remove: (p: string) => {
      files.delete(p);
      return Promise.resolve();
    },
    ensureDir: () => Promise.resolve(),
    listFiles: (dir: string) =>
      Promise.resolve(
        [...files]
          .filter((f) => f.startsWith(`${dir}/`) && !f.slice(dir.length + 1).includes("/"))
          .map((f) => f.slice(dir.length + 1)),
      ),
    nativePath: (p: string) => p,
  };
}

function harness(existing: string[], activeKind: "proxy" | "hq" | null = null) {
  const files = new Set(existing);
  for (const p of existing) files.add(p.replace(/\/[^/]+$/, ""));
  files.add(DIR);

  const state: Record<string, unknown> = {
    phase: "running",
    includeProxy: true,
    proxyPath: PROXY,
    proxyMp4: PROXY,
    hqPath: VIDEO,
    hqMp4: VIDEO,
    chatPath: null,
    parts: [
      { kind: "proxy", status: "running", percent: 0.4, downloadedBytes: 1000, downloadedSec: 4 },
      { kind: "hq", status: "running", percent: 0.2, downloadedBytes: 500, downloadedSec: 2 },
    ],
  };
  let written: Record<string, unknown> | null = null;
  // A PERSISTENT store, like the real orchestrator: a fake that returns a fresh clone each read
  // would let a two-write sequence look correct when the second write drops the first one's work.
  let stored = structuredClone(state);

  const useCase = new MediaActionsUseCase(
    {
      findById: () =>
        Promise.resolve({ id: "s1", title: "My Stream", streamer: "streamer", vodPath: VIDEO }),
      update: () => Promise.resolve(),
    } as never,
    { get: () => Promise.resolve(null), set: () => Promise.resolve() } as never,
    fakeFs(files) as never,
    {
      getState: () => Promise.resolve(structuredClone(stored)),
      setState: (_id: string, s: Record<string, unknown>) => {
        written = structuredClone(s);
        stored = structuredClone(s);
        return Promise.resolve();
      },
    } as never,
    "/cache",
  );

  // A live controller, as a running download would have. `activeKind` is informational here: the
  // map is keyed by stream, so any live piece means "something is running for this stream".
  const aborts = (useCase as unknown as { pieceAborts: Map<string, AbortController> }).pieceAborts;
  if (activeKind) aborts.set("s1", new AbortController());

  return { useCase, files, writtenState: () => written, aborts };
}

Deno.test("cancelPiece REMOVES the cancelled piece's media and its fragment index", async () => {
  const h = harness([VIDEO, VIDEO_IDX, PROXY, PROXY_IDX], "proxy");

  const ok = await h.useCase.cancelPiece("s1", "proxy");

  assertEquals(ok, true, "a cancel that cleaned up must report success");
  assert(!h.files.has(PROXY), "the cancelled proxy file must be gone");
  assert(!h.files.has(PROXY_IDX), "the cancelled proxy's fragment index must be gone");
});

Deno.test("cancelPiece leaves OTHER artifacts untouched", async () => {
  // The whole point of a per-piece cancel: cancelling the proxy must not cost the user the video
  // they already downloaded.
  const h = harness([VIDEO, VIDEO_IDX, PROXY, PROXY_IDX], "proxy");

  await h.useCase.cancelPiece("s1", "proxy");

  assert(h.files.has(VIDEO), "the VIDEO must survive cancelling the proxy");
  assert(h.files.has(VIDEO_IDX), "the video's index must survive too");
});

Deno.test("cancelPiece removes the legacy `video.fragments` name as well", async () => {
  // MEASURED: the index removal derived from the CANONICAL names only, so a project whose media was
  // `{slug} - video.mp4` kept its index behind. The legacy boilerplate name is the other half.
  const h = harness([VIDEO, VIDEO_IDX, LEGACY_IDX], "hq");

  await h.useCase.cancelPiece("s1", "hq");

  assert(!h.files.has(VIDEO), "the video must be gone");
  assert(!h.files.has(VIDEO_IDX), "the project-named index must be gone");
  assert(!h.files.has(LEGACY_IDX), "the legacy index name must be gone too");
});

Deno.test("cancelPiece cleans up even with NO live run (an orphaned state)", async () => {
  // The route's own comment calls this out for the whole-download case: an orphaned state left by a
  // crashed server has no AbortController, and the old cancel was a no-op for exactly that state.
  // Returning false here would report failure for a cleanup that actually worked.
  const h = harness([PROXY, PROXY_IDX], null);

  const ok = await h.useCase.cancelPiece("s1", "proxy");

  assertEquals(ok, true, "cleanup succeeded even though there was nothing to abort");
  assert(!h.files.has(PROXY), "the file was still removed");
});

Deno.test("cancelPiece resets the piece's counters, not just its status", async () => {
  // Leaving `downloadedBytes` behind makes the UI report the removed file's size — and, once a
  // re-download starts, report it as immediately complete.
  const h = harness([PROXY, PROXY_IDX], "proxy");

  await h.useCase.cancelPiece("s1", "proxy");

  const written = h.writtenState() as { parts: Array<Record<string, unknown>>; phase: string };
  const part = written.parts.find((p) => p.kind === "proxy");
  assertEquals(part?.status, "pending");
  assertEquals(part?.downloadedBytes, 0);
  assertEquals(part?.downloadedSec, 0);
  assertEquals(written.phase, "idle", "a cancelled download is no longer running");
});

Deno.test("cancelPiece aborts the live run (the original, still-required half)", async () => {
  const h = harness([PROXY, PROXY_IDX], "proxy");
  const controller = h.aborts.get("s1")!;
  assertEquals(controller.signal.aborted, false, "precondition: not yet aborted");

  await h.useCase.cancelPiece("s1", "proxy");

  assertEquals(controller.signal.aborted, true, "the running download must be aborted");
  assertEquals(h.aborts.has("s1"), false, "and forgotten, so it cannot be aborted twice");
});
