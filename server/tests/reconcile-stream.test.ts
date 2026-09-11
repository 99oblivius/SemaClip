/**
 * Stream↔disk reconciliation tests.
 *
 * Standing requirement: the user owns the artifact folder — dragging a file
 * in, deleting one, or moving one must converge the DB to what is actually
 * there. A stored path is a claim; disk is the truth.
 */
import { assert, assertEquals } from "@std/assert";
import {
  pickVideo,
  reconcileStreamRecord,
  VIDEO_EXTENSIONS,
} from "@/application/use-cases/reconcile-stream.ts";

const DIR = "/cache/vods/s1";
const existsIn = (...paths: string[]) => {
  const set = new Set(paths);
  return (p: string) => set.has(p);
};

Deno.test("reconcile: a vanished vodPath is dropped (the deleted-file lie)", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: `${DIR}/video.mp4`, chatPath: null },
    null,
    existsIn(), // nothing on disk
  );
  assertEquals(r.stream?.vodPath, "", "a path with no file must not survive");
  assertEquals(r.dropped, [`${DIR}/video.mp4`]);
});

Deno.test("reconcile: a vanished chatPath is dropped", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: "", chatPath: `${DIR}/chat.json` },
    null,
    existsIn(),
  );
  assertEquals(r.stream?.chatPath, null);
  assert(r.dropped.includes(`${DIR}/chat.json`));
});

Deno.test("reconcile: a file the user DROPPED IN is adopted as the video", () => {
  // The user replaced video.mp4 with something they dragged in; the record
  // pointed at the old name.
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: `${DIR}/video.mp4`, chatPath: null },
    { videos: [`${DIR}/my-recording.mkv`], chat: null },
    existsIn(`${DIR}/my-recording.mkv`),
  );
  assertEquals(r.stream?.vodPath, `${DIR}/my-recording.mkv`);
  assert(r.adopted.includes(`${DIR}/my-recording.mkv`));
});

Deno.test("reconcile: a dropped-in chat.json attaches itself", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: "", chatPath: null },
    { videos: [], chat: `${DIR}/chat.json` },
    existsIn(`${DIR}/chat.json`),
  );
  assertEquals(r.stream?.chatPath, `${DIR}/chat.json`);
});

Deno.test("reconcile: a deliberate vodPath is kept when its file exists", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: `${DIR}/custom.mp4`, chatPath: null },
    { videos: [`${DIR}/other.mp4`], chat: null },
    existsIn(`${DIR}/custom.mp4`, `${DIR}/other.mp4`),
  );
  assertEquals(r.stream, null, "nothing to repair");
  assertEquals(r.adopted, [], "an existing record is never overridden");
});

Deno.test("reconcile: nothing to do returns no write", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: `${DIR}/video.mp4`, chatPath: `${DIR}/chat.json` },
    { videos: [`${DIR}/video.mp4`], chat: `${DIR}/chat.json` },
    existsIn(`${DIR}/video.mp4`, `${DIR}/chat.json`),
  );
  assertEquals(r.stream, null);
  assertEquals(r.dropped, []);
  assertEquals(r.adopted, []);
});

Deno.test("pickVideo: container preference then name order, proxies excluded", () => {
  assertEquals(pickVideo(["b.webm", "a.mkv"]), "a.mkv", "mkv outranks webm");
  assertEquals(pickVideo(["z.mp4", "a.mkv"]), "z.mp4", "mp4 outranks mkv");
  assertEquals(pickVideo(["b.mp4", "a.mp4"]), "a.mp4", "name order breaks ties");
  // Proxy/download artifacts are never the main video.
  assertEquals(pickVideo(["proxy.mp4"]), null);
  assertEquals(pickVideo(["hq.mp4", "video.ts"]), null);
  assertEquals(pickVideo(["video.fragments", "chat.json"]), null);
  // A raw .ts IS acceptable when nothing better exists (imported fixtures).
  assertEquals(pickVideo(["stream.ts"]), "stream.ts");
  assertEquals(pickVideo([]), null);
});

Deno.test("pickVideo: every declared extension is recognised", () => {
  for (const ext of VIDEO_EXTENSIONS) {
    assert(pickVideo([`clip${ext}`]) === `clip${ext}`, `extension ${ext} must be a video`);
  }
});
