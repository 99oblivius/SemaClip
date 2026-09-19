/**
 * Update the INSTALLED AppImage by replacing the file itself.
 *
 * ── WHY NOT THE RUNTIME'S OWN UPDATER ─────────────────────────────────────────────────────
 * `Deno.autoUpdate` stages a patch as `<dylib>.update` BESIDE THE DYLIB — `get_dylib_path()`
 * resolves via `dladdr`, the path of the loaded `.so`. Inside an AppImage that is
 * `/tmp/.mount_XXXX/SemaClip.so`, a read-only squashfs mount, so the write fails:
 *
 *     Failed to write update to /tmp/.mount_SemaClaGEgia/SemaClip.so.update:
 *     Read-only file system (os error 30)
 *
 * That is upstream's documented behaviour ("does not work for read-only or system-owned installs —
 * an AppImage mounted read-only") and there is no env var or hook to relocate the staging path, so
 * there is nothing to fix in-process.
 *
 * ── THE OWNER'S CHOICE ───────────────────────────────────────────────────────────────────
 * "I don't need or want fusefs updating. I'm content with reinstalling as a whole appimage unto its
 * location." So: download the published `.AppImage` and REPLACE THE FILE, in place, at its own path.
 * Keeping the same path is also what stops the launcher accumulating duplicates — the file name is
 * what AppImageLauncher keys on. The runtime exports `APPIMAGE` (its own absolute path; verified in
 * the type-2 runtime source's two `setenv("APPIMAGE", fullpath, 1)` sites), which is the path to
 * replace. `APPDIR` is available as a fallback for an extracted run.
 *
 * The swap runs from a DETACHED helper: a running AppImage cannot overwrite its own image, and the
 * AppImage's FUSE mount must be released first. The helper waits for this process to exit, renames
 * the staged file onto the target (same directory, so it is atomic), and relaunches.
 */
import { downloadVerified } from "@/adapters/outbound/platform/update-download.ts";

/** Where the swap helper and the downloaded artifact are staged. */
export function stateDir(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  const base = env("XDG_DATA_HOME") ?? `${env("HOME") ?? ""}/.local/share`;
  return `${base}/SemaClip`;
}

/**
 * The absolute path of the running AppImage, or null when not running from one.
 *
 * `APPIMAGE` is set by the runtime for both launch paths (FUSE and extract-and-run). `APPDIR` is the
 * mount or extraction directory and is used only as a fallback, since the FILE to replace is the
 * AppImage and not the tree inside it.
 */
export function appImagePath(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): string | null {
  if (Deno.build.os !== "linux") return null;
  const direct = env("APPIMAGE");
  if (direct && direct.length > 0) return direct;
  // Extract-and-run sets APPDIR to the extraction root, beside which the original file is not
  // necessarily present — so this is a fallback only, and the swap is skipped when it is used
  // without an APPIMAGE, because replacing a directory is not the same operation.
  return null;
}

export interface SwapPlan {
  /** The AppImage file to replace. */
  target: string;
  /** Where the downloaded artifact is written before the swap. */
  staged: string;
  /** The helper that performs the swap after this process exits. */
  helper: string;
}

/**
 * Paths used by the swap.
 *
 * THE STAGED FILE MUST LIVE BESIDE THE TARGET, IN THE SAME DIRECTORY. The first version put it in
 * `~/.local/share/SemaClip`, which is usually a different filesystem from where the AppImage sits:
 * `mv` across filesystems is a copy-then-delete, so an interruption leaves a PARTIALLY WRITTEN
 * AppImage at the target path — the one outcome that must never happen, since the user would have no
 * working app. Same directory makes the swap an atomic rename. A test caught this by asserting the
 * two paths share a parent; it is not a style preference.
 *
 * The helper goes in the same directory for the same reason, and because it has to survive being
 * written while the app is about to exit.
 */
export function swapPlan(appImage: string, _env?: (k: string) => string | undefined): SwapPlan {
  const cut = appImage.lastIndexOf("/");
  const dir = cut > 0 ? appImage.slice(0, cut) : ".";
  return {
    target: appImage,
    staged: `${dir}/.SemaClip-update.AppImage`,
    helper: `${dir}/.SemaClip-apply-update.sh`,
  };
}

/**
 * The helper's body. A shell script rather than our own binary because it has to keep working after
 * the program's own files are replaced, and `sh` is present anywhere an AppImage can run.
 *
 * It waits for the OLD pid to disappear before swapping, so a slow shutdown cannot be raced; the
 * `mv` is same-directory (atomic rename) so there is never a moment with no app present; and it
 * relaunches detached. Re-running it with no staged file just relaunches what is there.
 */
