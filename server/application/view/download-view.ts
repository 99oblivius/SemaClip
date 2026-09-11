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
  phase: "idle" | "running" | "done" | "failed";
  /** ANY artifact running — the single "show progress" flag. */
  active: boolean;
  /** Server-composed status line for the container header. */
  label: string;
  overall: { percent: number; etaSec: number | null };
  artifacts: ArtifactView[];
  /** Playback resolution: video if present, else the proxy (preview only). */
  media: {
    playablePath: string | null;
    /** True when only the proxy exists — exports are not possible. */
    previewOnly: boolean;
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

/** Playback resolution: the video is canonical, the proxy is a preview. */
export function resolvePlayback(artifacts: ArtifactView[]): DownloadView["media"] {
  const video = artifacts.find((a) => a.kind === "video");
  const proxy = artifacts.find((a) => a.kind === "proxy");
  const videoPlayable = video?.onDisk ? video.path : null;
  const proxyPlayable = proxy?.onDisk ? proxy.path : null;
  return {
    playablePath: videoPlayable ?? proxyPlayable ?? null,
    previewOnly: !videoPlayable && Boolean(proxyPlayable),
    frontierSec: video?.frontierSec ?? proxy?.frontierSec ?? 0,
    durationSec: video?.totalSec ?? proxy?.totalSec ?? null,
  };
}
