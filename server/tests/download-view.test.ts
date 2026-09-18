/**
 * Download view-model tests.
 *
 * Each test here corresponds to a bug the owner reported against the old
 * per-component derivation. They are the regression net for the rules:
 * a running artifact is never "on disk", `active` is one flag, one file is
 * never two artifacts, and markers are not a download.
 */
import { assertEquals } from "@std/assert";
import { projectDownloadView } from "@/application/view/project-download-view.ts";
import { composeLabel, resolvePlayback } from "@/application/view/download-view.ts";
import type { DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";

function state(over: Partial<DownloadState> = {}): DownloadState {
  return {
    phase: "idle",
    parts: [],
    overall: { percent: 0, etaSec: null },
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
  };
}

function part(kind: "chat" | "markers" | "proxy" | "hq", over: Record<string, unknown> = {}) {
  return {
    kind,
    status: "pending" as const,
    percent: 0,
    downloadedSec: 0,
    totalSec: 0,
    downloadedBytes: 0,
    etaSec: null,
    ...over,
  };
}

const base = { streamId: "s1", markers: null, hasSource: true, revision: 1 };

Deno.test("view: a RUNNING artifact is never onDisk (the instant-checkmark bug)", () => {
  // The downloader opens its destination file immediately, so a stat
  // succeeds while bytes are still arriving. Reporting that as "on disk" is
  // what made a fresh manual download show a checkmark and no bar.
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "running",
      includeProxy: false,
      parts: [part("proxy", { status: "running", percent: 0.02 })],
      presence: { proxy: { onDisk: true, bytes: 3_100_000, path: "/d/video.mp4" } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.onDisk, false, "a growing file must not read as on disk");
  assertEquals(video.status, "running");
  assertEquals(video.bytes, 3_100_000, "bytes still reported (the size is real)");
  assertEquals(video.percent, 0.02, "the bar has real progress");
  assertEquals(view.active, true, "active drives the container");
});

Deno.test("view: a DONE artifact is onDisk with its bytes", () => {
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: false,
      parts: [part("proxy", { status: "done", percent: 1, downloadedSec: 18200, totalSec: 18200 })],
      presence: { proxy: { onDisk: true, bytes: 2_657_409_065, path: "/d/video.mp4" } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.onDisk, true);
  assertEquals(video.bytes, 2_657_409_065);
  assertEquals(video.status, "done");
  assertEquals(view.active, false);
});

Deno.test("view: active is true the instant a run starts, before any part runs", () => {
  // The gap between run() starting and the first part flipping must already
  // read as active, or the Library container appears a poll late.
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "running",
      includeProxy: false,
      parts: [part("chat", { status: "pending" }), part("proxy", { status: "pending" })],
      presence: {},
    }),
  });
  assertEquals(view.active, true, "a running phase is active even with no running part yet");
  assertEquals(view.label, "downloading");
});

Deno.test("view: active is true whenever ANY artifact runs", () => {
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "running",
      parts: [
        part("chat", { status: "running" }),
        part("proxy", { status: "pending" }),
        part("hq", { status: "pending" }),
      ],
      presence: {},
    }),
  });
  assertEquals(view.active, true);
  assertEquals(view.artifacts.find((a) => a.kind === "chat")!.status, "running");
});

Deno.test("view: markers are metadata, never an artifact row", () => {
  const view = projectDownloadView({
    ...base,
    markers: [{ t: 12, label: "game change", source: "twitch" }],
    state: state({
      phase: "done",
      includeProxy: false,
      parts: [part("markers", { status: "done", percent: 1 })],
      presence: { proxy: { onDisk: true, bytes: 100, path: "/d/video.mp4" } },
    }),
  });
  assertEquals(view.artifacts.some((a) => (a.kind as string) === "markers"), false,
    "markers must not appear as a download artifact");
  assertEquals(view.metadata.markers?.length, 1);
});

Deno.test("view: absent markers render as null, not an empty row", () => {
  const view = projectDownloadView({
    ...base,
    markers: null,
    state: state({ phase: "idle" }),
  });
  assertEquals(view.metadata.markers, null);
  // A project with nothing downloaded still shows its chat and video rows —
  // those rows are where the Download buttons live, so hiding them would
  // remove the ability to fetch the artifact at all.
  assertEquals(view.artifacts.map((a) => a.kind), ["chat", "proxy", "video"]);
  assertEquals(view.artifacts.every((a) => a.onDisk === false), true);
  assertEquals(view.artifacts.every((a) => a.status === "pending"), true);
});

