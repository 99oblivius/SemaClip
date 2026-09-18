/**
 * Download VIEW MODEL — the single contract every UI surface renders.
 *
 * The orchestrator owns download state; this module projects that state into
 * what a display needs, so no component has to derive, join, or guess. Each
 * field here exists because a display previously got it wrong by computing
 * it locally:
 *
 * - `active`  — one boolean for "a download is happening". The Library
 *   container, settings rows and any badge read THIS; deriving it per
 *   component is what made a container appear only after a page refresh.
 * - `onDisk`  — a COMPLETE artifact exists. A growing file is never "on
 *   disk", which is what made a fresh manual download instantly show a
 *   checkmark with no progress bar.
 * - `sharedWith` — artifact files that are the SAME file. In single-download
 *   mode the video file served both roles; without this the HQ row's trash
 *   deleted the proxy's media.
 * - `label`   — server-composed status text, so "what am I resuming?" has
 *   one answer instead of five renderings.
 * - `metadata` — non-download project data (markers, chat count). Markers
 *   are a GQL fetch, not bytes: never a download row, and absent on many
 *   VODs.
 */

export type ArtifactKind = "chat" | "proxy" | "video";
export type PartStatus = "pending" | "running" | "done" | "failed" | "skipped";

export interface ArtifactView {
  kind: ArtifactKind;
  /** Display label ("Chat", "Proxy", "Video"). */
  label: string;
  status: PartStatus;
  /** 0..1 — bar width. Always live while running. */
  percent: number;
  etaSec: number | null;
  /** Bytes on disk (real stat). Grows during a download; never a claim. */
  bytes: number;
  /** Video: media seconds downloaded. */
  frontierSec: number | null;
  totalSec: number | null;
  /** A COMPLETE artifact exists — never true for a growing file. */
  onDisk: boolean;
  path: string | null;
  /** Other artifacts whose file IS this artifact's file (single-download). */
  sharedWith: ArtifactKind[];
  error: string | null;
  /** Video artifacts can be (re)downloaded when the project has a source. */
  downloadable: boolean;
  removable: boolean;
}

export interface DownloadView {
  streamId: string;
  /** "starting" is a download that has been registered and is about to run. */
  phase: "starting" | "idle" | "running" | "done" | "failed";
  /** ANY artifact running — the single "show progress" flag. */
  active: boolean;
  /** Server-composed status line for the container header. */
  label: string;
  overall: { percent: number; etaSec: number | null };
  artifacts: ArtifactView[];
  /** Playback resolution: video if present, else the proxy (preview only). */
  media: {
    /** What REVIEW plays: the proxy when it exists (fast preview), else the video. */
    playablePath: string | null;
    /** What EXPORT renders from: the video, or null when only a preview exists. */
    renderPath: string | null;
    /** True when no video exists — exports are not possible. */
    previewOnly: boolean;
    /** The playable file is still being written (drives the player's frontier). */
    playableIsGrowing: boolean;
    frontierSec: number;
    durationSec: number | null;
  };
  /** Project metadata that is NOT a download (markers, chat volume). */
  metadata: {
    markers: { t: number; label: string; source: string }[] | null;
    chatCount: number;
  };
  /** Monotonic counter — lets a client detect change without deep compares. */
  revision: number;
  updatedAt: string;
}

export const ARTIFACT_LABELS: Record<ArtifactKind, string> = {
  chat: "Chat",
  proxy: "Proxy",
  video: "Video",
};

/** Human status line for the container header. */
export function composeLabel(view: {
  phase: DownloadView["phase"];
  active: boolean;
  artifacts: ArtifactView[];
}): string {
  if (view.phase === "done") return "download complete";
  if (view.phase === "idle") return "";
  if (view.phase === "failed") {
    const failed = view.artifacts.filter((a) => a.status === "failed").map((a) => a.label);
    return failed.length > 0 ? `interrupted: ${failed.join(", ")}` : "interrupted";
  }
  const running = view.artifacts.find((a) => a.status === "running");
  if (!running) return "downloading";
  const pct = Math.round(running.percent * 100);
  return `${running.label.toLowerCase()} · ${pct}%`;
}

/**
 * Which artifact's file is shared with which. A single-download project has
 * ONE video file; nothing else may alias it. Kept as a function (not baked
 * into the state) so the ownership rule has exactly one definition.
 */
export function computeSharing(artifacts: ArtifactView[]): Map<string, ArtifactKind[]> {
  const byPath = new Map<string, ArtifactKind[]>();
  for (const a of artifacts) {
    if (!a.path) continue;
    const list = byPath.get(a.path) ?? [];
    list.push(a.kind);
    byPath.set(a.path, list);
  }
  return byPath;
}

