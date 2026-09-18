/**
 * Auto-update wiring for the packaged desktop app.
 *
 * Deno.autoUpdate() is a NO-OP under `deno run` — a non-compiled program has no
 * baked-in version (Deno.desktopVersion is null), so it warns once and returns
 * without throwing. That is deliberate and useful: the same entrypoint serves
 * dev and release, and nothing here needs guarding for development.
 *
 * WHAT IT DOES: polls <baseUrl>/latest.json, downloads a bsdiff patch for the
 * currently-installed version, verifies it against the manifest's mandatory
 * sha256, applies it to the runtime dylib and stages the result. The RUNNING
 * process is untouched; the launcher swaps the update in on the next start, and
 * rolls back automatically if the new version fails to launch.
 *
 * WHAT IT DOES NOT DO BY ITSELF: apply on Windows. Deno's launcher cannot swap a
 * loaded DLL, so there the runtime only stages the patch and the BUNDLED SIDECAR
 * (tools/updater) installs it while the app is closed — that is the shipped
 * workaround, and `canApply: false` is what tells the UI to explain it. The
 * status is surfaced in-app rather than hidden, so a Windows user is not shown
 * "update ready" forever with nothing happening.
 */
import { ensureSidecar } from "@/adapters/outbound/platform/sidecar.ts";

/** One update check per 6h: often enough to keep up with continuous development. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

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
  /** Set once a patch is staged and waiting for the next launch. */
  pendingVersion: string | null;
  /** Set when the PREVIOUS launch failed and the launcher rolled it back. */
  lastRollback: string | null;
  /** Applying updates is macOS/Linux only — Windows stages but never swaps. */
  canApply: boolean;
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

const status: UpdateStatus = {
  current: (Deno as { desktopVersion?: string | null }).desktopVersion ?? null,
  pendingVersion: null,
  lastRollback: null,
  canApply: Deno.build.os !== "windows",
  sidecarPath: null,
  sidecarLauncherPath: null,
  sidecarError: null,
};

export function updateStatus(): UpdateStatus {
  return { ...status };
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
    interval: INTERVAL_MS,
    ...(publicKey ? { publicKey } : {}),
    onUpdateReady(version) {
      status.pendingVersion = version;
      console.log(`Updates: ${version} staged, applies on next launch`);
    },
    onRollback(reason) {
      status.lastRollback = reason;
      console.warn("Updates: previous launch failed, rolled back —", reason);
    },
  });
}
