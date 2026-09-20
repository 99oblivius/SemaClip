/**
 * Projects orchestrator state into the UI view model.
 *
 * Every rule a display used to re-derive lives here exactly once:
 * - a running artifact is never `onDisk` (a growing file is not an artifact);
 * - `active` is true whenever ANY artifact runs;
 * - one video file is never presented as two artifacts;
 * - a slot is named for what it holds, and its recorded file's name is what proves it;
 * - markers are metadata, not a download.
 *
 * ARTIFACT IDENTITY COMES FROM THE FILENAME, never from the download mode or from which part a
 * downloader happens to be running. `includeProxy` decides what an import DOWNLOADS; it says
 * nothing about what a file on disk IS. Trusting it for identity produced two live bugs: a
 * completed proxy reported as the video (at the proxy's size) while the proxy row claimed
 * nothing was on disk, and a proxy that could never be reported on disk at all unless the mode
 * happened to be set.
 *
 * A state slot is therefore resolved to an artifact by the path recorded in it, falling back to
 * the slot that artifact's download would fill. That keeps every project ever written readable
 * without a migration, including those whose single video was recorded under the proxy name.
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
import { pathFillsRole } from "@/application/use-cases/artifact-naming.ts";

/**
 * The state part that carries a given artifact.
 *
 * `hq` IS the main video and `proxy` IS the proxy — a part is named for the artifact it
 * writes, and nothing else. An earlier revision made the part a function of the download
 * MODE (in single-file mode the video was recorded in the `proxy` part) and then had to
 * guess which one was live: the video row read the proxy part, so a completed proxy
 * download was reported as the video, at the proxy's size, while the proxy row claimed
 * nothing was on disk.
 */
function partForArtifact(
  kind: ArtifactKind,
  parts: Map<DownloadPart["kind"], DownloadPart>,
  state: DownloadState,
): DownloadPart | undefined {
  if (kind === "chat") return parts.get("chat");
  const role = kind === "proxy" ? "proxy" : "video";

  // With no path recorded for either role there is nothing on disk to identify, so the run's
  // PLAN is the only evidence: `includeProxy` says whether this project also downloads a preview,
  // and a live part is producing whatever that plan says it produces. That is a statement about
  // the download, not about a file, so it does not reintroduce mode-based identity — and it only
  // applies in this window, before any artifact has been recorded.
  const unrecorded = !state.hqMp4 && !state.hqPath && !state.proxyMp4 && !state.proxyPath;
  if (unrecorded) {
    const hq = parts.get("hq");
    const proxy = parts.get("proxy");
    const live = (p: DownloadPart | undefined) =>
      p?.status === "running" || p?.status === "failed";
    if (role === "proxy") {
      return state.includeProxy && live(proxy) ? proxy : undefined;
    }
    if (live(hq)) return hq;
    // No separate proxy in the plan: whichever part carries the live download IS the video.
    if (!state.includeProxy && live(proxy)) return proxy;
    return hq;
  }
  return parts.get(slotForRole(state, role));
}

/**
 * Which state slot's recorded file fills a role.
 *
 * A slot is not trusted to mean what it is called: an earlier revision recorded the project's
 * single video in the `proxy` slot (and its manual video piece in `hq`), so the same artifact
 * can appear under either name. The recorded PATH decides, because the filename is the durable
 * fact — `- video.mp4` is the video wherever it was written down.
 *
 * Falls back to the slot a download of that role would fill, so an absent artifact still
 * resolves to the row whose Download button would produce it.
 */
function slotForRole(state: DownloadState, role: "video" | "proxy"): "hq" | "proxy" {
  // Both the state's recorded path and the presence map's stat'd path are candidates: an older
  // state recorded the video's path in the `proxy` fields, while the presence map is built from
  // whatever each slot currently holds.
  const recorded: Record<"hq" | "proxy", string | null> = {
    hq: state.hqMp4 ?? state.hqPath ?? state.presence?.hq?.path ?? null,
    proxy: state.proxyMp4 ?? state.proxyPath ?? state.presence?.proxy?.path ?? null,
  };
  const preferred: ("hq" | "proxy")[] = role === "video" ? ["hq", "proxy"] : ["proxy", "hq"];
  for (const slot of preferred) {
    const path = recorded[slot];
    if (path && pathFillsRole(path, role)) return slot;
  }
  return role === "video" ? "hq" : "proxy";
}

