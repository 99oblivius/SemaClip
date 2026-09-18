/**
 * Stream record ↔ disk reconciliation.
 *
 * The user OWNS the artifact folder: dragging a file in, deleting one, moving or renaming one
 * inside `{cacheDir}/vods/{streamId}` is a legitimate, expected action. A path stored in the
 * database is therefore a CLAIM; disk is the truth — the same second-owner bug class behind
 * "the deleted file still plays" and "the chat file is not picked up".
 *
 * Reconciliation runs both ways on every read:
 * - a recorded `vod_path`/`chat_path` whose file is gone is DROPPED;
 * - a file that appeared with no record is ADOPTED.
 *
 * WHAT EACH FIELD MEANS, exactly:
 * - `vodPath` is the RENDER SOURCE — the main video, never the proxy, never chat. An earlier
 *   revision let a completed proxy claim it (both the pipeline and the manual-piece path did),
 *   so deleting the video repointed the record at the 540p preview and Export would have
 *   rendered from it.
 * - `chatPath` is the chat JSON.
 * The proxy has no stream-record field: the download state owns it, and the view reads it from
 * there. A field with no writer cannot go stale.
 *
 * Artifacts are identified by ROLE, from the filename (`artifact-naming.ts`). Identity must not
 * depend on the download mode or on which part the downloader happens to be running: the mode
 * decides what to DOWNLOAD, not what a file IS.
 */
import {
  findArtifact,
  LEGACY_NAMES,
  ROLE_SUFFIX,
  type ArtifactRole,
} from "@/application/use-cases/artifact-naming.ts";

export interface ReconcileableStream {
  id: string;
  vodPath: string;
  chatPath?: string | null | undefined;
  title?: string | null | undefined;
  streamer?: string | null | undefined;
}

/** Which artifacts a directory holds, by absolute path. */
export interface ArtifactDirScan {
  video: string | null;
  proxy: string | null;
  chat: string | null;
}

/** Containers the app treats as playable video, best first. */
export const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".mov", ".ts"] as const;

/** Every filename this app recognises as one of its own artifacts, lowercase. */
function claimedNames(names: readonly string[]): Set<string> {
  const roles: ArtifactRole[] = ["video", "proxy", "chat", "video-index", "proxy-index"];
  const claimed = new Set<string>();
  for (const role of roles) {
    for (const legacy of LEGACY_NAMES[role]) claimed.add(legacy.toLowerCase());
  }
  // Project-named artifacts, claimed by the role SUFFIX their name ends with, so a name is
  // recognised whatever slug the project carries.
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const role of roles) {
      if (lower.endsWith(ROLE_SUFFIX[role])) claimed.add(lower);
    }
  }
  return claimed;
}

/**
 * Pick a video-looking file that is NOT one of the app's own artifacts.
 *
 * This is the "the user dragged their own recording into the folder" case: a foreign file must
 * still be adoptable as the project's video. It deliberately cannot see the app's artifacts —
 * the previous version chose purely by container preference and name order, so a real project
 * folder yielded `- proxy.mp4` as the project's main video, which would have made the 540p
 * preview the export source.
 */
export function pickVideo(names: readonly string[]): string | null {
  const claimed = claimedNames(names);
  const candidates = names.filter((n) => {
    const lower = n.toLowerCase();
    if (!VIDEO_EXTENSIONS.some((e) => lower.endsWith(e))) return false;
    return !claimed.has(lower);
  });
  if (candidates.length === 0) return null;
  const rank = (n: string) => {
    const lower = n.toLowerCase();
    const i = VIDEO_EXTENSIONS.findIndex((e) => lower.endsWith(e));
    return i === -1 ? VIDEO_EXTENSIONS.length : i;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]!;
}

/**
 * Identify each artifact role from a directory listing. Pure: the caller does the I/O, so the
 * rule is testable without a disk and the same function serves every caller.
 *
 * Precedence: a recognised role name first (the app's own artifact, identified by name), then a
 * foreign video file for the video role only (something the user dropped in). The proxy and chat
 * roles have no foreign fallback — only the app produces those, and guessing would resurrect the
 * bug where a stray file was adopted as the preview.
 */
export function scanArtifactNames(
  dir: string,
  names: readonly string[],
  slug: string | null,
): ArtifactDirScan {
  const at = (role: ArtifactRole): string | null => {
    const name = findArtifact(role, names, slug);
    return name ? `${dir}/${name}` : null;
  };
  const foreign = pickVideo(names);
  return {
    video: at("video") ?? (foreign ? `${dir}/${foreign}` : null),
    proxy: at("proxy"),
    chat: at("chat"),
  };
}

export interface ReconcileResult {
  /** The repaired stream record (null when nothing changed). */
  stream: ReconcileableStream | null;
  /** Paths that were recorded but are gone. */
  dropped: string[];
  /** Paths that appeared and were adopted. */
  adopted: string[];
}

/**
 * Repair a stream record against the artifact directory's actual contents.
 *
 * `exists` is injected so the rule is testable without touching a disk.
 */
export function reconcileStreamRecord(
  stream: ReconcileableStream,
  scan: ArtifactDirScan | null,
  exists: (path: string) => boolean,
): ReconcileResult {
  const dropped: string[] = [];
  const adopted: string[] = [];
  let vodPath = stream.vodPath ?? "";
  let chatPath = stream.chatPath ?? null;
  let changed = false;

  // ── Drop claims whose files are gone ──
  if (vodPath && !exists(vodPath)) {
    dropped.push(vodPath);
    vodPath = "";
    changed = true;
  }
  if (chatPath && !exists(chatPath)) {
    dropped.push(chatPath);
    chatPath = null;
    changed = true;
  }

  // ── Adopt files that appeared ──
  // `scan.video` is the VIDEO role specifically. Choosing "the first video-looking file"
  // adopted `- proxy.mp4` as the project's main video, which made the preview the render
  // source; the role decides, so that cannot happen.
  if (!vodPath && scan?.video) {
    vodPath = scan.video;
    adopted.push(scan.video);
    changed = true;
  }
  if (!chatPath && scan?.chat) {
    chatPath = scan.chat;
    adopted.push(scan.chat);
    changed = true;
  }

  if (!changed) return { stream: null, dropped: [], adopted: [] };
  return {
    stream: { ...stream, vodPath, chatPath },
    dropped,
    adopted,
  };
}
