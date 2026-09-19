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
 * the app swaps the update in on the next start, and rolls back automatically if
 * the new version fails to launch.
 *
 * WHAT IT DOES NOT DO BY ITSELF: apply on Windows. Deno's launcher cannot swap a
 * loaded DLL, so there the runtime only stages the patch and the BUNDLED SIDECAR
 * (tools/updater) installs it while the app is closed — that is the shipped
 * workaround, and `canApply` is what would tell the UI to explain it. The
 * status is surfaced in-app rather than hidden, so a Windows user is not shown
 * "update ready" forever with nothing happening.
 */
import { ensureSidecar, appDirPath } from "@/adapters/outbound/platform/sidecar.ts";
import { bakedVersion } from "@/adapters/outbound/platform/app-version.ts";
import {
  appImagePath,
  downloadAndStageAppImage,
  launchSwapHelper,
} from "@/adapters/outbound/platform/appimage-update.ts";
import { sidecarDir, updateRecordPath } from "@/adapters/outbound/platform/sidecar.ts";
import { downloadVerified } from "@/adapters/outbound/platform/update-download.ts";
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
  /** Set once an update is DOWNLOADED and waiting for the next launch to install it. */
  pendingVersion: string | null;
  /** Set when the PREVIOUS launch failed and the launcher rolled it back. */
  lastRollback: string | null;
  /**
   * Whether a staged update installs itself. True on both platforms: Linux replaces the AppImage
   * from a helper, Windows hands the downloaded archive to the sidecar.
   */
  canApply: boolean;
  /**
   * True while the payload is being fetched, so the UI can say "do not close this window".
   *
   * A download that is in progress is NOT a pending update: `pendingVersion` stays null until the
   * bytes are on disk and verified, which is what keeps "an update is ready" honest.
   */
  downloading: boolean;
  /** Bytes received / total for the in-flight download, when one is running. */
  download: { version: string; received: number; total: number; fraction: number | null } | null;
  /**
   * Where the update currently is, for the UI to key its message on.
   *
   * "idle"        nothing happening
   * "downloading" the payload is being fetched NOW — keep the window open
   * "ready"       downloaded and verified, a restart installs it
   *
   * A single explicit field rather than the client inferring from `downloading`/`pendingVersion`:
   * a UI that has to reconstruct a state machine from two booleans gets the intermediate states
   * wrong, and this one has to say something different in each.
   */
  phase: "idle" | "downloading" | "ready";
  /**
   * The LAST thing that went wrong while checking for or fetching an update, or null.
   *
   * ── WHY THIS MUST NOT REUSE sidecarError ────────────────────────────────────────────────────
   * It used to. `checkWindowsUpdate` writes its errors into `sidecarError`, which means "this
   * install cannot update itself" — so a transient HTTP 500, a dropped connection mid-download or a
   * sha256 mismatch made the app report a PERMANENT limitation. Those are unrelated facts: the
   * updater can be perfectly placed and the check still fail, and only one of them is worth telling
   * the user about and worth retrying.
   *
   * Cleared when a check succeeds, so the banner cannot keep showing a stale failure after a retry
   * worked.
   */
  updateError: string | null;
  /**
   * Set when the PREVIOUS hand-off closed the app without completing its swap.
   *
   * ── WHY THIS IS NOT `updateError` ────────────────────────────────────────────────────────────
   * It shared that field at first, and a SUCCESSFUL check then erased it: `runUpdateCheck` clears
   * `updateError` on success (correct for a retry), so "up to date (26.245)" wiped the diagnosis of
   * the failed install one line after it was written. Verified on the guest — the warning reached
   * stderr and `/api/update` still answered with an empty error, so the banner showed nothing and the
   * loop stayed invisible.
   *
   * A successful CHECK says nothing about the previous APPLY. Only the next launch can clear this,
   * by the record matching again.
   */
  handoffError: string | null;
  /**
   * Windows: the updater that applies the downloaded payload. Null elsewhere, and null here when
   * extraction failed (then `sidecarError` says why).
   */
  sidecarPath: string | null;
  /** Why the sidecar could not be placed, when it could not. Never swallowed. */
  sidecarError: string | null;
  /**
   * The version whose payload is staged on disk, and its verified hash. Windows only.
   *
   * Kept in the status rather than re-derived at apply time: the sidecar is handed this exact path
   * and hash, so what it installs is provably what was downloaded and verified in this session.
   */
  stagedPath: string | null;
  stagedSha256: string | null;
}

