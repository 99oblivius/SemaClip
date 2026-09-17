/**
 * Window lifecycle: the window is the app.
 *
 * MEASURED SYMPTOM (Windows, via the VM): closing the window with Alt+F4 or the
 * titlebar button left the process running with no window — the app appeared to
 * ignore the close entirely. The cause is ours, not the backend's: `Deno.serve`
 * holds a listening socket, and the desktop runtime keeps the process alive while
 * any async task is pending, so the server outlived its window and nothing ever
 * exited.
 *
 * THE RULE: when the last window closes, the app is over. A desktop app that keeps
 * a headless HTTP server running after its window is gone is indistinguishable
 * from a hang, and it also holds the port so the next launch fails with AddrInUse.
 *
 * This is guarded on DENO_SERVE_ADDRESS (set by the desktop runtime, absent under
 * `deno run`) for the same reason the webview re-exec is: in development the server
 * must keep running with no window to open at all.
 */

/** Set once the runtime has been asked to open a window. */
let adopted = false;

/**
 * Adopts the implicit startup window and exits the process when it closes.
 *
 * Safe to call unconditionally: it is inert under `deno run`, and it swallows the
 * "no window context" error the same way the docs' own example does, because the
 * window only exists when the app was launched as a desktop app.
 */
export function adoptWindowLifecycle(): void {
  if (!Deno.env.get("DENO_SERVE_ADDRESS")) return;
  if (adopted) return;

  type Win = {
    addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void;
    close(): void;
  };
  const BrowserWindow = (Deno as { BrowserWindow?: new () => Win }).BrowserWindow;
  if (!BrowserWindow) return;

  try {
    const win = new BrowserWindow();
    adopted = true;
    win.addEventListener("close", () => {
      // The server is the only thing keeping the process alive; exiting here is
      // what makes the window's close button actually close the app.
      Deno.exit(0);
    });
  } catch {
    // No implicit window (a headless desktop launch, e.g. CI smoke tests). The
    // server stays up in that case, which is what a test harness wants.
  }
}