Deno.test("view: a project with no proxy file has NO proxy row (single-download)", () => {
  // Single-download mode writes ONE file. Presenting it as both a proxy and
  // a video row is what let the video row's trash delete the proxy's media.
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: false,
      parts: [part("proxy", { status: "done", percent: 1 }), part("hq", { status: "skipped", percent: 1 })],
      presence: { proxy: { onDisk: true, bytes: 500, path: "/d/video.mp4" } },
    }),
  });
  const kinds = view.artifacts.map((a) => a.kind);
  assertEquals(kinds.includes("video"), true);
  // The proxy row is offered (the project has a source), but it must NOT
  // claim a file: single-download mode has no proxy artifact on disk.
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;
  assertEquals(proxy.onDisk, false, "no phantom FILE for a proxy that does not exist");
  assertEquals(proxy.bytes, 0);
});

Deno.test("view: two-file mode yields distinct proxy and video rows with no sharing", () => {
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: true,
      parts: [
        part("proxy", { status: "done", percent: 1 }),
        part("hq", { status: "done", percent: 1 }),
      ],
      presence: {
        proxy: { onDisk: true, bytes: 500, path: "/d/proxy.mp4" },
        hq: { onDisk: true, bytes: 2000, path: "/d/hq.mp4" },
      },
    }),
  });
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(proxy.onDisk, true);
  assertEquals(video.onDisk, true);
  assertEquals(proxy.sharedWith, [], "distinct files are not shared");
  assertEquals(video.sharedWith, []);
  assertEquals(proxy.bytes, 500);
  assertEquals(video.bytes, 2000, "sizes land on the right row");
});

Deno.test("view: playback resolves to the PROXY for review, the video for render", () => {
  // Both present → review plays the proxy (it lands first, it scrubs cheaply).
  const both = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: true,
      parts: [part("proxy", { status: "done" }), part("hq", { status: "done" })],
      presence: {
        proxy: { onDisk: true, bytes: 1, path: "/d/proxy.mp4" },
        hq: { onDisk: true, bytes: 2, path: "/d/hq.mp4" },
      },
    }),
  });
  assertEquals(both.media.playablePath, "/d/proxy.mp4", "the proxy is the review source");
  assertEquals(both.media.renderPath, "/d/hq.mp4", "the video is the render source");
  assertEquals(both.media.previewOnly, false, "a video exists, so exports are possible");

  // Two-file mode with the VIDEO deleted: only the proxy survives → the
  // project plays at preview quality and exports are impossible.
  const proxyOnly = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: true,
      parts: [part("proxy", { status: "done" }), part("hq", { status: "pending" })],
      presence: { proxy: { onDisk: true, bytes: 1, path: "/d/proxy.mp4" } },
    }),
  });
  assertEquals(proxyOnly.media.playablePath, "/d/proxy.mp4");
  assertEquals(proxyOnly.media.renderPath, null, "nothing to render from");
  assertEquals(proxyOnly.media.previewOnly, true, "proxy-only must be flagged for the export warning");

  // Single-download mode: the one file IS the video, so it is not preview-only.
  const single = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: false,
      parts: [part("proxy", { status: "done" })],
      presence: { proxy: { onDisk: true, bytes: 1, path: "/d/video.mp4" } },
    }),
  });
  assertEquals(single.media.playablePath, "/d/video.mp4");
  assertEquals(single.media.renderPath, "/d/video.mp4", "the one file is both surfaces");
  assertEquals(single.media.previewOnly, false, "the single file is the video, not a preview");

  // Nothing at all → no playback.
  const none = resolvePlayback([]);
  assertEquals(none.playablePath, null);
  assertEquals(none.renderPath, null);
  assertEquals(none.previewOnly, false);
});

Deno.test("view: label composes from the running artifact and names failures", () => {
  const running = projectDownloadView({
    ...base,
    state: state({
      phase: "running",
      includeProxy: false,
      parts: [part("proxy", { status: "running", percent: 0.42 })],
      presence: {},
    }),
  });
  assertEquals(running.label, "video · 42%");

  const failed = projectDownloadView({
    ...base,
    state: state({
      phase: "failed",
      includeProxy: true,
      parts: [part("hq", { status: "failed", error: "network" })],
      presence: {},
    }),
  });
  assertEquals(failed.label, "interrupted: Video");

  assertEquals(composeLabel({ phase: "done", active: false, artifacts: [] }), "download complete");
  assertEquals(composeLabel({ phase: "idle", active: false, artifacts: [] }), "");
});