const baked = bakedVersion();

const status: UpdateStatus = {
  current: baked?.version ?? null,
  pendingVersion: null,
  lastRollback: null,
  // BOTH platforms apply their own update on restart now. Linux replaces the AppImage file from a
  // helper; Windows starts the sidecar and quits, and the sidecar swaps the payload while the app is
  // closed. The previous `Deno.build.os !== "windows"` was true when Windows could only be told to
  // run a .cmd by hand, which is the manual step the sidecar exists to remove.
  canApply: true,
  downloading: false,
  download: null,
  phase: "idle",
  updateError: null,
  handoffError: null,
  sidecarPath: null,
  sidecarError: null,
  stagedPath: null,
  stagedSha256: null,
};

export function updateStatus(): UpdateStatus {
  // The banner reads `updateError`; the hand-off diagnosis is surfaced there so a failure that
  // survived a successful check is still shown. Kept as a separate FIELD internally because the two
  // have different lifetimes — see handoffError.
  return { ...status, updateError: status.updateError ?? status.handoffError };
}

/**
 * Compare the bundle's recorded version against the running build and record a failed hand-off.
 *
 * Exported with an optional path so the property can be tested against a seeded record rather than
 * the running bundle. Returns the diagnosis it set, for a caller that wants to assert on it.
 */
export async function reconcileRecordedVersion(recordPath?: string): Promise<string | null> {
  // A build with no version has nothing to compare against, and comparing would be actively wrong:
  // measured, a record of "null" (which is what gets written when this build has no version) produced
  // a diagnosis claiming the swap failed. A dev run must stay silent.
  if (!status.current) return null;
  const previous = await recordedVersion(recordPath);
  if (!previous || previous === status.current) return null;
  status.handoffError =
    `The last update did not install: this build is ${status.current} but the updater recorded ` +
    `${previous} as installed, so the swap did not complete. SemaClip will offer it again below.`;
  console.warn(`Updates: ${status.handoffError}`);
  return status.handoffError;
}

/**
 * The version the UPDATER recorded as installed in this bundle, or null.
 *
 * Read from the bundle's own `.semaclip-version`, which the updater writes INSIDE the app directory
 * after a successful swap (see tools/updater writeVersion). A record that disagrees with the running
 * binary is the signature of a failed hand-off: the app closed, the swap did not complete, and the
 * next launch is the old build again.
 *
 * Null covers three normal cases and they all mean "say nothing": the file is absent (never updated),
 * unreadable, or carries no version= line. A diagnosis must not invent a failure out of a missing
 * file, because every hand-unpacked zip starts that way.
 */
async function recordedVersion(recordPath?: string): Promise<string | null> {
  try {
    const raw = await Deno.readTextFile(recordPath ?? updateRecordPath());
    for (const line of raw.split("\n")) {
      const [key, value] = line.split("=");
      const v = value?.trim();
      // "null"/"undefined" are treated as absent: a build without a version writes its own
      // String(null) into the record, and reading that back as a version invented a failure.
      if (key?.trim() === "version" && v && v !== "null" && v !== "undefined") return v;
    }
  } catch {
    // No record: nothing to reconcile.
  }
  return null;
}

/** What a check or download reports back. Both platform paths already return this shape. */
interface CheckOutcome {
  error?: string | undefined;
  reason?: string | undefined;
  available?: boolean;
  staged?: boolean;
}

/** In-flight guard, so a retry cannot stack a second download on top of the first. */
let checking = false;

/**
 * How many times a TRANSIENT failure is retried before giving up, and the base backoff.
 *
 * Small and bounded on purpose: the payload is ~100MB, so a download retry is expensive, and the
 * check runs at open where a long silent stall is worse than a clear failure. 2 retries at 2s then
 * 4s costs at most ~6s of background work and is invisible while the app is usable.
 */
