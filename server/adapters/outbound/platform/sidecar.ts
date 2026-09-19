/**
 * Windows update delivery: the bundled sidecar updater.
 *
 * ── THE PROBLEM ──────────────────────────────────────────────────────────────────
 * `deno desktop` cannot put a file beside the payload inside the MSI. Its `--include`
 * EMBEDS files into the compiled executable's virtual filesystem (measured: both
 * `appfiles/SemaClipUpdater.exe` and `appfiles/version.txt` are readable inside the
 * payload DLL, while the MSI's cabinet holds only the payload, the launcher and two
 * marker files). A separate process cannot read the VFS, and the MSI's shortcut
 * targets the app launcher directly.
 *
 * So the updater — which exists precisely because Deno's launcher cannot swap a loaded
 * DLL on Windows — was inert on every install: staged, never applied.
 *
 * ── THE FIX ──────────────────────────────────────────────────────────────────────
 * The app CAN read its own embedded files. So on Windows it writes the bundled updater
 * out to a real per-user file, alongside the state it records. Per-user is not a
 * preference: the install directory is `%ProgramFiles%\SemaClip` (the MSI's own
 * `ALLUSERS=1`), which is not writable.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────
 * It does not replace the shortcut the MSI created. Rewriting a machine-wide shortcut
 * needs elevation, which an app must not silently demand. The extracted updater is
 * offered instead and reported through `UpdateStatus.sidecarPath`, so the UI can name
 * exactly what the user runs and nothing is claimed on their behalf.
 */
import { join } from "node:path";

/** The name the sidecar ships under inside the bundle. */
export const SIDECAR_NAME = "SemaClipUpdater.exe";

/** Where the embedded updater lives in the payload's virtual filesystem. */
const EMBEDDED_DIR = new URL("../../../appfiles/", import.meta.url);

/**
 * The updater's own log, written inside the bundle by `tools/updater`.
 *
 * The app runs the updater detached with its output discarded (it is about to exit and cannot babysit
 * a console), so this file is the only account of what actually happened. Kept in sync with
 * `updateLogName` in tools/updater/main.go — the two must name the same file or the log is written
 * somewhere nothing reads.
 */
export const UPDATE_LOG_NAME = ".semaclip-update.log";

/** Absolute path of the updater's log, for the app to read back. */
export function updateLogPath(env?: (k: string) => string | undefined): string {
  return `${sidecarDir(env)}\\${UPDATE_LOG_NAME}`;
}

/**
 * The launcher an OLDER build wrote, kept as a name only so it can be deleted.
 *
 * Do not reintroduce this file. It existed so a user could apply an update by hand, because the app
 * could not start the updater itself. The app does that now — it spawns the updater detached with its
 * own pid and quits — so a launcher has no caller. The name survives purely so every install that
 * already has one has it removed rather than left stale.
 */
const RETIRED_LAUNCHER_NAME = "Launch SemaClip (updates).cmd";

/**
 * The app's own directory — where `version.txt` and the payload live.
 *
 * `Deno.execPath()` is the real path of the running binary in a compiled build (verified), so the
 * app can hand the updater an unambiguous target — the updater defaults to its OWN directory, which
 * for an installed build is a per-user extraction dir holding no payload.
 */
export function appDirPath(): string {
  const exe = Deno.execPath();
  const cut = exe.lastIndexOf("\\");
  return cut > 0 ? exe.slice(0, cut) : exe;
}

export interface SidecarState {
  /** Absolute path of the extracted updater, or null when it could not be placed. */
  path: string | null;
  /** True when this call wrote the updater (false = already present and current). */
  extracted: boolean;
  /** Why extraction failed, when it did. Never swallowed. */
  error: string | null;
}

/**
 * Per-user directory for the extracted updater and the state it records.
 *
 * Mirrors the Go updater's own `stateFilePath()` resolution (LOCALAPPDATA, then
 * USERPROFILE) so the two agree on one location instead of each inventing one.
 */
export function sidecarDir(env: (k: string) => string | undefined = (k) => Deno.env.get(k)): string {
  const local = env("LOCALAPPDATA") ?? `${env("USERPROFILE") ?? ""}\\AppData\\Local`;
  return `${local}\\SemaClip`;
}

/** The extracted updater's full path. */
export function sidecarPath(env?: (k: string) => string | undefined): string {
  return `${sidecarDir(env)}\\${SIDECAR_NAME}`;
}

/**
 * Whether the extracted copy needs rewriting.
 *
 * Compared by SIZE, not by timestamp or a version stamp: the updater deliberately never
 * updates itself (a running Windows image cannot overwrite its own file), so a given
 * installer always ships exactly one sidecar build. A size mismatch means a different
 * installer laid it down. A same-size file is assumed current, which also avoids
 * rewriting on every launch.
 */
export function needsExtraction(existingSize: number | null, bundledSize: number): boolean {
  if (existingSize === null) return true;
  return existingSize !== bundledSize;
}

/**
 * Writes the bundled updater to a per-user path.
 *
 * Windows only, and idempotent: a second launch is two stats and a return. Everything
 * is reported — an install where this fails cannot update itself, and that must be
 * visible rather than a silent no-op.
 */
export async function ensureSidecar(opts: { force?: boolean } = {}): Promise<SidecarState> {
  const none: SidecarState = { path: null, extracted: false, error: null };
  if (Deno.build.os !== "windows") return none;

  const dest = sidecarPath();
  try {
    // A launcher left by an older build is REMOVED, unconditionally and even on the
    // already-current path below. It was written by every install up to now, and leaving it behind
    // would strand a hand-run `.cmd` whose arguments the updater no longer needs — a second, stale
    // way to do what the app does itself.
    await Deno.remove(`${sidecarDir()}\\${RETIRED_LAUNCHER_NAME}`).catch(() => {});

    const bundled = await Deno.readFile(new URL(SIDECAR_NAME, EMBEDDED_DIR));
    await Deno.mkdir(sidecarDir(), { recursive: true });

    let existingSize: number | null = null;
    try {
      existingSize = (await Deno.stat(dest)).size;
    } catch {
      existingSize = null;
    }

    if (!opts.force && !needsExtraction(existingSize, bundled.byteLength)) {
      return { path: dest, extracted: false, error: null };
    }

    // Atomic: a crash mid-write must not leave a truncated updater a later launch
    // would happily run.
    const tmp = `${dest}.tmp`;
    await Deno.writeFile(tmp, bundled);
    await Deno.rename(tmp, dest);
    // NO LAUNCHER IS WRITTEN. It existed so a user could apply an update by hand, because the app
    // could not start the sidecar itself. It can now: it spawns the updater detached with its own
    // pid, quits, and the updater swaps and relaunches. A file whose only purpose was a manual step
    // that no longer exists is dead weight in every install.
    return { path: dest, extracted: true, error: null };
  } catch (err) {
    return { ...none, error: err instanceof Error ? err.message : String(err) };
  }
}
