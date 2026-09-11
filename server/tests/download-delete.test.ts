/**
 * Deletion semantics — the ripple bug.
 *
 * Measured before this work: in single-download mode `DELETE /video` deleted
 * the shared proxy.mp4, so BOTH rows lost their bytes. One file must never be
 * destroyed by another artifact's trash, and playback must resolve to
 * whatever survives.
 */
import { assert, assertEquals } from "@std/assert";
import { projectDownloadView } from "@/application/view/project-download-view.ts";
import type { DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";

function state(over: Partial<DownloadState> = {}): DownloadState {
  return {
    phase: "done",
    parts: [],
    overall: { percent: 1, etaSec: null },
    proxyFrontierSec: 100,
    proxyPath: null,
    hqPath: null,
    proxyMp4: null,
    hqMp4: null,
    chatPath: null,
    chatCount: 0,
    qualities: [],
    startedAt: null,
    includeProxy: true,
    ...over,
  };
}

const base = { streamId: "s1", markers: null, hasSource: true, revision: 1 };

Deno.test("delete: removing the video leaves the proxy playable (preview) and flagged", () => {
  // Two-file project, then the video file goes away: the proxy must survive,
  // remain playable, and the view must flag that exports are impossible.
  const before = projectDownloadView({
    ...base,
    state: state({
      parts: [
        { kind: "proxy", status: "done", percent: 1, downloadedSec: 100, totalSec: 100, downloadedBytes: 500, etaSec: null },
        { kind: "hq", status: "done", percent: 1, downloadedSec: 100, totalSec: 100, downloadedBytes: 2000, etaSec: null },
      ],
      proxyPath: "/d/proxy.mp4",
      proxyMp4: "/d/proxy.mp4",
      hqPath: "/d/hq.mp4",
      hqMp4: "/d/hq.mp4",
      presence: {
        proxy: { onDisk: true, bytes: 500, path: "/d/proxy.mp4" },
        hq: { onDisk: true, bytes: 2000, path: "/d/hq.mp4" },
      },
    }),
  });
  assertEquals(before.media.playablePath, "/d/hq.mp4");
  assertEquals(before.media.previewOnly, false);

  // After DELETE /video: the hq file is gone, the proxy is untouched.
  const after = projectDownloadView({
    ...base,
    state: state({
      parts: [
        { kind: "proxy", status: "done", percent: 1, downloadedSec: 100, totalSec: 100, downloadedBytes: 500, etaSec: null },
        { kind: "hq", status: "pending", percent: 0, downloadedSec: 0, totalSec: 0, downloadedBytes: 0, etaSec: null },
      ],
      proxyPath: "/d/proxy.mp4",
      proxyMp4: "/d/proxy.mp4",
      presence: { proxy: { onDisk: true, bytes: 500, path: "/d/proxy.mp4" } },
    }),
  });
  const proxy = after.artifacts.find((a) => a.kind === "proxy")!;
  assertEquals(proxy.onDisk, true, "the proxy file must survive deleting the video");
  assertEquals(proxy.bytes, 500, "the proxy keeps its own size");
  assertEquals(after.media.playablePath, "/d/proxy.mp4", "playback falls back to the proxy");
  assertEquals(after.media.previewOnly, true, "and the UI is told exports are impossible");
});

Deno.test("delete: removing the proxy leaves the video fully functional", () => {
  const after = projectDownloadView({
    ...base,
    state: state({
      parts: [
        { kind: "proxy", status: "pending", percent: 0, downloadedSec: 0, totalSec: 0, downloadedBytes: 0, etaSec: null },
        { kind: "hq", status: "done", percent: 1, downloadedSec: 100, totalSec: 100, downloadedBytes: 2000, etaSec: null },
      ],
      hqPath: "/d/hq.mp4",
      hqMp4: "/d/hq.mp4",
      presence: { hq: { onDisk: true, bytes: 2000, path: "/d/hq.mp4" } },
    }),
  });
  // The proxy row REMAINS (two-file mode expects a proxy) but reports no
  // file — that row is how the proxy gets re-downloaded.
  const proxyRow = after.artifacts.find((a) => a.kind === "proxy")!;
  assertEquals(proxyRow.onDisk, false, "the deleted proxy reports no file");
  assertEquals(proxyRow.bytes, 0);
  assertEquals(proxyRow.downloadable, true, "and can be downloaded again");
  assertEquals(after.media.playablePath, "/d/hq.mp4");
  assertEquals(after.media.previewOnly, false, "the video is canonical — not preview-only");
  assertEquals(after.artifacts.find((a) => a.kind === "video")!.bytes, 2000);
});

Deno.test("delete: single-download project has one artifact, so no cross-deletion is possible", () => {
  // The old model aliased hqPath to proxyPath, so deleting either killed the
  // other. With one artifact there is nothing to alias.
  const view = projectDownloadView({
    ...base,
    state: state({
      includeProxy: false,
      parts: [
        { kind: "proxy", status: "done", percent: 1, downloadedSec: 100, totalSec: 100, downloadedBytes: 500, etaSec: null },
        { kind: "hq", status: "skipped", percent: 1, downloadedSec: 0, totalSec: 0, downloadedBytes: 0, etaSec: null },
      ],
      proxyPath: "/d/video.mp4",
      proxyMp4: "/d/video.mp4",
      presence: { proxy: { onDisk: true, bytes: 500, path: "/d/video.mp4" } },
    }),
  });
  // chat + the single video file. Crucially there is exactly ONE video-kind
  // artifact, so no cross-deletion is possible.
  assertEquals(view.artifacts.map((a) => a.kind), ["chat", "video"]);
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.sharedWith, [], "nothing else claims this file");
  assertEquals(view.media.playablePath, "/d/video.mp4");
  assertEquals(view.media.previewOnly, false);
});