const CHECK_RETRIES = 2;
const DEFAULT_RETRY_BASE_MS = 2000;

/**
 * The backoff base, overridable ONLY so a test can run the retry policy instantly.
 *
 * Without this the retry tests spend their time waiting (2s + 4s per case, ~20s for this file), and a
 * slow suite gets skipped. Same seam the rest of this module already uses for tests
 * (`SEMACLIP_UPDATE_URL`, `SEMACLIP_DEV_HOOKS`, `SEMACLIP_DATA`); it cannot change a real install,
 * because nothing sets it outside a test process.
 */
function retryBaseMs(): number {
  const raw = Deno.env.get("SEMACLIP_UPDATE_RETRY_MS");
  if (raw === undefined) return DEFAULT_RETRY_BASE_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_RETRY_BASE_MS;
}

/**
 * Run one update check, recording what happened and retrying a transient failure.
 *
 * ── WHY ONE PLACE DOES THIS ──────────────────────────────────────────────────────────────────
 * Three callers need identical behaviour: the Windows check, the Linux check, and the user's retry.
 * Doing it in each is how the retry ends up with different semantics from the automatic path — the
 * same trap the banner's restart logic avoids by having one decision function.
 *
 * ── WHY RETRY AT ALL ────────────────────────────────────────────────────────────────────────
 * The check runs ONCE at open (the owner's policy), so a single transient failure — an HTTP 500 from
 * the release host, a connection dropped partway through a 100MB fetch — would otherwise mean no
 * update for the whole session. The retries are the ONLY chance the automatic path gets, which is
 * exactly why they are bounded and quiet: a permanent failure (no artifact for this platform) is not
 * retried at all.
 *
 * EXPORTED so the policy can be asserted against BEHAVIOUR — how many attempts a given failure gets,
 * and that a success clears the error — rather than against the source text, which cannot distinguish
 * a working predicate from one that is present but disabled.
 */
export async function runUpdateCheck(run: () => Promise<CheckOutcome>): Promise<void> {
  if (checking) return;
  checking = true;
  const attempts = 1 + CHECK_RETRIES;
  try {
    for (let attempt = 1; attempt <= attempts; attempt++) {
      let res: CheckOutcome;
      try {
        res = await run();
      } catch (err) {
        res = { error: err instanceof Error ? err.message : String(err) };
      }

      if (!res.error) {
        // SUCCESS CLEARS THE ERROR. Without this the banner would keep showing a failure that a
        // retry already fixed — a stale error is worse than none, because it is wrong.
        status.updateError = null;
        if (res.reason) console.log(`Updates: ${res.reason}`);
        return;
      }

      // A permanent condition is not worth retrying: this build has nothing to install from, and
      // retrying it would be noise. The message still reaches the user.
      if (isPermanent(res.error)) {
        status.updateError = res.error;
        console.warn(`Updates: ${res.error}`);
        return;
      }

      if (attempt < attempts) {
        const wait = retryBaseMs() * attempt;
        console.warn(`Updates: ${res.error} — retrying in ${wait}ms (attempt ${attempt}/${attempts})`);
        status.updateError = res.error;
        await new Promise((r) => setTimeout(r, wait));
        continue;
      }
      // Out of attempts: report what actually failed, not that the install cannot update.
      status.updateError = res.error;
      console.warn(`Updates: ${res.error}`);
    }
  } finally {
    checking = false;
  }
}

/**
 * Whether an error will not be fixed by trying again.
 *
 * Only the two cases that are properties of THIS BUILD rather than of the network: no version baked
 * in (a dev run) and no artifact published for this platform. Everything else — a 5xx, a dropped
 * connection, a hash mismatch from a truncated transfer — can differ on the next attempt.
 *
 * Exported so it can be called with real strings instead of searched for in the source.
 */
export function isPermanent(error: string): boolean {
  return error.includes("no win-x64 artifact") ||
    error.includes("no linux-x64 artifact") ||
    error.includes("manifest has no version") ||
    error.includes("no version baked in");
}

