/**
 * Auto-update wiring for the packaged desktop app.
 *
 * Deno.autoUpdate() is a NO-OP under `deno run` — a non-compiled program has no
 * baked-in version (Deno.desktopVersion is null), so it warns once and returns
 * without throwing. That is deliberate and useful: the same entrypoint serves
 * dev and release, and nothing here needs guarding for development.
 *
 * WHAT IT DOES: ONCE, at startup — about a second after this call — fetches
 * <baseUrl>/latest.json, downloads a bsdiff patch for the currently-installed version,
 * verifies it against the manifest's mandatory sha256, applies it to the runtime dylib
 * and stages the result. It does NOT poll: no `interval` is passed, so there is exactly
 * one check per launch, which is the requested policy. The RUNNING process is untouched;
 * the launcher swaps the update in on the next start, and rolls back automatically if
 * the new version fails to launch.
 *
 * WHAT IT DOES NOT DO BY ITSELF: apply on Windows. Deno's launcher cannot swap a
 * loaded DLL, so there the runtime only stages the patch and the BUNDLED SIDECAR
 * (tools/updater) installs it while the app is closed — that is the shipped
 * workaround, and `canApply: false` is what tells the UI to explain it. The
 * status is surfaced in-app rather than hidden, so a Windows user is not shown
 * "update ready" forever with nothing happening.
 */
import { ensureSidecar } from "@/adapters/outbound/platform/sidecar.ts";
import { bakedVersion } from "@/adapters/outbound/platform/app-version.ts";
import {
  appImagePath,
  downloadAndStageAppImage,
  launchSwapHelper,
} from "@/adapters/outbound/platform/appimage-update.ts";
import { emitAppEvent } from "@/application/events.ts";

/**
 * NO POLLING INTERVAL, deliberately. `interval` is what keeps the runtime checking; omitting it
 * leaves exactly one check, run about a second after this call. The owner asked for updates to be
 * checked when the app opens and never elsewhere, and that is precisely this behaviour — the
 * runtime's own type declaration says "A single check runs ~1s after the call; pass `interval` to
 * keep polling."
 *
 * This used to poll every 6 hours, which also meant a long-running session could stage an update
 * while the user was in the middle of something. One check per launch is both the requested policy
 * and the less surprising one.
 */

/**
 * Base64 Ed25519 public key for signed manifests. Empty = unsigned manifests
 * (the current state). This MUST be a literal in the source: `deno desktop` does
 * not carry environment variables into the compiled binary, so a getenv() here
 * would read undefined in production while appearing to work in dev.
 */
const UPDATE_PUBLIC_KEY = "";

export interface UpdateStatus {
  /** Version baked into THIS binary, or null in a dev run. */
  current: string | null;
  /** Set once an update is downloaded and waiting for the next launch to install it. */
  pendingVersion: string | null;
  /** Set when the PREVIOUS launch failed and the launcher rolled it back. */
  lastRollback: string | null;
  /**
   * Whether a staged update installs itself. Linux AppImages DO: the artifact is downloaded and
   * swapped over the file by a helper on exit (this app's own mechanism). Windows does NOT: the
   * bundled sidecar has to be run while the app is closed.
   */
  canApply: boolean;
  /** Linux: the AppImage being updated, when running from one. */
  appImagePath: string | null;
  /** Why the AppImage update could not be done, when it could not. */
  appImageError: string | null;
  /**
   * Windows: the updater that can apply a staged update, and the launcher that runs it.
   * Null elsewhere, and null here when extraction failed (then `sidecarError` says why).
   * The UI names these so a user is told what to run rather than shown a promise the
   * platform cannot keep.
   */
  sidecarPath: string | null;
  sidecarLauncherPath: string | null;
  /** Why the sidecar could not be placed, when it could not. Never swallowed. */
  sidecarError: string | null;
}

const baked = bakedVersion();

const status: UpdateStatus = {
  current: baked?.version ?? null,
  pendingVersion: null,
  lastRollback: null,
  // Linux AppImages apply their own update on exit; Windows cannot (the sidecar does it).
  canApply: Deno.build.os !== "windows",
  appImagePath: appImagePath(),
  appImageError: null,
  sidecarPath: null,
  sidecarLauncherPath: null,
  sidecarError: null,
};

export function updateStatus(): UpdateStatus {
  return { ...status };
}


