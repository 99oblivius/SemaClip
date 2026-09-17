/**
 * Linux webview launch fix.
 *
 * The embedded webview (WebKitGTK) fails to open a window on a Wayland session
 * when its DMA-BUF renderer is in play — measured on this machine (Hyprland +
 * NVIDIA proprietary): the app logs `Gdk-Message: Error 71 (Protocol error)
 * dispatching to Wayland display.` and NO window ever appears, while the HTTP
 * server happily binds a port. The failure is silent from the app's point of
 * view, which makes it look half-alive rather than broken.
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
 * WHY A RE-EXEC. The GTK backend initialises before this process's module body
 * runs, so setting the variable in-process is too late — verified: `Deno.env.set`
 * then `Deno.serve` still produced Error 71 and no window, because the display
 * connection was already established. The child must be BORN with the variable
 * in its environment, so the parent re-execs itself once and exits with the
 * child's status.
 *
 * WHY NOT THE .desktop `Exec=` LINE. Adding `env VAR=1` to the generated
 * `.desktop` would cover only launches routed through the desktop entry (menu,
 * xdg-open). Running the AppImage or the app-directory binary directly — the
 * normal way to try a portable build, and what CI does — bypasses `Exec=`
 * entirely, and `deno desktop` generates the `.desktop` itself with no env hook.
 * A re-exec covers every launch path.
 *
 * The marker variable makes the loop impossible even if the child's env is
 * stripped by something in between.
 */
const MARKER = "SEMACLIP_WEBVIEW_REEXEC";
const FIX_VAR = "WEBKIT_DISABLE_DMABUF_RENDERER";

/**
 * Re-execs the process with the webview workaround applied. Returns normally
 * (and does nothing) on non-Linux, when already applied, or in a dev run — so
 * `deno run main.ts` on a healthy desktop is untouched.
 */
export async function reexecForLinuxWebview(): Promise<void> {
  if (Deno.build.os !== "linux") return;
  if (Deno.env.get(FIX_VAR)) return;
  if (Deno.env.get(MARKER)) return;

  const cmd = new Deno.Command(Deno.execPath(), {
    args: Deno.args,
    env: { ...Deno.env.toObject(), [FIX_VAR]: "1", [MARKER]: "1" },
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const status = await cmd.spawn().status;
  Deno.exit(status.code);
}