/**
 * Re-run the update check on request.
 *
 * Exposed because the automatic check is once-per-launch: without this, a failure at open (or a
 * download the user cancelled by closing the app too early) means no update until the next launch.
 * Shares `runUpdateCheck`, so a retry behaves exactly like the automatic path.
 */
export function retryUpdateCheck(): { started: boolean; error: string | null } {
  if (checking) return { started: false, error: "a check is already running" };
  if (!status.current) return { started: false, error: "no version baked in (dev run)" };
  const manifestUrl = Deno.env.get("SEMACLIP_UPDATE_URL") ?? DEFAULT_MANIFEST_URL;
  if (Deno.build.os === "windows") {
    void runUpdateCheck(() => checkWindowsUpdate(manifestUrl));
  } else if (Deno.build.os === "linux") {
    void runUpdateCheck(() => checkAndStageAppImage(manifestUrl));
  } else {
    return { started: false, error: "this platform updates through the runtime's own updater" };
  }
  return { started: true, error: null };
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
  status.downloading = true;
  status.phase = "downloading";
  status.download = { version: latest, received: 0, total: 0, fraction: null };
  emitAppEvent({ type: "update-progress", version: latest, received: 0, total: 0, fraction: null });
  const result = await downloadAndStageAppImage(manifestUrl, latest, entry, undefined, (p) => {
    status.download = { version: latest, received: p.received, total: p.total, fraction: p.fraction };
    emitAppEvent({
      type: "update-progress",
      version: latest,
      received: p.received,
      total: p.total,
      fraction: p.fraction,
    });
  });
  // Reset the progress face BEFORE reporting the outcome, so a failed download cannot leave the UI
  // claiming one is still running and telling the user to keep the window open.
  status.downloading = false;
  status.phase = "idle";
  status.download = null;
  if (!result.staged) {
    return { staged: false, error: result.error ?? "download failed" };
  }
  status.pendingVersion = latest;
  status.phase = "ready";
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
 * Windows: check the manifest, then DOWNLOAD THE PAYLOAD WHILE THE APP IS STILL OPEN.
 *
 * ── WHY THE RUNTIME'S OWN CHECK CANNOT DO THIS ──────────────────────────────────────────────
 * `Deno.autoUpdate()` compares `manifest.version` against `Deno.desktopVersion`... which is NULL on
 * the Windows target even when a version is baked (measured with a minimal app: "9.9.9" on
 * linux-x64, null on win-x64, with `"app_version":"9.9.9"` present in the Windows dylib). With a
 * null side of the comparison the runtime never stages, so the banner could never appear.
 *
 * MEASURED on a 26.232 win-x64 build with a working version channel, against a published 26.233
 * whose patch downloads fine (HTTP 200): the runtime staged nothing. Its check is inert here.
 *
 * ── THE SEQUENCE, AND WHY ───────────────────────────────────────────────────────────────────
 * Download now, install on restart. The app must NOT quit to fetch 100MB: there is nothing to show
 * progress in and no moment at which the user can be told what is happening. So the payload is
 * fetched to a staged file on disk while the app stays open and usable, progress is pushed to the
 * UI, and only once the bytes are verified does a restart become an option.
 *
 * `pendingVersion` is therefore set ONLY when the payload is complete and verified, which is what
 * makes every consumer's meaning stay true: a pending update is one that can actually be applied.
 *
 * The comparison is numeric, not string equality: the scheme advances by commit count, so "26.9" vs
 * "26.10" must order numerically or a release would look OLDER than the one before it.
 */
async function checkWindowsUpdate(
  manifestUrl: string,
): Promise<{ available: boolean; reason?: string; error?: string }> {
  if (!status.current) {
    return { available: false, reason: "no version baked in (dev run)" };
  }

  let manifest: {
    version?: string;
    artifacts?: Record<string, { name: string; sha256: string; url?: string }>;
  };
  try {
    const res = await fetch(manifestUrl, { signal: AbortSignal.timeout(30_000) });
    if (!res.ok) return { available: false, error: `manifest fetch failed: HTTP ${res.status}` };
    manifest = await res.json();
  } catch (err) {
    return {
      available: false,
      error: `manifest fetch failed: ${err instanceof Error ? err.message : err}`,
    };
  }

  const latest = manifest.version;
  if (!latest) return { available: false, error: "manifest has no version" };
  if (latest === status.current) return { available: false, reason: `up to date (${status.current})` };
  if (compareVersions(latest, status.current) <= 0) {
    return { available: false, reason: `published ${latest} is not newer than ${status.current}` };
  }

  if (!status.sidecarPath) {
    return {
      available: false,
      error:
        `an update to ${latest} exists but the updater could not be placed, so it cannot be ` +
        `applied. ${status.sidecarError ?? ""}`.trim(),
    };
  }

  const entry = manifest.artifacts?.["win-x64"];
  if (!entry) {
    return { available: false, error: `manifest has no win-x64 artifact (published ${latest})` };
  }

  // ── The download, while the app runs ──────────────────────────────────────────────────────
  status.phase = "downloading";
  status.download = { version: latest, received: 0, total: 0, fraction: null };
  emitAppEvent({
    type: "update-progress",
    version: latest,
    received: 0,
    total: 0,
    fraction: null,
  });

  const base = manifestUrl.replace(/\/[^/]*$/, "");
  const url = entry.url ?? `${base}/${entry.name}`;
  // STAGED OUTSIDE THE INSTALL DIRECTORY. The swap only renames entries that are IN the extracted
  // archive, so a 100MB zip left beside the payload would never be replaced or removed by an
  // update — it would just accumulate in the install directory forever. `%LOCALAPPDATA%\SemaClip`
  // is the per-user directory the sidecar already lives in.
  const stageDir = sidecarDir();
  await Deno.mkdir(stageDir, { recursive: true }).catch(() => {});
  // A payload for a version that was superseded before the user restarted would otherwise sit here
  // for good; only the newest download is ever installable, so the others are dead weight.
  // `Deno.readDir` is an async ITERABLE, not a promise, so it cannot be `.catch()`ed — an absent
  // directory is caught around the loop instead.
  try {
    for await (const e of Deno.readDir(stageDir)) {
      const superseded = e.name.startsWith("update-") && e.name.endsWith(".zip") &&
        e.name !== `update-${latest}.zip`;
      if (e.isFile && superseded) await Deno.remove(`${stageDir}\\${e.name}`).catch(() => {});
    }
  } catch {
    // No staging directory yet: nothing to prune.
  }
  const staged = `${stageDir}\\update-${latest}.zip`;

  const res = await downloadVerified(url, staged, entry.sha256, {
    log: (m) => console.log(m),
    onProgress: (p) => {
      status.download = { version: latest, received: p.received, total: p.total, fraction: p.fraction };
      // PUSHED, not polled: a progress bar that waits for the query cache looks stalled.
      emitAppEvent({
        type: "update-progress",
        version: latest,
        received: p.received,
        total: p.total,
        fraction: p.fraction,
      });
    },
  });

  if (!res.ok) {
    status.phase = "idle";
    status.download = null;
    return { available: false, error: res.error ?? "download failed" };
  }

  status.stagedPath = staged;
  status.stagedSha256 = res.sha256;
  status.pendingVersion = latest;
  status.phase = "ready";
  console.log(
    `Updates: ${latest} downloaded and verified (${(res.bytes / 1e6).toFixed(0)}MB) — ` +
      `restart to install`,
  );
  // `canApplyByRestart: true` — the payload is on disk, so a restart genuinely installs it now.
  emitAppEvent({ type: "update-staged", version: latest, canApplyByRestart: true });
  return { available: true };
}

/**
 * Apply a downloaded Windows update by handing the STAGED PAYLOAD to the sidecar, then quitting.
 *
 * The sidecar waits for THIS pid to exit (it cannot swap a loaded DLL, and this process is the
 * loader), installs the archive it was given, and relaunches. Because the download already
 * happened, the window between quitting and being back is a file swap rather than a 100MB fetch —
 * which is the difference between a restart that feels instant and one that looks like a crash.
 *
 * `-payload` is what keeps the sidecar from re-downloading: without it the sidecar would fetch the
 * same archive again, and the progress the user just watched would have been theatre.
 */
export function applyWindowsUpdate(): { restarting: boolean; error: string | null } {
  if (!status.pendingVersion) return { restarting: false, error: "no update is downloaded" };
  const sidecar = status.sidecarPath;
  if (!sidecar) {
    return { restarting: false, error: "the updater is not available, so the update cannot be applied" };
  }
  if (!status.stagedPath || !status.stagedSha256) {
    return { restarting: false, error: "the downloaded update is missing, so it cannot be applied" };
  }

  // ── PREFLIGHT, BEFORE ANYTHING IS STOPPED ────────────────────────────────────────────────────
  // This runs the updater in a mode that changes nothing and reports through the exit code. Without
  // it, a problem the sidecar can only discover AFTER the app exits (an app directory that is not
  // writable, a payload that cannot be read as an archive) closed the window and left the user with
  // nothing but a console that flashed and vanished — exactly the reported failure.
  //
  // Synchronous on purpose: it must finish while the window still exists, because its refusal is what
  // keeps the app running and the message on screen.
  const pre = preflight(sidecar, appDirPath(), status.stagedPath, status.stagedSha256);
  if (!pre.ok) {
    return { restarting: false, error: pre.error };
  }

  try {
    // Detached: the helper must outlive this process, because this process is what it waits for.
    const cmd = new Deno.Command(sidecar, {
      args: [
        "-relaunch",
        "-wait-pid",
        String(Deno.pid),
        "-app",
        appDirPath(),
        "-payload",
        status.stagedPath,
        "-payload-sha256",
        status.stagedSha256,
        "-version",
        status.pendingVersion,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    });
    cmd.spawn().unref();
  } catch (err) {
    return {
      restarting: false,
      error: `could not start the updater: ${err instanceof Error ? err.message : err}`,
    };
  }
  // Quit so the sidecar can take the payload. Deferred slightly so this response is flushed first.
  setTimeout(() => Deno.exit(0), 250);
  return { restarting: true, error: null };
}

/**
 * Run the updater's no-op validation and report what it says.
 *
 * A TIMEOUT IS A REFUSAL, not a pass. If the preflight cannot answer within a few seconds, the app
 * must keep running: a swap that then fails would take the window with it, which is the outcome this
 * exists to avoid.
 */
function preflight(sidecar: string, appDir: string, payload: string, sha: string): { ok: boolean; error: string | null } {
  try {
    const cmd = new Deno.Command(sidecar, {
      args: ["-preflight", "-app", appDir, "-payload", payload, "-payload-sha256", sha],
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    });
    const out = cmd.outputSync();
    if (out.success) return { ok: true, error: null };
    const text = (new TextDecoder().decode(out.stderr) + new TextDecoder().decode(out.stdout)).trim();
    return {
      ok: false,
      error: text.length > 0
        ? `the update cannot be applied: ${text}`
        : `the update cannot be applied (the updater exited ${out.code} with no message)`,
    };
  } catch (err) {
    return {
      ok: false,
      error: `could not validate the update before installing: ${err instanceof Error ? err.message : err}`,
    };
  }
}

/**
 * Numeric compare of `v{yy}.{patch}` (and any dotted numeric version).
 *
 * Plain `===` on the strings is not enough: the scheme advances by commit count, so "26.9" vs
 * "26.10" must compare numerically or a release would look OLDER than the one before it and the
 * update would never be offered.
 */
export function compareVersions(a: string, b: string): number {
  const parse = (v: string) => v.split(".").map((p) => Number.parseInt(p, 10) || 0);
  const [x, y] = [parse(a), parse(b)];
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
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

  // ── DID A PREVIOUS HAND-OFF ACTUALLY LAND? ──────────────────────────────────────────────────
  // The updater records the version it APPLIED inside the bundle. So if the record claims a version
  // this binary is not, the previous hand-off did not take: the app closed, the swap failed, and the
  // user was left on the old build with nothing on screen — and because the startup check runs again,
  // they are offered the same update and the loop repeats on every launch.
  //
  // Checked BEFORE anything else so the message survives even if the check below fails too.
  await reconcileRecordedVersion();

  // WINDOWS FIRST: the updater's swap needs a real file outside the payload's virtual
  // filesystem, and this is the only process that can read the embedded copy. Doing it
  // before the autoUpdate() call means the check's outcome is always actionable, and
  // it is cheap — a stat on every launch after the first.
  if (Deno.build.os === "windows") {
    const sc = await ensureSidecar();
    status.sidecarPath = sc.path;
    status.sidecarError = sc.error;
    if (sc.path) {
      // The launcher is NOT part of the update flow any more: the app starts the sidecar itself and
      // quits. It is only mentioned when the app has no OTHER way to apply an update.
      console.log(`Updates: sidecar ${sc.extracted ? "placed" : "present"} at ${sc.path}`);
    } else {
      // The one combination that cannot self-update. Say so plainly.
      console.warn(
        `Updates: Windows sidecar could not be placed — staged updates cannot be applied. ${sc.error ?? ""}`,
      );
    }
    // THE CHECK IS OURS, NOT THE RUNTIME'S. See checkWindowsUpdate(): the runtime compares against
    // Deno.desktopVersion, which is null on this target, so autoUpdate() never stages anything and
    // the user is never told. Returning here also means the runtime's call below is never reached
    // on Windows — a call that provably does nothing (measured: no patch staged with a valid
    // version channel and a downloadable patch).
    //
    // NOT AWAITED. The payload is ~100MB: awaiting here would hold up the server's own startup for
    // as long as the download takes, so the window would not appear until it finished — the exact
    // opposite of downloading while the app is usable. The download reports progress over the event
    // stream, and a failure arrives as a status error rather than as a stalled boot.
    // NOT AWAITED and not routed through the generic path below, so a failure here is a FAILED
    // CHECK — it lands in `updateError`, never in `sidecarError`. A reachable manifest that answers
    // 500, or a connection that drops mid-download, says nothing about whether this install can
    // apply an update, and reporting it as a limitation would be a lie about the install.
    const manifestUrl = baseUrl ?? Deno.env.get("SEMACLIP_UPDATE_URL") ?? DEFAULT_MANIFEST_URL;
    void runUpdateCheck(() => checkWindowsUpdate(manifestUrl));
    return;
  }
  // LINUX: the runtime's own updater CANNOT work from an AppImage, so this does the check and the
  // download itself. See appimage-update.ts for the mechanism and the measurement.
  if (Deno.build.os === "linux") {
    // Same override the runtime's own call honours, resolved here because the Linux path does not
    // go through that call at all.
    const manifestUrl = baseUrl ?? Deno.env.get("SEMACLIP_UPDATE_URL") ?? DEFAULT_MANIFEST_URL;
    // NOT AWAITED. This call DOWNLOADS the whole AppImage (~100MB), and awaiting it here blocks the
    // rest of main.ts — which is where the window is created. Measured: `await startAutoUpdate()`
    // is the LAST line of main.ts, so the previous code did not "download while the app is open" at
    // all on Linux; it downloaded BEFORE the app existed and the window only appeared afterwards.
    // That is the opposite of the requested behaviour, and on a slow connection it looks like a
    // hang. Fire-and-forget, exactly as the Windows path does.
    void runUpdateCheck(async () => {
      return await checkAndStageAppImage(manifestUrl);
    });
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
      // choose to restart into it. This path is not reached on Windows or Linux (both do their own
      // check and return above), so it describes what the runtime's own staging can offer.
      emitAppEvent({ type: "update-staged", version, canApplyByRestart: status.canApply });
    },
    onRollback(reason) {
      status.lastRollback = reason;
      console.warn("Updates: previous launch failed, rolled back —", reason);
      emitAppEvent({ type: "update-rollback", version: reason, canApplyByRestart: status.canApply });
    },
  });
}
