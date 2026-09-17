/**
 * Launch-environment workarounds, resolved at RUNTIME.
 *
 * ── WHY NOT `deno desktop --env-file` ─────────────────────────────────────────
 * It cannot carry a per-user path, and using it for one produced a real bug:
 *
 *   Microsoft edge can't read and write to its data directory:
 *   C:\Program Files\SemaClip\%LOCALAPPDATA%\SemaClip\WebView2\EBWebView
 *
 * That literal `%LOCALAPPDATA%` came from an env-file value of
 * `%LOCALAPPDATA%\SemaClip\WebView2`. Measured against Deno 2.9.6:
 *
 *   - `%VAR%` is NOT expanded. The literal string is passed through, which is
 *     precisely the path above.
 *   - `${VAR}` IS expanded, but AT BUILD TIME: compiling with PROBE_HOME=/BUILDTIME
 *     and running with PROBE_HOME=/RUNTIME yields `/BUILDTIME\...` inside the binary.
 *     A value expanded on the build machine can never name a directory on the
 *     user's machine.
 *
 * So the Windows profile path is computed HERE, on the machine that needs it.
 *
 * ── WINDOWS: WebView2 user data beside an unwritable executable ───────────────
 * The generated .msi installs per-machine under `%ProgramFiles%\<AppName>\` (its own
 * Property table: ALLUSERS=1, INSTALLDIR=ProgramFiles64Folder\...). WebView2
 * defaults its user-data folder BESIDE THE EXECUTABLE, which is not writable there,
 * so the host fails to initialise and the window renders white. Reproduced
 * independently by three reporters (denoland/deno#36768, filed 2026-09-03, open):
 *
 *   CreateCoreWebView2EnvironmentWithOptions failed to start (hr=0x80070005)
 *
 * ── LINUX: Wayland DMA-BUF ────────────────────────────────────────────────────
 * The embedded WebKitGTK fails to open a window on some Wayland sessions — on this
 * machine (Hyprland + NVIDIA proprietary) it logs `Gdk-Message: Error 71 (Protocol
 * error) dispatching to Wayland display.` and NO window appears while the HTTP
 * server binds happily, so the app looks half-alive rather than broken. Measured
 * variants against one built binary:
 *
 *   (nothing)                          -> no window, Error 71
 *   WEBKIT_DISABLE_DMABUF_RENDERER=1   -> window OK   (keeps native Wayland)
 *   WEBKIT_DISABLE_COMPOSITING_MODE=1  -> window OK
 *   GDK_BACKEND=x11                    -> window OK   (forces XWayland)
 *   GDK_BACKEND=wayland                -> no window, Error 71
 *
 * The DMA-BUF flag is the narrow fix; `GDK_BACKEND=x11` also works but downgrades
 * the whole app to X11 and loses native Wayland scaling. This variable is NOT
 * per-user, so the env-file is the right home for it and it is set at build time.
 */
/** True when running inside the desktop runtime rather than `deno run`. */
function inDesktopRuntime(): boolean {
  return Boolean(Deno.env.get("DENO_SERVE_ADDRESS"));
}

/** Windows: where WebView2 keeps its profile when the exe sits somewhere unwritable. */
export function webview2UserDataFolder(): string {
  const local = Deno.env.get("LOCALAPPDATA")
    ?? `${Deno.env.get("USERPROFILE") ?? ""}\\AppData\\Local`;
  return `${local}\\SemaClip\\WebView2`;
}

/**
 * Points WebView2's profile at a per-user directory, early enough to matter.
 *
 * Called at the TOP of main.ts, before anything else runs, because the webview host
 * may initialise before or around the entrypoint. Whether an in-process `set` wins
 * that race is NOT verified on Windows — this codebase only has a Linux machine to
 * test on — so the result is reported below and a real Windows run is what settles
 * it. If it does lose the race, the MSI must install per-user instead (which makes
 * WebView2's default beside-the-exe location writable and removes the need for this
 * variable entirely); that is recorded in TODO.md rather than guessed at here.
 */
export function applyWebviewLaunchEnvironment(): void {
  if (Deno.build.os !== "windows") return;

  // An existing value wins: it means the launch environment supplied one, and a
  // deliberately configured path should not be overwritten.
  if (Deno.env.get("WEBVIEW2_USER_DATA_FOLDER")) return;

  try {
    const dir = webview2UserDataFolder();
    Deno.env.set("WEBVIEW2_USER_DATA_FOLDER", dir);
    // Creating it here also proves writability, which is the actual failure mode.
    Deno.mkdirSync(dir, { recursive: true });
  } catch (err) {
    console.warn(
      `webview: could not set WEBVIEW2_USER_DATA_FOLDER — the window may render white. ` +
        `${err instanceof Error ? err.message : err}`,
    );
  }
}

/**
 * Reports the launch environment. A misconfigured build must be visible in the log
 * instead of silently showing a blank window with no signal.
 *
 * A missing variable is not fatal on either platform: the WebKit failure is
 * Wayland/NVIDIA specific, and a WebView2 profile beside a writable exe works fine.
 */
export function reportWebviewLaunchEnvironment(): void {
  if (!inDesktopRuntime()) return;

  if (Deno.build.os === "linux") {
    const set = Deno.env.get("WEBKIT_DISABLE_DMABUF_RENDERER");
    if (set) console.log(`webview: WEBKIT_DISABLE_DMABUF_RENDERER=${set}`);
    else console.warn("webview: WEBKIT_DISABLE_DMABUF_RENDERER not set — a Wayland/NVIDIA session will open no window");
  }

  if (Deno.build.os === "windows") {
    const set = Deno.env.get("WEBVIEW2_USER_DATA_FOLDER");
    if (!set) {
      console.warn("webview: WEBVIEW2_USER_DATA_FOLDER not set — an install under Program Files will show a white window");
      return;
    }
    // A literal %VAR% here is the bug that shipped: it must never appear.
    if (set.includes("%")) {
      console.warn(`webview: WEBVIEW2_USER_DATA_FOLDER contains an unexpanded %VAR% (${set}) — WebView2 cannot use this path`);
      return;
    }
    let writable = false;
    try {
      Deno.mkdirSync(set, { recursive: true });
      writable = true;
    } catch {
      writable = false;
    }
    console.log(`webview: WEBVIEW2_USER_DATA_FOLDER=${set} writable=${writable}`);
  }
}