Deno.test("view: a MISSING artifact keeps its row so it can be downloaded again", () => {
  // Regression: a row-visibility rule of "only if a file, running, or failed"
  // hid every missing artifact — and the row is where the Download button
  // lives, so the user lost the ability to re-fetch anything.
  const empty = projectDownloadView({ ...base, state: state({ phase: "idle" }) });
  assertEquals(empty.artifacts.map((a) => a.kind), ["chat", "proxy", "video"]);
  for (const a of empty.artifacts) {
    assertEquals(a.onDisk, false);
    assertEquals(a.removable, false, "nothing to remove");
  }
  assertEquals(empty.artifacts.find((a) => a.kind === "video")!.downloadable, true);

  // Same for a project whose video was deleted but which still has chat.
  const deleted = projectDownloadView({
    ...base,
    state: state({
      phase: "done",
      includeProxy: true,
      parts: [
        part("chat", { status: "done", percent: 1 }),
        part("proxy", { status: "done", percent: 1 }),
        part("hq", { status: "pending" }),
      ],
      chatPath: "/d/chat.json",
      presence: {
        chat: { onDisk: true, bytes: 248_000, path: "/d/chat.json" },
        proxy: { onDisk: true, bytes: 500, path: "/d/proxy.mp4" },
      },
    }),
  });
  const videoRow = deleted.artifacts.find((a) => a.kind === "video")!;
  assertEquals(videoRow.onDisk, false, "the deleted video has no file");
  assertEquals(videoRow.downloadable, true, "but offers a re-download");
  assertEquals(deleted.media.previewOnly, true, "and the project is flagged preview-only");
});

Deno.test("view: a project WITH a source offers a proxy row even in single-download mode", () => {
  // The row is where the control to ADD a proxy lives. Hiding it in
  // single-download mode left no way to add one later.
  const view = projectDownloadView({
    ...base,
    hasSource: true,
    state: state({
      phase: "idle",
      includeProxy: false,
      parts: [part("proxy", { status: "pending" }), part("hq", { status: "pending" })],
      presence: {},
    }),
  });
  assertEquals(view.artifacts.map((a) => a.kind), ["chat", "proxy", "video"]);
  const proxy = view.artifacts.find((a) => a.kind === "proxy")!;
  assertEquals(proxy.onDisk, false, "no file yet");
  assertEquals(proxy.downloadable, true, "and it can be downloaded");
});

Deno.test("view: a source-less project shows no proxy row (nothing to fetch it from)", () => {
  const view = projectDownloadView({
    ...base,
    hasSource: false,
    state: state({ phase: "idle", includeProxy: false, parts: [part("proxy", { status: "pending" })] }),
  });
  assertEquals(view.artifacts.map((a) => a.kind), ["chat", "video"],
    "a local-folder project has no proxy download path");
});

Deno.test("view: a MANUAL video piece reports running (the Cancel button's source)", () => {
  // A manual video piece runs in the `hq` part even on a project whose mode
  // has no separate proxy. Mapping the video artifact to the (idle) `proxy`
  // part hid the Cancel button while a download was actually running.
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "running",
      includeProxy: false, // no separate proxy in this project
      parts: [
        part("chat", { status: "done", percent: 1 }),
        part("proxy", { status: "done", percent: 1 }),
        part("hq", { status: "running", percent: 0.4 }),
      ],
      presence: { proxy: { onDisk: true, bytes: 100, path: "/d/video.mp4" } },
    }),
  });
  const video = view.artifacts.find((a) => a.kind === "video")!;
  assertEquals(video.status, "running", "the running hq part must surface on the video row");
  assertEquals(video.percent, 0.4);
  assertEquals(view.active, true);
});

Deno.test("view: a failed video piece surfaces as failed for resume", () => {
  const view = projectDownloadView({
    ...base,
    state: state({
      phase: "failed",
      includeProxy: false,
      parts: [
        part("proxy", { status: "done", percent: 1 }),
        part("hq", { status: "failed", error: "network", percent: 0.2 }),
      ],
      presence: { proxy: { onDisk: true, bytes: 100, path: "/d/video.mp4" } },
    }),
  });
  assertEquals(view.artifacts.find((a) => a.kind === "video")!.status, "failed");
});

Deno.test("view: downloadable/removable gate the row actions", () => {
  const withSource = projectDownloadView({
    ...base,
    hasSource: true,
    state: state({
      phase: "failed",
      includeProxy: false,
      parts: [part("proxy", { status: "failed", error: "x" })],
      presence: {},
    }),
  });
  const v = withSource.artifacts.find((a) => a.kind === "video")!;
  assertEquals(v.downloadable, true);
  assertEquals(v.removable, true, "a failed download offers resume/delete");

  const noSource = projectDownloadView({
    ...base,
    hasSource: false,
    state: state({ phase: "idle" }),
  });
  // The rows still render (so the missing state is visible), but the
  // Download affordance is disabled without a stream link to fetch from.
  assertEquals(noSource.artifacts.map((a) => a.kind), ["chat", "video"]);
  assertEquals(noSource.artifacts.every((a) => a.downloadable === false), true);
});
