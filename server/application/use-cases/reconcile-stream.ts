/**
 * Stream record ↔ disk reconciliation.
 *
 * The user OWNS the artifact folder: dragging a file in, deleting one, or
 * moving/renaming one inside `{cacheDir}/vods/{streamId}` is a legitimate,
 * expected action. A path stored in the database is therefore a CLAIM, and
 * disk is the truth — the same second-owner bug class behind "the deleted
 * file still plays" and "the chat file is not picked up".
 *
 * Reconciliation runs both ways on every read:
 * - a recorded `vod_path`/`chat_path` whose file is gone is DROPPED;
 * - a file that appeared with no record is ADOPTED (first video by name
 *   becomes the video; `chat.json` attaches chat).
 *
 * Chat has a second source (the download state), so the two are merged: the
 * stream record is repaired from the state when the state knows better, and
 * either side is cleared when its file is gone.
 */

export interface ReconcileableStream {
  id: string;
  vodPath: string;
  chatPath?: string | null | undefined;
}

export interface ArtifactDirScan {
  /** Video files present, already ordered (first = the video). */
  videos: string[];
  /** `chat.json` path when present. */
  chat: string | null;
}

/** Containers the app treats as playable video, best first. */
export const VIDEO_EXTENSIONS = [".mp4", ".mkv", ".webm", ".mov", ".ts"] as const;

/** Names that are never the "main" video (they are proxies/download parts). */
const NON_VIDEO_NAMES = [
  "proxy.mp4", "proxy.ts", "hq.mp4", "hq.ts", "video.ts",
  "scrub.mp4", "scrub.ts",
];

function isVideoName(name: string): boolean {
  const lower = name.toLowerCase();
  if (!VIDEO_EXTENSIONS.some((e) => lower.endsWith(e))) return false;
  if (NON_VIDEO_NAMES.includes(lower)) return false;
  // Fragment index sidecars are not media.
  if (lower.endsWith(".fragments")) return false;
  return true;
}

/**
 * Pick the main video from a directory listing. Container preference decides
 * (mp4 before mkv before webm before mov before raw ts), then name order, so
 * the choice is deterministic rather than directory-order dependent.
 */
export function pickVideo(names: string[]): string | null {
  const candidates = names.filter(isVideoName);
  if (candidates.length === 0) return null;
  const rank = (n: string) => {
    const lower = n.toLowerCase();
    const i = VIDEO_EXTENSIONS.findIndex((e) => lower.endsWith(e));
    return i === -1 ? VIDEO_EXTENSIONS.length : i;
  };
  return [...candidates].sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))[0]!;
}

export interface ReconcileResult {
  /** The repaired stream record (null when nothing changed). */
  stream: ReconcileableStream | null;
  /** What was changed, for logging/tests. */
  dropped: string[];
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
  if (!vodPath && scan) {
    // Only adopt when the recorded video is absent — a user who deliberately
    // set a vodPath keeps it.
    const candidate = scan.videos[0] ?? null;
    if (candidate) {
      vodPath = candidate;
      adopted.push(candidate);
      changed = true;
    }
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
