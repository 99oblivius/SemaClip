/**
 * A manually re-downloaded video must be reported as PRESENT in single-download mode.
 *
 * Reported: "I deleted the video specifically and went to download again, but now the
 * project settings don't show the video as installed and shows the download button still.
 * If I press it it seems to verify the video as it finishes in a few seconds without
 * downloading. Maybe there's a db desync?"
 *
 * It was not a DB desync — the file was on disk the whole time. The view mapped the video
 * artifact to the `proxy` presence slot in single-download mode, but a manual video piece
 * writes the `hq` slot. Measured on a real run: `presence.hq = {onDisk: true, bytes:
 * 101173883}` while the row read `video status=pending onDisk=False bytes=0`.
 */
import { assert, assertEquals } from "@std/assert";
import { projectDownloadView } from "@/application/view/project-download-view.ts";

const base = { streamId: "s1", markers: null, hasSource: true, revision: 1 };

function state(over: Record<string, unknown>) {
  return {
    phase: "done",
    includeProxy: false,
    parts: [],
    presence: {},
    overall: { percent: 1, etaSec: null },
    ...over,
  } as never;
}

Deno.test("single-download: a video piece in the HQ slot is reported as on disk", () => {
  const view = projectDownloadView({
    ...base,
    state: state({
      hqPath: "/d/clip - video.mp4",
      hqMp4: "/d/clip - video.mp4",
      presence: { hq: { onDisk: true, bytes: 101_173_883, path: "/d/clip - video.mp4" } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;

  assertEquals(video.onDisk, true, "the file exists, so the row must report it");
  assertEquals(video.bytes, 101_173_883, "and carry its real size");
  assertEquals(video.status, "done");
  assertEquals(
    view.media.playablePath,
    "/d/clip - video.mp4",
    "playback must find the file the view was calling absent",
  );
  assertEquals(view.media.renderPath, "/d/clip - video.mp4", "and it is renderable");
});

Deno.test("single-download: the pipeline's own proxy slot still reports the video", () => {
  // The normal import path records the one file in the proxy slot.
  const view = projectDownloadView({
    ...base,
    state: state({
      proxyPath: "/d/clip - video.mp4",
      proxyMp4: "/d/clip - video.mp4",
      presence: { proxy: { onDisk: true, bytes: 42, path: "/d/clip - video.mp4" } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.onDisk, true);
  assertEquals(video.bytes, 42);
  assertEquals(view.media.playablePath, "/d/clip - video.mp4");
});

Deno.test("single-download: NEITHER slot holding a file is still an absent video", () => {
  const view = projectDownloadView({
    ...base,
    state: state({ presence: {} }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.onDisk, false, "nothing on disk must not be invented");
  assertEquals(video.bytes, 0);
  assertEquals(view.media.playablePath, null);
});

Deno.test("two-file mode is untouched: the video reads the HQ slot only", () => {
  // With a real proxy there are two distinct files, so aliasing must not creep back in.
  const view = projectDownloadView({
    ...base,
    state: state({
      includeProxy: true,
      hqPath: "/d/clip - video.mp4",
      presence: {
        proxy: { onDisk: true, bytes: 500, path: "/d/clip - proxy.mp4" },
        hq: { onDisk: true, bytes: 9_000, path: "/d/clip - video.mp4" },
      },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;
  assertEquals(video.bytes, 9_000, "the video reports ITS OWN file");
  assertEquals(proxy.bytes, 500, "and the proxy keeps its own");
  assert(video.path !== proxy.path, "the two artifacts stay distinct");
});
