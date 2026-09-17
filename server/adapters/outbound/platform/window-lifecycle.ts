/**
 * Window lifecycle and custom chrome.
 *
 * ── CLOSING ───────────────────────────────────────────────────────────────────
 * MEASURED SYMPTOM (Windows): closing the window with Alt+F4 or the titlebar button
 * left the process running with no window, so the app appeared to ignore the close.
 * The cause is ours, not the backend's: `Deno.serve` holds a listening socket and the
 * desktop runtime keeps the process alive while any async task is pending, so the
 * server outlived its window and nothing exited. THE RULE: when the last window
 * closes, the app is over. A desktop app that keeps a headless HTTP server running
 * after its window is gone is indistinguishable from a hang, and it holds the port so
 * the next launch fails with AddrInUse.
 *
 * ── CUSTOM CHROME ─────────────────────────────────────────────────────────────
 * The app wants a draggable header with real window buttons and no OS decoration.
 * Measured against the runtime's own prototype (deno desktop, Deno 2.9.6) rather than
 * assumed from the docs:
 *
 *   available:   bind close executeJs focus getNativeWindow getOpacity getPosition
 *                getSize hide isAlwaysOnTop isClosed isResizable isVisible navigate
 *                openDevtools reload setAlwaysOnTop setApplicationMenu setOpacity
 *                setPosition setResizable setSize setTitle show showContextMenu
 *                unbind windowId + on{blur,click,close,contextmenuclick,dblclick,
 *                focus,keydown,keyup,load,menuclick,mousedown,mouseenter,mouseleave,
 *                mousemove,mouseup,move,resize,wheel}
 *
 *   ABSENT:      minimize, maximize, unmaximize, isMinimizable, isMaximizable,
 *                isFrameless, getTitle
 *
 * So a frameless window can carry a drag region, a close button and any paint we
 * like, but it CANNOT minimise or maximise: the capability is not in the window class,
 * and a frameless window has no OS titlebar to fall back on. That is a real loss for
 * users who expect those buttons, so `frameless` stays OFF by default and is enabled
 * only when explicitly asked for. The chrome is built to work either way: with native
 * decorations it adds the app's own header inside the content area, without them it
 * also provides the drag region and the close button.
 *
 * ── WHY ADOPTION, NOT CREATION ────────────────────────────────────────────────
 * The desktop runtime opens a window implicitly at startup and the FIRST
 * `new Deno.BrowserWindow()` ADOPTS it; `frameless` is documented as creation-only, so
 * it cannot be applied to that implicit window after the fact. Creating a second window
 * to get a frameless one would leave the original on screen, which is the phantom
 * window bug already fixed once. One window, adopted, with whatever options it accepts.
 *
 * Guarded on DENO_SERVE_ADDRESS (set by the desktop runtime, absent under `deno run`)
 * for the same reason the webview workaround is: in development there is no window to
 * manage and the server must simply keep running.
 */

/** Set once the implicit startup window has been adopted. */
let adopted = false;

/** What this build asked for, so the UI can render chrome that matches the window. */
export interface ChromeState {
  /** True when the window has no OS decoration, so the app must draw its own. */
  frameless: boolean;
  /** True when the OS still provides a titlebar with working min/max/close. */
  nativeDecorations: boolean;
  /** Window buttons the app can actually provide. Close always works; the rest cannot. */
  canMinimize: boolean;
  canMaximize: boolean;
}

const state: ChromeState = {
  frameless: false,
  nativeDecorations: true,
  // Measured absent from BrowserWindow. Kept as explicit fields rather than omitted so
  // the UI asks a question instead of assuming an answer.
  canMinimize: false,
  canMaximize: false,
};

export function chromeState(): ChromeState {
  return { ...state };
}

/** Options for the adopted window. `frameless` is creation-only, so it is passed here. */
export interface ChromeOptions {
  /** Draw our own chrome and remove the OS decoration. */
  frameless?: boolean;
  title?: string;
}

type Win = {
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void;
  setTitle?(title: string): void;
  close?(): void;
};

/**
 * Adopts the implicit startup window, sets its title, and exits the process when it
 * closes. Safe to call unconditionally: inert under `deno run`.
 */
export function adoptWindowLifecycle(options: ChromeOptions = {}): void {
  if (!Deno.env.get("DENO_SERVE_ADDRESS")) return;
  if (adopted) return;

  const BrowserWindow = (Deno as { BrowserWindow?: new (opts?: Record<string, unknown>) => Win })
    .BrowserWindow;
  if (!BrowserWindow) return;

  try {
    // Pass the creation-only options on the ADOPTING construction: it is the only
    // moment they can be applied to the implicit window.
    const win = new BrowserWindow({
      ...(options.frameless ? { frameless: true } : {}),
      ...(options.title ? { title: options.title } : {}),
    });
    adopted = true;
    state.frameless = Boolean(options.frameless);
    state.nativeDecorations = !state.frameless;

    win.addEventListener("close", () => {
      // The server is the only thing keeping the process alive; exiting here is what
      // makes the window's close button actually close the app.
      Deno.exit(0);
    });
  } catch {
    // No implicit window (a headless desktop launch, e.g. CI smoke tests). The server
    // stays up in that case, which is what a test harness wants.
  }
}

/**
 * Sets the window title. Never a URL: the webview would otherwise show the address it
 * navigated to (127.0.0.1:<port>) as the window title, the most browser-like tell in
 * the app. Returns true when the title was applied.
 */
export function setWindowTitle(title: string): boolean {
  if (!Deno.env.get("DENO_SERVE_ADDRESS")) return false;
  const BrowserWindow = (Deno as { BrowserWindow?: new () => Win }).BrowserWindow;
  if (!BrowserWindow) return false;
  try {
    const win = new BrowserWindow();
    win.setTitle?.(title);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the window, which (via the close handler above) ends the process.
 *
 * This exists so the app's own chrome has a real close action: with `frameless` on
 * there is no OS button left, and a titlebar-less window with no way to close would be
 * unusable.
 */
export function closeWindow(): boolean {
  if (!Deno.env.get("DENO_SERVE_ADDRESS")) return false;
  const BrowserWindow = (Deno as { BrowserWindow?: new () => Win }).BrowserWindow;
  if (!BrowserWindow) return false;
  try {
    const win = new BrowserWindow();
    win.close?.();
    return true;
  } catch {
    return false;
  }
}
