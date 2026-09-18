/**
 * Projects orchestrator state into the UI view model.
 *
 * Every rule a display used to re-derive lives here exactly once:
 * - a running artifact is never `onDisk` (a growing file is not an artifact);
 * - `active` is true whenever ANY artifact runs;
 * - one video file is never presented as two artifacts;
 * - markers are metadata, not a download.
 *
 * The single-download case is explicit, not inferred: in that mode the
 * orchestrator's `proxy` PART carries the main video (one file serves the
 * project), so part kinds alone cannot identify artifacts. `state.includeProxy`
 * decides the shape.
 */
import {
  ARTIFACT_LABELS,
  composeLabel,
  computeSharing,
  resolvePlayback,
  type ArtifactKind,
  type ArtifactView,
  type DownloadView,
  type PartStatus,
} from "@/application/view/download-view.ts";
import type { DownloadPart, DownloadState } from "@/adapters/outbound/vod/download-orchestrator.ts";

/** The state part that carries a given artifact, per download mode. */
function partForArtifact(
  kind: ArtifactKind,
  parts: Map<DownloadPart["kind"], DownloadPart>,
  includeProxy: boolean,
): DownloadPart | undefined {
  if (kind === "chat") return parts.get("chat");
  if (kind === "proxy") return includeProxy ? parts.get("proxy") : undefined;
  // The main video. The orchestrator records a video download in the `hq`
  // part — including a MANUAL video piece, which can run on a project whose
  // mode has no separate proxy. Prefer whichever part is actually carrying
  // the video so a running download is never reported as idle (that hid the
  // Cancel button: the row read the idle `proxy` part while `hq` ran).
  const primary = includeProxy ? parts.get("hq") : parts.get("proxy");
  const secondary = includeProxy ? parts.get("proxy") : parts.get("hq");
  if (primary?.status === "running") return primary;
  if (secondary?.status === "running") return secondary;
  if (primary?.status === "failed") return primary;
  if (secondary?.status === "failed") return secondary;
  return primary ?? secondary;
}

/** Disk truth for an artifact, from the state's stat-based presence map. */
function presenceForArtifact(
  kind: ArtifactKind,
  presence: NonNullable<DownloadState["presence"]>,
  includeProxy: boolean,
): { onDisk: boolean; bytes: number; path: string | null } {
  if (kind === "chat") return presence.chat ?? { onDisk: false, bytes: 0, path: null };
  if (kind === "proxy") {
    return includeProxy
      ? (presence.proxy ?? { onDisk: false, bytes: 0, path: null })
      : { onDisk: false, bytes: 0, path: null };
  }
  if (includeProxy) return presence.hq ?? { onDisk: false, bytes: 0, path: null };

  // Single-download mode: there is ONE video file, and WHICH SLOT HOLDS IT depends on
  // how it arrived. The pipeline records it in the proxy slot (the one file carries the
  // main video), while a manual video piece records it in the hq slot. Reading only the
  // proxy slot therefore reported a freshly re-downloaded video as ABSENT: the file was
  // on disk at 101MB while the row said `pending`, `bytes: 0`, and offered a Download
  // button that "finished in seconds without downloading" — it was re-fetching a file
  // that already existed, because the view never saw it.
  //
  // So prefer whichever slot actually holds a file, and keep the mode's primary when
  // neither does so the absent state still names the path a download would fill.
  const hq = presence.hq;
  const proxy = presence.proxy;
  if (hq?.onDisk) return hq;
  if (proxy?.onDisk) return proxy;
  return proxy ?? hq ?? { onDisk: false, bytes: 0, path: null };
}

export interface ProjectInput {
  streamId: string;
  state: DownloadState;
  /** Markers for the project (null when the VOD has none / not fetched). */
  markers: { t: number; label: string; source: string }[] | null;
  /** Project has a source URL, so pieces can be (re)downloaded. */
  hasSource: boolean;
  /** Monotonic revision for change detection. */
  revision: number;
}

export function projectDownloadView(input: ProjectInput): DownloadView {
  const { state } = input;
  const presence = state.presence ?? {};
  const includeProxy = state.includeProxy ?? false;
  const parts = new Map<DownloadPart["kind"], DownloadPart>();
  for (const p of state.parts) parts.set(p.kind, p);

  const artifacts: ArtifactView[] = [];
  for (const kind of ["chat", "proxy", "video"] as const) {
    const part = partForArtifact(kind, parts, includeProxy);
    const art = presenceForArtifact(kind, presence, includeProxy);
    // Which artifacts this PROJECT has at all. Chat and the main video are
    // always part of a project, so a MISSING one still gets a row — that row
    // is where its Download button lives, and hiding it removes the ability
    // to fetch the artifact again. The proxy is different: it only exists
    // when the project opted into two-file mode or a proxy file is present,
    // so a single-download project never shows a phantom proxy row.
    // The proxy row is offered whenever the project CAN have one — that is,
    // whenever it has a source to download from. Hiding it in single-download
    // mode left no way to ADD a proxy later (the row is where the control
    // lives); the user asked for exactly that ability.
    const expected = kind === "chat" || kind === "video"
      ? true
      : includeProxy || art.onDisk || input.hasSource;
    if (!expected) continue;

    const status: PartStatus = part?.status ?? (art.onDisk ? "done" : "pending");
    // A running artifact is NEVER "on disk": its file is growing, not an
    // artifact. This rule makes a fresh download show a bar, not a checkmark.
    const onDisk = art.onDisk && status !== "running";
    artifacts.push({
      kind,
      label: ARTIFACT_LABELS[kind],
      status,
      percent: part?.percent ?? (onDisk ? 1 : 0),
      etaSec: part?.etaSec ?? null,
      bytes: art.bytes,
      frontierSec: kind === "chat" ? null : (part?.downloadedSec ?? null),
      totalSec: kind === "chat" ? null : (part?.totalSec || null),
      onDisk,
      path: art.path,
      sharedWith: [],
      error: part?.error ?? null,
      downloadable: kind !== "chat" && input.hasSource,
      removable: art.onDisk || status === "failed",
    });
  }

  // File sharing: one path claimed by several artifacts. Displays use this
  // so a trash action never deletes a sibling artifact's media.
  const sharing = computeSharing(artifacts);
  for (const a of artifacts) {
    if (!a.path) continue;
    a.sharedWith = (sharing.get(a.path) ?? []).filter((k) => k !== a.kind);
  }

  // `active` = a download is happening. It must be true the instant a run
  // starts, before the first part flips to running (a container that waits
  // for a part reads as "nothing happening" for the first poll window).
  // "starting" counts as active: a container must appear the moment a download is
  // registered, which is the point of the phase — the client's first poll can arrive
  // before the downloader writes its first real state.
  const active =
    state.phase === "running" ||
    state.phase === "starting" ||
    artifacts.some((a) => a.status === "running");
  const view: DownloadView = {
    streamId: input.streamId,
    phase: state.phase,
    active,
    label: "",
    overall: { percent: state.overall.percent, etaSec: state.overall.etaSec },
    artifacts,
    media: resolvePlayback(artifacts),
    metadata: { markers: input.markers, chatCount: state.chatCount },
    revision: input.revision,
    updatedAt: new Date().toISOString(),
  };
  view.label = composeLabel({ phase: view.phase, active, artifacts });
  return view;
}
