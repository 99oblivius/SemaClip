/**
 * Playback resolution while a download is RUNNING.
 *
 * The reported bug: "the preview content in the Review page still streams from the url
 * instead of being the view of the proxy or video that is being or is finalized
 * downloading". Cause: resolvePlayback gated on `onDisk`, which means COMPLETE by
 * design, so a running download offered nothing playable and the frontend fell back to
 * the Twitch source URL. The fMP4 pipeline exists precisely so a growing file can be
 * watched, so this asserts the growing file is offered, with its frontier as the seek
 * ceiling, and that a genuinely absent artifact still yields nothing.
 */
import { assert, assertEquals } from "@std/assert";
import { resolvePlayback, type ArtifactView } from "@/application/view/download-view.ts";

function artifact(over: Partial<ArtifactView> & { kind: ArtifactView["kind"] }): ArtifactView {
  return {
    label: over.kind,
    status: "pending",
    percent: 0,
    etaSec: null,
    bytes: 0,
    frontierSec: null,
    totalSec: null,
    onDisk: false,
    path: null,
    sharedWith: [],
    error: null,
    downloadable: true,
    removable: false,
    ...over,
  };
}

Deno.test("a RUNNING download is playable to its frontier, not withheld until complete", () => {
  const media = resolvePlayback([
    artifact({
      kind: "video",
      status: "running",
      path: "/vods/1/clip - video.mp4",
      bytes: 52_428_800, // real bytes on disk, still arriving
      frontierSec: 140,
      totalSec: 7200,
      onDisk: false, // deliberately NOT complete
      percent: 0.03,
    }),
    artifact({ kind: "proxy", status: "done", onDisk: true, path: "/vods/1/clip - proxy.mp4" }),
  ]);

  assertEquals(
    media.playablePath,
    "/vods/1/clip - video.mp4",
    "the running video must be playable; falling back to the source url is the reported bug",
  );
  assertEquals(media.frontierSec, 140, "the frontier is the seek ceiling for a growing file");
  assertEquals(media.previewOnly, false, "a video exists, so this is not preview-only");
});

Deno.test("a running artifact with NO bytes yet is not offered", () => {
  // The downloader opens its destination immediately, so status can be running while
  // the file is still empty. Offering that would hand the player a zero-byte file.
  const media = resolvePlayback([
    artifact({
      kind: "video",
      status: "running",
      path: "/vods/1/clip - video.mp4",
      bytes: 0,
      frontierSec: 0,
      onDisk: false,
    }),
  ]);
  assertEquals(media.playablePath, null);
  assertEquals(media.frontierSec, 0);
});

Deno.test("a COMPLETE artifact plays to its full duration, not a stale frontier", () => {
  const media = resolvePlayback([
    artifact({
      kind: "video",
      status: "done",
      path: "/vods/1/clip - video.mp4",
      bytes: 1_000_000_000,
      onDisk: true,
      frontierSec: 7190, // what it reached while downloading
      totalSec: 7200,
    }),
  ]);
  assertEquals(media.playablePath, "/vods/1/clip - video.mp4");
  assertEquals(media.frontierSec, 7200, "a complete file is fully seekable");
});

Deno.test("a running VIDEO wins over a complete proxy, and the proxy stays the fallback", () => {
  const withVideo = resolvePlayback([
    artifact({ kind: "video", status: "running", path: "/v.mp4", bytes: 1000, frontierSec: 30 }),
    artifact({ kind: "proxy", status: "done", onDisk: true, path: "/p.mp4", frontierSec: 5400 }),
  ]);
  assertEquals(withVideo.playablePath, "/v.mp4", "the video is canonical whenever it can be watched");

  // Once the video is deleted, playback falls back to the proxy at preview quality.
  const proxyOnly = resolvePlayback([
    artifact({ kind: "video", status: "pending" }),
    artifact({ kind: "proxy", status: "done", onDisk: true, path: "/p.mp4", totalSec: 5400 }),
  ]);
  assertEquals(proxyOnly.playablePath, "/p.mp4");
  assertEquals(proxyOnly.previewOnly, true, "no video means exports are impossible");
});

Deno.test("nothing on disk yields no playable path, so the source fallback still exists", () => {
  const media = resolvePlayback([
    artifact({ kind: "video", status: "pending" }),
    artifact({ kind: "proxy", status: "pending" }),
  ]);
  assertEquals(media.playablePath, null, "the frontend must still be able to fall back to the source url");
});
