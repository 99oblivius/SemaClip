/**
 * Moving a project to a different folder.
 *
 * A project records where its media lives (`streams.project_dir`), and the user can point it
 * somewhere else — a new drive, a folder they moved it to, or the location it was originally
 * in before the drive was unmounted.
 *
 * ── WHAT MOVING DOES AND DOES NOT DO ──────────────────────────────────────────────────────
 * It does NOT move files. The user moved the folder (or the drive came back at a new mount
 * point); the app's job is to be told where it is and to agree. Copying gigabytes behind their
 * back is not what "change location" means, and a half-finished copy is worse than either
 * outcome.
 *
 * What it does:
 *   - records the new folder on the project;
 *   - repoints every artifact path that EXISTS in the new folder, so playback, export and the
 *     download state all refer to real files again;
 *   - leaves a recorded path alone when its file is NOT in the new folder, rather than
 *     replacing it with a guess. A project that has both a proxy and a video where only one
 *     arrived (still copying, or the other was deleted) keeps the one that is there.
 *
 * The rule is pure — the caller does the I/O — because "which paths get repointed" is exactly
 * the judgement that has been wrong before in this codebase (a proxy repointed as the video,
 * a stale path silently claimed). Being a pure function makes it testable without a disk.
 */

/** The state fields that hold an artifact path. Order is presentation order in the UI. */
export const STATE_PATH_KEYS = ["proxyPath", "proxyMp4", "hqPath", "hqMp4", "chatPath"] as const;
export type StatePathKey = (typeof STATE_PATH_KEYS)[number];

export interface StateLike {
  proxyPath?: string | null;
  proxyMp4?: string | null;
  hqPath?: string | null;
  hqMp4?: string | null;
  chatPath?: string | null;
  [key: string]: unknown;
}

/** The final path segment of a path, whichever separator it uses. */
export function basename(path: string): string {
  return path.replace(/^.*[\\/]/, "");
}

/** Everything before the final segment ("/a/b/c.mp4" → "/a/b"). */
export function dirname(path: string): string {
  return path.replace(/[\\/][^\\/]*$/, "");
}

export interface RePointResult {
  /** The state with repointed paths (a new object; the input is not mutated). */
  state: StateLike;
  /** Paths that were repointed, as [key, oldPath, newPath]. */
  repointed: [StatePathKey, string, string][];
  /** Paths left as they were because their file is not in the new folder. */
  kept: [StatePathKey, string][];
}

/**
 * Repoint a project's artifact paths into `newDir`.
 *
 * `exists` is injected (async) so this is testable and so a caller that already stat'd the
 * directory can answer from a cache instead of hammering the disk.
 *
 * A path is repointed ONLY when `{newDir}/{basename(oldPath)}` actually exists. That is the
 * whole safety property: the file's NAME is the identity (see artifact-naming.ts), so the
 * same filename in the new folder IS that artifact — and its absence means the move is
 * incomplete, which must not be papered over.
 */
export async function rePointPaths(
  state: StateLike,
  newDir: string,
  exists: (path: string) => Promise<boolean>,
): Promise<RePointResult> {
  const dir = newDir.replace(/[\\/]+$/, "");
  const next: StateLike = { ...state };
  const repointed: RePointResult["repointed"] = [];
  const kept: RePointResult["kept"] = [];

  for (const key of STATE_PATH_KEYS) {
    const current = state[key];
    if (typeof current !== "string" || current.length === 0) continue;
    // ALREADY THERE: compare the file's PARENT to the target folder. Comparing the whole path
    // to the directory was wrong — a file inside the new folder never equals the folder, so
    // every path already in place was "repointed" to itself and counted as a change.
    // Case-insensitive because Windows paths are, and a repoint that only differs in case is
    // not a change anyone wants reported.
    if (dirname(current).toLowerCase() === dir.toLowerCase()) continue;
    const candidate = `${dir}/${basename(current)}`;
    if (await exists(candidate)) {
      next[key] = candidate;
      repointed.push([key, current, candidate]);
    } else {
      kept.push([key, current]);
    }
  }

  return { state: next, repointed, kept };
}
