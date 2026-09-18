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
 * out to a real per-user file, along with a launcher that runs it. Per-user is not a
 * preference: the install directory is `%ProgramFiles%\SemaClip` (the MSI's own
 * `ALLUSERS=1`), which is not writable.
 *
 * ── WHAT THIS DOES NOT DO ────────────────────────────────────────────────────────
 * It does not replace the shortcut the MSI created. Rewriting a machine-wide shortcut
 * needs elevation, which an app must not silently demand. The extracted launcher is
 * offered instead and reported through `UpdateStatus.sidecarPath`, so the UI can name
 * exactly what the user runs and nothing is claimed on their behalf.
 */
import { join } from "node:path";

/** The name the sidecar ships under inside the bundle. */
export const SIDECAR_NAME = "SemaClipUpdater.exe";

/** The launcher offered beside it: runs the updater, which applies then relaunches. */
export const LAUNCHER_NAME = "Launch SemaClip (updates).cmd";

/** Where the embedded updater lives in the payload's virtual filesystem. */
const EMBEDDED_DIR = new URL("../../../appfiles/", import.meta.url);

/**
 * The launcher is written from a string rather than shipped as a second embedded file:
 * it is four lines, it must sit beside the extracted updater to work, and a file that
 * only ever exists on the user's disk has no reason to travel in the payload.
 *
 * `%*` forwards arguments (the updater takes `-check`, `-force`, `-no-launch`). `%~dp0`
 * is the launcher's own directory, which is where the updater was extracted.
 */
export const LAUNCHER_CONTENT = `@echo off
REM Apply any staged SemaClip update, then relaunch the app.
REM
REM Windows cannot replace a loaded DLL while the app runs, so Deno.autoUpdate only
REM STAGES an update here. SemaClipUpdater.exe performs the swap while the app is
REM closed. Run with no arguments it applies any pending update, relaunches the app and
REM waits, so starting SemaClip through this file makes updates land on their own.
setlocal
set "DIR=%~dp0"
"%DIR%${SIDECAR_NAME}" %*
`;

export interface SidecarState {
  /** Absolute path of the extracted updater, or null when it could not be placed. */
  path: string | null;
  /** Absolute path of the launcher, or null. */
  launcherPath: string | null;
  /** True when this call wrote the updater (false = already present and current). */
  extracted: boolean;
  /** Why extraction failed, when it did. Never swallowed. */
  error: string | null;
}

/**
 * Per-user directory for the extracted updater, its launcher and its state.
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

/** The launcher's full path. */
export function launcherPath(env?: (k: string) => string | undefined): string {
  return `${sidecarDir(env)}\\${LAUNCHER_NAME}`;
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
 * Writes the bundled updater and its launcher to per-user paths.
 *
 * Windows only, and idempotent: a second launch is two stats and a return. Everything
 * is reported — an install where this fails cannot update itself, and that must be
 * visible rather than a silent no-op.
 */
export async function ensureSidecar(opts: { force?: boolean } = {}): Promise<SidecarState> {
  const none: SidecarState = { path: null, launcherPath: null, extracted: false, error: null };
  if (Deno.build.os !== "windows") return none;

  const dest = sidecarPath();
  const launcher = launcherPath();
  try {
    const bundled = await Deno.readFile(new URL(SIDECAR_NAME, EMBEDDED_DIR));
    await Deno.mkdir(sidecarDir(), { recursive: true });

    let existingSize: number | null = null;
    try {
      existingSize = (await Deno.stat(dest)).size;
    } catch {
      existingSize = null;
    }

    if (!opts.force && !needsExtraction(existingSize, bundled.byteLength)) {
      return { path: dest, launcherPath: launcher, extracted: false, error: null };
    }

    // Atomic: a crash mid-write must not leave a truncated updater a later launch
    // would happily run.
    const tmp = `${dest}.tmp`;
    await Deno.writeFile(tmp, bundled);
    await Deno.rename(tmp, dest);
    // Written every time the updater is: the two must match, and the launcher is tiny.
    await Deno.writeTextFile(launcher, LAUNCHER_CONTENT);
    return { path: dest, launcherPath: launcher, extracted: true, error: null };
  } catch (err) {
    return { ...none, error: err instanceof Error ? err.message : String(err) };
  }
}
