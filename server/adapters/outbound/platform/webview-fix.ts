/**
 * Webview launch workaround — reported, never re-executed.
 *
 * Two platforms need the process to be BORN with a variable set, because the
 * webview backend initialises before this module's body runs. One file, one
 * re-exec path, because the mechanism is identical and the platform differences
 * are just a variable name and a value.
 *
 * ── LINUX: Wayland DMA-BUF ────────────────────────────────────────────────────
 * The embedded webview (WebKitGTK) fails to open a window on a Wayland session
 * when its DMA-BUF renderer is in play — measured on this machine (Hyprland +
 * NVIDIA proprietary): the app logs `Gdk-Message: Error 71 (Protocol error)
 * dispatching to Wayland display.` and NO window ever appears, while the HTTP
 * server happily binds a port. Silent from the app's point of view, which makes it
 * look half-alive rather than broken.
 *
 * Measured variants against one built binary:
 *
 *   (nothing)                          -> no window, Error 71
 *   WEBKIT_DISABLE_DMABUF_RENDERER=1   -> window OK   (keeps native Wayland)
 *   WEBKIT_DISABLE_COMPOSITING_MODE=1  -> window OK
 *   GDK_BACKEND=x11                    -> window OK   (forces XWayland)
 *   GDK_BACKEND=wayland                -> no window, Error 71
 *
 * So the narrow fix is the DMA-BUF renderer, NOT `GDK_BACKEND=x11`: forcing
 * XWayland also works but downgrades the whole app to X11 (loses native Wayland
 * scaling), which is a needless loss when a one-flag WebKit variable is enough.
 *
 * ── WINDOWS: WebView2 user-data in Program Files ──────────────────────────────
 * The generated .msi installs per-machine under %ProgramFiles%\<AppName>\ (its own
 * Property table: ALLUSERS=1, INSTALLDIR=ProgramFiles64Folder\...). WebView2
 * defaults its user-data folder BESIDE THE EXECUTABLE, which is not writable
 * there, so the host fails to initialise and the app shows a white, titleless
 * window. Reproduced independently by three reporters (denoland/deno#36768, filed
 * 2026-09-03, still open):
 *
 *   CreateCoreWebView2EnvironmentWithOptions failed to start (hr=0x80070005)
 *
 * The same report documents the fix: launching with WEBVIEW2_USER_DATA_FOLDER
 * pointed at a per-user path works — and explicitly notes that `Deno.env.set` in
 * main.ts is TOO LATE, because the host initialises before the entrypoint runs.
 * That is the same constraint as Wayland, so the same re-exec applies: the child
 * is born with the variable, which is precisely what an `Exec=` line could not
 * guarantee either (it misses direct exe launches, and the .msi writes its own
 * shortcut).
 *
 * ── WHY A RE-EXEC, NOT AN IN-PROCESS SET ──────────────────────────────────────
 * Measured on Linux: `Deno.env.set` then `Deno.serve` still produced Error 71 and
 * no window, because the display connection was already established. The child
 * must be born with the variable in its environment, so the parent re-execs itself
 * once and exits with the child's status.
 *
 * The marker variable makes the loop impossible even if the child's env is
 * stripped by something in between.
 *
 * DESKTOP RUNTIME ONLY. This is guarded on DENO_SERVE_ADDRESS, which the desktop
 * runtime sets and `deno run` does not. That guard is load-bearing, not tidiness:
 * Deno.args holds SCRIPT ARGS (not the entrypoint path), so under `deno run` a
 * re-exec with `args: Deno.args` would invoke bare `deno` — which starts an
 * interactive REPL instead of the server, and the dev server would silently stop
 * existing. Measured: re-exec is correct in the compiled binary (Deno.execPath()
 * IS the app there) and catastrophic under `deno run`, so the two paths must not
 * share the spawn.
 */
/** Windows: where WebView2 keeps its profile when we point it somewhere writable. */
export function webview2UserDataFolder(): string {
  const local = Deno.env.get("LOCALAPPDATA")
    ?? `${Deno.env.get("USERPROFILE") ?? ""}\\AppData\\Local`;
  return `${local}\\SemaClip\\WebView2`;
}

/**
 * Reports whether this build's launch workaround is in effect.
 *
 * The variable is supplied by `deno desktop --env-file` at BUILD time, because
 * the webview backend initialises before this module runs — `Deno.env.set` here
 * is too late (measured: still `Error 71`, no window). Reporting it means a
 * misconfigured build is visible in the log instead of silently showing a blank
 * window with no signal.
 *
 * A missing variable is not fatal: the WebKit failure is Wayland/NVIDIA specific,
 * and a WebView2 profile beside a writable executable works fine.
 */
export function reportWebviewLaunchEnvironment(): void {
  if (!Deno.env.get("DENO_SERVE_ADDRESS")) return;

  if (Deno.build.os === "linux") {
    const set = Deno.env.get("WEBKIT_DISABLE_DMABUF_RENDERER");
    if (set) console.log(`webview: WEBKIT_DISABLE_DMABUF_RENDERER=${set}`);
    else console.warn("webview: WEBKIT_DISABLE_DMABUF_RENDERER not set — a Wayland/NVIDIA session will open no window");
  }

  if (Deno.build.os === "windows") {
    const set = Deno.env.get("WEBVIEW2_USER_DATA_FOLDER");
    if (set) console.log(`webview: WEBVIEW2_USER_DATA_FOLDER=${set}`);
    else console.warn("webview: WEBVIEW2_USER_DATA_FOLDER not set — an install under Program Files will show a white window");
  }
}