/**
 * Disk truth for an artifact, from the state's stat-based presence map.
 *
 * One artifact, one slot, and the slot is named for the artifact — but a slot alone is not
 * trusted, because states written by earlier revisions put the project's single video in the
 * `proxy` slot. Both slots can hold a file that is genuinely the video (a legacy single-file
 * download), and both can hold the proxy. So a file's ROLE comes from its NAME, which is the
 * durable fact: `- video.mp4` is the video wherever it was recorded, `- proxy.mp4` is the proxy.
 *
 * Consequence, and the point of doing it this way: a completed proxy is reported on disk in
 * EVERY mode. The previous version hardcoded the proxy absent unless `includeProxy` was set, so
 * downloading a proxy onto an existing project finished and then reported nothing.
 */
function presenceForArtifact(
  kind: ArtifactKind,
  state: DownloadState,
): { onDisk: boolean; bytes: number; path: string | null } {
  const presence = state.presence ?? {};
  if (kind === "chat") return presence.chat ?? { onDisk: false, bytes: 0, path: null };
  const role = kind === "proxy" ? "proxy" : "video";
  const slot = slotForRole(state, role);
  const art = presence[slot] ?? { onDisk: false, bytes: 0, path: null };
  // A slot holding a file that belongs to ANOTHER role is not this artifact. Without this the
  // proxy row claimed the video's bytes (single-file projects record the video in the proxy
  // slot), which is the aliasing that let one artifact's size be reported as another's.
  if (art.path && !pathFillsRole(art.path, role)) {
    // Deliberately no path: naming another artifact's file here is what produced the phantom
    // sharing ("the video is also the proxy"), which is the cross-deletion hazard the sharing
    // rule exists to prevent.
    return { onDisk: false, bytes: 0, path: null };
  }
  return art;
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
  /**
   * Whether the project's recorded folder exists, as measured by the caller (the only layer
   * with filesystem access). `null` when the project records no folder at all — see
   * `DownloadView.reachable` for why that is not the same as "missing".
   */
  reachable?: boolean | null;
  /**
   * This project's place in the full-VOD download queue, from the QUEUE's own snapshot — the
   * queue owns order, so nothing re-derives "how many are ahead of me" here.
   */
  queue?: { position: number; total: number } | null;
}

export function projectDownloadView(input: ProjectInput): DownloadView {
  const { state } = input;
  const parts = new Map<DownloadPart["kind"], DownloadPart>();
  for (const p of state.parts) parts.set(p.kind, p);

  const artifacts: ArtifactView[] = [];
  for (const kind of ["chat", "proxy", "video"] as const) {
    const part = partForArtifact(kind, parts, state);
    const art = presenceForArtifact(kind, state);
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
    const expected = kind === "chat" || kind === "video" || input.hasSource || art.onDisk;
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
    // Queued is ACTIVE: the project is work the app has accepted and not finished, so it
    // belongs in the Library's progress area. It is not "running" — nothing is transferring.
    state.phase === "queued" ||
    artifacts.some((a) => a.status === "running");
  const view: DownloadView = {
    streamId: input.streamId,
    phase: state.phase,
    active,
    reachable: input.reachable ?? null,
    queue: input.queue ?? null,
    label: "",
    overall: { percent: state.overall.percent, etaSec: state.overall.etaSec },
    artifacts,
    media: resolvePlayback(artifacts),
    metadata: { markers: input.markers, chatCount: state.chatCount },
    revision: input.revision,
    updatedAt: new Date().toISOString(),
  };
  view.label = composeLabel({ phase: view.phase, active, artifacts, reachable: view.reachable, queue: view.queue });
  return view;
}