/**
 * Base URL used when neither an argument nor an env override is supplied.
 *
 * Duplicated from `deno.json`'s `desktop.release.baseUrl` rather than read at runtime: the env is not
 * carried into a compiled binary, and on Linux the runtime's own URL handling is bypassed entirely.
 */
const DEFAULT_MANIFEST_URL = "https://99oblivius.github.io/SemaClip/latest.json";

/**
 * Check the manifest ONCE at startup and, if a newer version is published, download and stage it.
 *
 * This is the whole Linux policy: "on opening the app the releases are polled for an update", with
 * no further checks until the next launch. A failure is reported, never swallowed — the previous
 * behaviour was a silent no-op, which is why the owner saw nothing on Linux.
 */
async function checkAndStageAppImage(
  manifestUrl: string,
): Promise<{ staged: boolean; reason?: string; error?: string }> {
  const appImage = appImagePath();
  if (!appImage) {
    return { staged: false, reason: "not running from an AppImage; nothing to update" };
  }
  if (!status.current) {
    return { staged: false, reason: "no version baked in (dev run)" };
  }

  let manifest: { version?: string; artifacts?: Record<string, { name: string; sha256: string; url?: string }> };
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { staged: false, error: `manifest fetch failed: HTTP ${res.status}` };
    manifest = await res.json();
  } catch (err) {
    return { staged: false, error: `manifest fetch failed: ${err instanceof Error ? err.message : err}` };
  }

  const latest = manifest.version;
  if (!latest) return { staged: false, error: "manifest has no version" };
  if (latest === status.current) {
    return { staged: false, reason: `up to date (${status.current})` };
  }

  const entry = manifest.artifacts?.["linux-x64"];
  if (!entry) {
    return { staged: false, error: `manifest has no linux-x64 artifact (published ${latest})` };
  }

  console.log(`Updates: ${status.current} -> ${latest}, downloading the AppImage`);
  const result = await downloadAndStageAppImage(manifestUrl, latest, entry);
  if (!result.staged) {
    return { staged: false, error: result.error ?? "download failed" };
  }
  status.pendingVersion = latest;
  emitAppEvent({ type: "update-staged", version: latest, canApplyByRestart: true });
  return { staged: true };
}

/**
 * Install a staged AppImage update and restart, from the UI.
 *
 * The helper waits for THIS process to exit before replacing the file, so the sequence is: start the
 * helper, then quit. Reported as started rather than done, because the process ends immediately.
 */
export function applyAppImageUpdate(): { restarting: boolean; error: string | null } {
  if (!status.pendingVersion) return { restarting: false, error: "no update is staged" };
  if (!launchSwapHelper()) return { restarting: false, error: "could not start the swap helper" };
  // Quit so the helper can take the file. Deferred slightly so this response is flushed first.
  setTimeout(() => Deno.exit(0), 250);
  return { restarting: true, error: null };
}

/**
 * Starts the updater. Safe to call unconditionally: it is inert under
 * `deno run` and on a build with no release.baseUrl configured.
 */