export function swapScriptBody(plan: SwapPlan, pid: number): string {
  return `#!/bin/sh
# Apply a downloaded SemaClip AppImage over the installed one, then relaunch it.
# Written by the app at update time. Safe to re-run.
set -u

PID=${pid}
TARGET="${plan.target}"
STAGED="${plan.staged}"

# Wait for the app to exit. Bounded so a stuck process cannot hang this forever.
i=0
while [ "$i" -lt 600 ]; do
  kill -0 "$PID" 2>/dev/null || break
  sleep 0.1
  i=$((i + 1))
done

if [ -f "$STAGED" ]; then
  # Same filesystem: an atomic rename. A cross-device mv would copy-then-delete, which can leave a
  # partial file, so the staged artifact is deliberately kept in the same directory as the target.
  if mv -f "$STAGED" "$TARGET" 2>/dev/null; then
    chmod +x "$TARGET" 2>/dev/null || true
  fi
fi

# Relaunch detached: closing this script must not take the app down with it.
nohup "$TARGET" >/dev/null 2>&1 &
exit 0
`;
}

export interface AppImageUpdateResult {
  /** True when a download happened and a swap is waiting for this process to exit. */
  staged: boolean;
  /** The version that will be installed. */
  version: string | null;
  /** Why it did not happen, when it did not. Never swallowed. */
  error: string | null;
}

/**
 * Download the published AppImage and stage it for a swap on exit.
 *
 * Verification is mandatory: the manifest's sha256 is the only thing standing between a user and a
 * corrupted 108MB binary replacing a working one. A mismatch aborts and leaves the installed file
 * untouched.
 */
export async function downloadAndStageAppImage(
  manifestUrl: string,
  version: string,
  entry: { name: string; sha256: string; url?: string },
  log: (msg: string) => void = (m) => console.log(m),
  onProgress?: (p: { received: number; total: number; fraction: number | null }) => void,
): Promise<AppImageUpdateResult> {
  const appImage = appImagePath();
  if (!appImage) {
    return { staged: false, version: null, error: "not running from an AppImage (no APPIMAGE set)" };
  }
  const plan = swapPlan(appImage);

  // The URL is recorded explicitly: the payload lives in the release, not beside the manifest, so
  // resolving the name against the manifest's own directory would 404.
  const base = manifestUrl.replace(/\/[^/]*$/, "");
  const url = entry.url ?? `${base}/${entry.name}`;

  try {
    // The target's own directory, which exists by definition: the AppImage is running from it.
    const parent = plan.staged.replace(/\/[^/]*$/, "");
    await Deno.mkdir(parent, { recursive: true }).catch(() => {});

    // STREAMED, not buffered. This used to be `new Uint8Array(await res.arrayBuffer())`, which held
    // the entire 100MB payload in memory and reported nothing while it did — the UI looked hung for
    // exactly as long as the download took. The writer is the same one Windows uses now, so both
    // platforms have one download path, one progress signal and one verification point.
    const res = await downloadVerified(url, plan.staged, entry.sha256, {
      log,
      ...(onProgress ? { onProgress } : {}),
    });
    if (!res.ok) {
      return { staged: false, version: null, error: res.error ?? "download failed" };
    }
    await Deno.chmod(plan.staged, 0o755);
    log(`Updates: staged ${version} (${(res.bytes / 1e6).toFixed(0)}MB, sha256 verified)`);

    await Deno.writeTextFile(plan.helper, swapScriptBody(plan, Deno.pid));
    await Deno.chmod(plan.helper, 0o755);

    return { staged: true, version, error: null };
  } catch (err) {
    return { staged: false, version: null, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Run the swap helper detached, so it can replace this process's own image after it exits.
 *
 * `Deno.Command` rather than the project's `spawnChild`: `spawnChild` exists to hide consoles and
 * manage stdio for Windows children, and its `RunOptions` has no way to detach — a helper that dies
 * with its parent cannot swap anything, because the parent is the thing that must exit first. Stdio
 * is fully detached too, so the helper cannot hold this process's pipes open and delay its exit.
 */
export function launchSwapHelper(): boolean {
  const appImage = appImagePath();
  if (!appImage) return false;
  const plan = swapPlan(appImage);
  try {
    const cmd = new Deno.Command(plan.helper, {
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    cmd.spawn().unref();
    return true;
  } catch {
    return false;
  }
}
