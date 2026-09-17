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
 * WHAT IT DOES NOT DO: apply on Windows. There the patch downloads and stages
 * but the launcher never swaps it in (a loaded DLL cannot be replaced in
 * place), so Windows users stay on their installed version. Deno's docs say to
 * treat Windows auto-update as unsupported; the project accepted an external
 * updater as the workaround. The status is surfaced in-app rather than hidden,
 * so a Windows user is not shown "update ready" forever with nothing happening.
 */
const CHANNEL = Deno.env.get("SEMACLIP_CHANNEL") === "stable" ? "stable" : "nightly";

/** One update check per 6h — frequent enough for a nightly channel, not a poll. */
const INTERVAL_MS = 6 * 60 * 60 * 1000;

export interface UpdateStatus {
  /** Version baked into THIS binary, or null in a dev run. */
  current: string | null;
  channel: string;
  /** Set once a patch is staged and waiting for the next launch. */
  pendingVersion: string | null;
  /** Set when the PREVIOUS launch failed and the launcher rolled it back. */
  lastRollback: string | null;
  /** Applying updates is macOS/Linux only — Windows stages but never swaps. */
  canApply: boolean;
}

const status: UpdateStatus = {
  current: (Deno as { desktopVersion?: string | null }).desktopVersion ?? null,
  channel: CHANNEL,
  pendingVersion: null,
  lastRollback: null,
  canApply: Deno.build.os !== "windows",
};

export function updateStatus(): UpdateStatus {
  return { ...status };
}

/**
 * Starts the updater. Safe to call unconditionally: it is inert under
 * `deno run` and on a build with no release.baseUrl configured.
 */
export function startAutoUpdate(baseUrl?: string): void {
  if (!status.current) {
    console.log("Updates: disabled (no version baked in — dev run)");
    return;
  }
  // deno.json's desktop.release.baseUrl is baked into the binary; an explicit
  // arg or env override lets a build be pointed at a different channel without
  // recompiling (useful for testing the updater itself).
  const url = baseUrl ?? Deno.env.get("SEMACLIP_UPDATE_URL");
  if (!url) {
    console.log("Updates: disabled (no release baseUrl configured)");
    return;
  }

  const autoUpdate = (Deno as {
    autoUpdate?: (opts: {
      url: string;
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

  console.log(`Updates: ${CHANNEL} channel, current ${status.current}${url ? `, polling ${url}` : ""}`);
  if (!status.canApply) {
    console.warn("Updates: Windows cannot apply staged updates (launcher swap unsupported)");
  }

  // Manifest signing: when a public key is configured the manifest must be a
  // signed envelope. Left unset until a key exists, so unsigned manifests keep
  // working today — see docs/CODE-SIGNING.md.
  const publicKey = Deno.env.get("SEMACLIP_UPDATE_PUBKEY");

  // Fire-and-forget: a failed update check must never prevent the app from
  // serving. autoUpdate() already swallows non-2xx responses internally.
  autoUpdate({
    url,
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
  }).catch((err) => {
    console.warn("Updates: check failed —", err instanceof Error ? err.message : err);
  });
}