export async function startAutoUpdate(baseUrl?: string): Promise<void> {
  if (!status.current) {
    console.log("Updates: disabled (no version baked in — dev run)");
    return;
  }
  console.log(`Updates: version ${status.current} (from ${baked?.source})`);

  // WINDOWS FIRST: the updater's swap needs a real file outside the payload's virtual
  // filesystem, and this is the only process that can read the embedded copy. Doing it
  // before the autoUpdate() call means the check's outcome is always actionable, and
  // it is cheap — a stat on every launch after the first.
  if (Deno.build.os === "windows") {
    const sc = await ensureSidecar();
    status.sidecarPath = sc.path;
    status.sidecarLauncherPath = sc.launcherPath;
    status.sidecarError = sc.error;
    if (sc.path) {
      console.log(
        `Updates: sidecar ${sc.extracted ? "placed" : "present"} at ${sc.path}` +
          (sc.launcherPath ? ` (run ${sc.launcherPath} to apply updates)` : ""),
      );
    } else {
      // The one combination that cannot self-update. Say so plainly.
      console.warn(
        `Updates: Windows sidecar could not be placed — staged updates cannot be applied. ${sc.error ?? ""}`,
      );
    }
  }
  // LINUX: the runtime's own updater CANNOT work from an AppImage, so this does the check and the
  // download itself. See appimage-update.ts for the mechanism and the measurement.
  if (Deno.build.os === "linux") {
    // Same override the runtime's own call honours, resolved here because the Linux path does not
    // go through that call at all.
    const manifestUrl = baseUrl ?? Deno.env.get("SEMACLIP_UPDATE_URL") ?? DEFAULT_MANIFEST_URL;
    const res = await checkAndStageAppImage(manifestUrl);
    if (res.error) {
      status.appImageError = res.error;
      console.warn(`Updates: ${res.error}`);
    } else if (!res.staged && res.reason) {
      console.log(`Updates: ${res.reason}`);
    }
    // The runtime's own updater is deliberately NOT started here: it stages beside the dylib, which
    // is a read-only mount inside an AppImage, so every launch would log a failure and change
    // nothing. Doing the check ourselves is what makes "check at open" true on Linux.
    return;
  }

  // deno.json's desktop.release.baseUrl is baked into the binary and
  // Deno.autoUpdate() DEFAULTS to it ("This is the only server URL the runtime
  // polls automatically ... defaults to this URL, but can override it per call").
  // So the absence of an explicit url is NOT a reason to disable the updater —
  // requiring one here made the whole feature dead in every packaged build, which
  // logged "Updates: disabled (no release baseUrl configured)" while the manifest
  // it should have been polling answered 200. An arg or env var only OVERRIDES.
  const override = baseUrl ?? Deno.env.get("SEMACLIP_UPDATE_URL");

  const autoUpdate = (Deno as {
    autoUpdate?: (opts: {
      /** Optional: the runtime falls back to the baked desktop.release.baseUrl. */
      url?: string;
      interval?: number;
      publicKey?: string;
      onUpdateReady?: (v: string) => void;
      onRollback?: (reason: string) => void;
    }) => Promise<void>;
  }).autoUpdate;

  if (!autoUpdate) {
    console.log("Updates: Deno.autoUpdate unavailable in this runtime");
    return;
  }

  console.log(
    `Updates: current ${status.current}, polling ` +
      `${override ?? "the baseUrl baked into this build"}`,
  );
  if (!status.canApply) {
    console.warn("Updates: Windows cannot apply staged updates (launcher swap unsupported)");
  }

  // Manifest signing: when a public key is configured the manifest must be a
  // signed envelope. Read from a COMPILE-TIME constant, never Deno.env —
  // measured: an env var set during `deno desktop` is NOT baked into the binary,
  // so a getenv() here returns undefined in every real install and signing would
  // silently stay off. To enable signing, paste the base64 key below (it is a
  // public key, so committing it is correct) — see docs/CODE-SIGNING.md.
  const publicKey = UPDATE_PUBLIC_KEY;

  // Fire-and-forget: a failed update check must never prevent the app from
  // serving. autoUpdate() already swallows non-2xx responses internally.
  //
  // It does NOT return a Promise — the runtime's own docs never chain `.catch()` and
  // the call yields `undefined`, so `autoUpdate({...}).catch(...)` throws
  // "TypeError: Cannot read properties of undefined (reading 'catch')" as an UNCAUGHT
  // desktop error on every single launch. Measured on a real AppImage. Any failure
  // reporting must come from the callbacks below, never from a promise.
  autoUpdate({
    // `url` is REQUIRED in the type but optional to the runtime when the build
    // carries a baseUrl, so only pass it when we are genuinely overriding.
    ...(override ? { url: override } : {}),
    // NO `interval`. Omitting it is what limits this to the single startup check; adding it back
    // starts polling and violates the "check on open only" policy.
    ...(publicKey ? { publicKey } : {}),
    onUpdateReady(version) {
      status.pendingVersion = version;
      console.log(`Updates: ${version} staged, applies on next launch`);
      // PUSHED, not polled: the user should be told the moment this happens so they can
      // choose to restart into it. `canApplyByRestart` is false on Windows, where the
      // runtime stages but cannot swap a loaded DLL — the UI must not offer a restart
      // that would silently do nothing.
      emitAppEvent({ type: "update-staged", version, canApplyByRestart: status.canApply });
    },
    onRollback(reason) {
      status.lastRollback = reason;
      console.warn("Updates: previous launch failed, rolled back —", reason);
      emitAppEvent({ type: "update-rollback", version: reason, canApplyByRestart: status.canApply });
    },
  });
}