/**
 * Playback resolution: the video is canonical, the proxy is a preview.
 *
 * `onDisk` means COMPLETE and nothing else — a running download must never claim it,
 * because the downloader opens its destination immediately and a stat succeeds while
 * bytes are still arriving. But completeness is not what playback needs. The whole
 * point of the fragmented MP4 pipeline is that the growing file IS playable: index at
 * the front, and the frontier is the seek ceiling. Gating playback on `onDisk` meant
 * nothing was playable until a multi-GB download finished, so the Review page fell
 * back to streaming straight from Twitch — reported as "the preview still streams
 * from the url instead of the proxy or video being downloaded".
 *
 * So a RUNNING artifact whose file exists is playable up to its frontier. `onDisk`
 * keeps its meaning everywhere else, and `previewOnly` still describes export
 * capability rather than what can be watched.
 */
export function resolvePlayback(artifacts: ArtifactView[]): DownloadView["media"] {
  const video = artifacts.find((a) => a.kind === "video");
  const proxy = artifacts.find((a) => a.kind === "proxy");

  // Playable = a real file exists that the media route can open. A complete artifact
  // qualifies, and so does one currently being written: the pipeline guarantees it is
  // seekable up to frontierSec.
  const playable = (a?: ArtifactView): string | null => {
    if (!a?.path) return null;
    if (a.onDisk) return a.path;
    return a.status === "running" && a.bytes > 0 ? a.path : null;
  };

  const videoPlayable = playable(video);
  const proxyPlayable = playable(proxy);
  // REVIEW PLAYBACK SERVES THE PROXY. That is what a proxy is FOR: it lands in a
  // fraction of the time, so previewing and marking clips starts almost immediately
  // while the full-quality video is still downloading, and scrubbing a 540p file costs
  // a fraction of the I/O. The video is the RENDER source (exports hard-require it),
  // which is why `renderPath` reports it separately.
  //
  // An earlier revision preferred the video here, which made the low-quality copy
  // unreachable (the entire reason the proxy is downloaded first) and made deleting the
  // video look like a no-op, because the same duration kept streaming from the proxy.
  // Both symptoms belonged to the preference, not to the proxy.
  const chosen = proxyPlayable ?? videoPlayable;

  // How far into `chosen` playback may seek. A running artifact reports its frontier; a
  // COMPLETE one is its full duration. The project duration is the fallback for a
  // complete artifact that never recorded its own totalSec — without it a finished file
  // reported frontier 0, which dimmed the entire timeline for a fully downloaded project.
  const durationSec = video?.totalSec ?? proxy?.totalSec ?? null;
  // Which artifact carries the media being watched. Prefer the PLAYABLE one; when nothing is
  // playable yet (the first seconds of a download) fall back to whichever artifact is RUNNING.
  //
  // The fallback is the fix for a missing scrub indicator: in a no-proxy download the video
  // artifact is the growing file, but at the instant a client asks there may be no playable
  // path yet, and this reported the PROXY (the idle, empty one) — so the whole timeline read as
  // complete and neither the not-yet-downloaded area nor the moving cursor was drawn. Selecting
  // a proxy resolution hid the bug, because then the chosen artifact is the proxy and it is
  // genuinely the growing one.
  const runningVideo = video?.status === "running" && (video.bytes ?? 0) > 0;
  const runningProxy = proxy?.status === "running" && (proxy.bytes ?? 0) > 0;
  const chosenArtifact = chosen !== null && chosen === proxyPlayable
    ? proxy
    : videoPlayable !== null
      ? video
      : runningVideo
        ? video
        : runningProxy
          ? proxy
          : video ?? proxy;
  const frontier = chosenArtifact?.onDisk
    ? (chosenArtifact.totalSec ?? durationSec ?? chosenArtifact.frontierSec ?? 0)
    : (chosenArtifact?.frontierSec ?? 0);

  return {
    playablePath: chosen,
    /** What export renders from: the video, or null when only a preview exists. */
    renderPath: videoPlayable,
    // Only meaningful for exports, which hard-require the video file. Requires
    // something playable: an EMPTY project is not "preview only", it is empty, and
    // `!videoPlayable` alone reported a project with no files at all as preview-only.
    previewOnly: Boolean(chosen) && !videoPlayable,
    // Whether the file review plays is still being written. The player drives its stall
    // detector off the frontier of the file it is ACTUALLY playing — reading the video's
    // bytes once made a still-growing proxy look complete.
    playableIsGrowing: Boolean(chosen) && chosenArtifact?.onDisk !== true,
    frontierSec: frontier,
    durationSec,
  };
}
