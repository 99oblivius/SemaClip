/**
 * Stream↔disk reconciliation tests.
 *
 * Standing requirement: the user owns the artifact folder — dragging a file
 * in, deleting one, or moving one must converge the DB to what is actually
 * there. A stored path is a claim; disk is the truth.
 *
 * The scan is by ROLE, from the filename: which artifact a file is must not depend on the
 * download mode or on which part the downloader happens to be running. Both of those produced
 * live bugs, and the cases below pin them.
 */
import { assert, assertEquals } from "@std/assert";
import {
  pickVideo,
  reconcileStreamRecord,
  scanArtifactNames,
  VIDEO_EXTENSIONS,
} from "@/application/use-cases/reconcile-stream.ts";
import { artifactName, streamSlug } from "@/application/use-cases/artifact-naming.ts";

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
    { video: `${DIR}/my-recording.mkv`, proxy: null, chat: null },
    existsIn(`${DIR}/my-recording.mkv`),
  );
  assertEquals(r.stream?.vodPath, `${DIR}/my-recording.mkv`);
  assert(r.adopted.includes(`${DIR}/my-recording.mkv`));
});

Deno.test("reconcile: a dropped-in chat.json attaches itself", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: "", chatPath: null },
    { video: null, proxy: null, chat: `${DIR}/chat.json` },
    existsIn(`${DIR}/chat.json`),
  );
  assertEquals(r.stream?.chatPath, `${DIR}/chat.json`);
});

Deno.test("reconcile: a deliberate vodPath is kept when its file exists", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: `${DIR}/custom.mp4`, chatPath: null },
    { video: `${DIR}/other.mp4`, proxy: null, chat: null },
    existsIn(`${DIR}/custom.mp4`, `${DIR}/other.mp4`),
  );
  assertEquals(r.stream, null, "nothing to repair");
  assertEquals(r.adopted, [], "an existing record is never overridden");
});

Deno.test("reconcile: nothing to do returns no write", () => {
  const r = reconcileStreamRecord(
    { id: "s1", vodPath: `${DIR}/video.mp4`, chatPath: `${DIR}/chat.json` },
    { video: `${DIR}/video.mp4`, proxy: null, chat: `${DIR}/chat.json` },
    existsIn(`${DIR}/video.mp4`, `${DIR}/chat.json`),
  );
  assertEquals(r.stream, null);
  assertEquals(r.dropped, []);
  assertEquals(r.adopted, []);
});

Deno.test("scan: artifacts are identified by ROLE, not by which looks like a video first", () => {
  const slug = streamSlug({ id: "s1", title: "Weskie Wednesday | Scuffed Stream 77.0" });
  const names = [
    artifactName("video", slug),
    artifactName("proxy", slug),
    artifactName("chat", slug),
    artifactName("video-index", slug),
    artifactName("proxy-index", slug),
  ];
  const scan = scanArtifactNames(DIR, names, slug);

  assertEquals(scan.video, `${DIR}/${artifactName("video", slug)}`);
  assertEquals(scan.proxy, `${DIR}/${artifactName("proxy", slug)}`);
  // The chat role must find the app's own `{slug}.chat.json`. The previous scanner looked for a
  // literal "chat.json", which this project never writes, so a real project's chat was never
  // re-adopted.
  assertEquals(scan.chat, `${DIR}/${artifactName("chat", slug)}`);
});

Deno.test("scan: a real two-artifact folder never yields the PROXY as the video", () => {
  // The regression this pins: with both artifacts present, `pickVideo` sorted by container and
  // name, and "- proxy.mp4" sorts before "- video.mp4" — so the project's main video was
  // reported as the 540p preview, which is the export source.
  const slug = streamSlug({ id: "s1", title: "Weskie Wednesday | Scuffed Stream 77.0" });
  const names = [artifactName("video", slug), artifactName("proxy", slug)];
  assertEquals(pickVideo(names), null, "the app's own artifacts are never adopted as foreign");
  const scan = scanArtifactNames(DIR, names, slug);
  assertEquals(scan.video, `${DIR}/${artifactName("video", slug)}`);
  assert(!scan.video!.includes("proxy"), "the video role must never resolve to the proxy");
});

Deno.test("scan: the app's chat file is recognised, and a foreign video still adopts", () => {
  const slug = streamSlug({ id: "s1", title: "Some Stream" });
  const names = [artifactName("chat", slug), "my-own-recording.mkv"];
  const scan = scanArtifactNames(DIR, names, slug);
  assertEquals(scan.chat, `${DIR}/${artifactName("chat", slug)}`);
  // A user's own file is still adoptable — identity by role must not make foreign files
  // invisible, or dragging in a replacement could never be picked up.
  assertEquals(scan.video, `${DIR}/my-own-recording.mkv`);
  assertEquals(scan.proxy, null, "the proxy role has no foreign fallback");
});

Deno.test("scan: legacy boilerplate names are still recognised", () => {
  const scan = scanArtifactNames(DIR, ["video.mp4", "proxy.mp4", "chat.json"], null);
  assertEquals(scan.video, `${DIR}/video.mp4`);
  assertEquals(scan.proxy, `${DIR}/proxy.mp4`);
  assertEquals(scan.chat, `${DIR}/chat.json`);
});

Deno.test("scan: an index sidecar is never mistaken for media", () => {
  const slug = streamSlug({ id: "s1", title: "Some Stream" });
  const names = [artifactName("video-index", slug), artifactName("proxy-index", slug)];
  const scan = scanArtifactNames(DIR, names, slug);
  assertEquals(scan.video, null);
  assertEquals(scan.proxy, null);
});

Deno.test("pickVideo: container preference then name order, app artifacts excluded", () => {
  assertEquals(pickVideo(["b.webm", "a.mkv"]), "a.mkv", "mkv outranks webm");
  assertEquals(pickVideo(["z.mp4", "a.mkv"]), "z.mp4", "mp4 outranks mkv");
  assertEquals(pickVideo(["b.mp4", "a.mp4"]), "a.mp4", "name order breaks ties");
  // The app's own download artifacts are never foreign files.
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
