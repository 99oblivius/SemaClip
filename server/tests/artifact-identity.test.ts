/**
 * Regression tests for the two-file artifact model.
 *
 * Both cases are the owner's own reports, reproduced against the real backend before the fix:
 *
 *   1. "re-downloading a proxy video causes the video to be counted as downloaded instead of
 *      the intended proxy"
 *   2. "even if the hq video is downloaded, re-downloading the proxy doesn't lead to it getting
 *      marked as on disk even though the download completed"
 *
 * Measured, before the fix, on a project with the video already present (1,099,563,493 bytes on
 * disk) after POSTing a proxy piece:
 *
 *     proxy  status=pending  bytes=0          onDisk=false   <- the file that just landed
 *     video  status=done     bytes= 261552091 onDisk=true    <- reporting the PROXY's size
 *
 * The slot a file was recorded in decided which artifact it was, and `includeProxy` gated
 * whether a proxy counted as present at all. Identity now comes from the filename, so neither
 * can happen: a file is what its name says it is, whatever slot it was written in.
 */
import { assertEquals } from "@std/assert";
import { projectDownloadView } from "@/application/view/project-download-view.ts";
import type { DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";

const base = { streamId: "s1", markers: null, hasSource: true, revision: 1 };
const SLUG = "18-weskie-wednesday-scuffed-stream-77-0";
const VIDEO = `/d/${SLUG} - video.mp4`;
const PROXY = `/d/${SLUG} - proxy.mp4`;

function state(over: Partial<DownloadState> = {}): DownloadState {
  return {
    phase: "done",
    parts: [],
    overall: { percent: 1, etaSec: null },
    proxyFrontierSec: 0,
    proxyPath: null,
    hqPath: null,
    proxyMp4: null,
    hqMp4: null,
    chatPath: null,
    chatCount: 0,
    qualities: [],
    startedAt: null,
    includeProxy: false,
    ...over,
  } as DownloadState;
}

function part(kind: "chat" | "markers" | "proxy" | "hq", over: Record<string, unknown> = {}) {
  return {
    kind,
    status: "done" as const,
    percent: 1,
    downloadedSec: 0,
    totalSec: 0,
    downloadedBytes: 0,
    etaSec: null,
    ...over,
  };
}

Deno.test("proxy re-download: the PROXY reports the file it wrote, not the video's", () => {
  // The reported shape: a proxy piece finished on a project whose video already existed.
  const view = projectDownloadView({
    ...base,
    state: state({
      parts: [part("proxy"), part("hq")],
      proxyPath: PROXY,
      proxyMp4: PROXY,
      hqPath: VIDEO,
      hqMp4: VIDEO,
      presence: {
        proxy: { onDisk: true, bytes: 101_173_883, path: PROXY },
        hq: { onDisk: true, bytes: 261_552_091, path: VIDEO },
      },
    }),
  });
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;
  const video = view.artifacts.find((a) => a.kind === "video")!;

  assertEquals(proxy.onDisk, true, "the proxy that just finished is on disk");
  assertEquals(proxy.bytes, 101_173_883, "and reports ITS OWN size");
  assertEquals(proxy.path, PROXY);
  assertEquals(video.bytes, 261_552_091, "the video keeps its own size");
  assertEquals(video.path, VIDEO);
  assertEquals(video.sharedWith, [], "the two artifacts never claim one file");
});

Deno.test("proxy download onto a single-file project: reported ON DISK, with no mode set", () => {
  // Report 2. `includeProxy` is false — this project downloaded only a video — and a proxy
  // piece was downloaded afterwards. The old view gated the proxy's presence on the mode, so
  // the completed download was reported as absent.
  const view = projectDownloadView({
    ...base,
    state: state({
      includeProxy: false,
      parts: [part("proxy"), part("hq")],
      proxyPath: PROXY,
      proxyMp4: PROXY,
      hqPath: VIDEO,
      hqMp4: VIDEO,
      presence: {
        proxy: { onDisk: true, bytes: 101_173_883, path: PROXY },
        hq: { onDisk: true, bytes: 261_552_091, path: VIDEO },
      },
    }),
  });
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;
  assertEquals(proxy.onDisk, true, "a completed download must never be reported absent");
  assertEquals(proxy.bytes, 101_173_883);
  assertEquals(proxy.path, PROXY, "and must not be aliased to the video's file");
});

Deno.test("legacy state: a video recorded in the PROXY slot still reads as the video", () => {
  // States written before this change recorded a single-file download in the proxy slot. The
  // filename decides, so those projects keep working with no migration.
  const view = projectDownloadView({
    ...base,
    state: state({
      parts: [part("proxy"), part("hq", { status: "skipped", percent: 1 })],
      proxyPath: VIDEO,
      proxyMp4: VIDEO,
      presence: { proxy: { onDisk: true, bytes: 261_552_091, path: VIDEO } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;

  assertEquals(video.onDisk, true, "the video is found where it was recorded");
  assertEquals(video.path, VIDEO);
  assertEquals(proxy.onDisk, false, "and the proxy does not claim the video's file");
  assertEquals(proxy.path, null, "a foreign path is not even named on the proxy row");
  assertEquals(view.media.renderPath, VIDEO, "the render source is the video");
});

Deno.test("legacy two-file state: the video is never resolved to the proxy", () => {
  // The regression that made reconciliation adopt `- proxy.mp4` as the project's video: with
  // both present, name order put the proxy first. A 540p file would have become the render
  // source for exports.
  const view = projectDownloadView({
    ...base,
    state: state({
      parts: [part("proxy"), part("hq")],
      proxyPath: PROXY,
      proxyMp4: PROXY,
      hqPath: VIDEO,
      hqMp4: VIDEO,
      presence: {
        proxy: { onDisk: true, bytes: 101_173_883, path: PROXY },
        hq: { onDisk: true, bytes: 261_552_091, path: VIDEO },
      },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.path, VIDEO);
  assertEquals(view.media.renderPath, VIDEO, "the render source is the full-quality file");
});

Deno.test("deleting the proxy does not forget a video still on disk", () => {
  // The state clears the proxy fields; the video keeps its own. The old delete nulled the
  // proxy slot unconditionally, and in single-file mode that slot held the video.
  const view = projectDownloadView({
    ...base,
    state: state({
      parts: [part("proxy", { status: "pending", percent: 0 }), part("hq")],
      hqPath: VIDEO,
      hqMp4: VIDEO,
      presence: { hq: { onDisk: true, bytes: 261_552_091, path: VIDEO } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.onDisk, true, "the 1.1GB file is still there");
  assertEquals(video.bytes, 261_552_091);
  assertEquals(view.media.renderPath, VIDEO);
});
