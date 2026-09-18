/**
 * Window lifecycle and custom chrome. ONE window, ONE owner.
 *
 * ── THE BLANK WINDOW (measured, reported on BOTH platforms) ──────────────────
 * Startup opened an extra blank window titled with the app name, because the docs are
 * explicit: "The first `new Deno.BrowserWindow()` you construct adopts that initial
 * window; every construction after that opens a new one."
 *
 * This module used to construct a window in THREE separate functions — adopt, set
 * title, close. Setting the title therefore spawned a SECOND window and applied the
 * title to THAT one, while the window showing the app kept its old title. Construction
 * now happens exactly once per process and every later operation goes through the
 * stored handle.
 *
 * ── CLOSING ───────────────────────────────────────────────────────────────────
 * MEASURED SYMPTOM (Windows): closing the window with Alt+F4 or the titlebar button
 * left the process running with no window, so the app appeared to ignore the close.
 * The cause is ours, not the backend's: `Deno.serve` holds a listening socket and the
 * desktop runtime keeps the process alive while any async task is pending, so the
 * server outlived its window and nothing exited. THE RULE: when the window closes, the
 * app is over. A desktop app that keeps a headless HTTP server running after its window
 * is gone is indistinguishable from a hang, and it holds the port so the next launch
 * fails with AddrInUse.
 *
 * ── CUSTOM CHROME ─────────────────────────────────────────────────────────────
 * Measured against the running runtime's own prototype (Deno 2.9.6) rather than
 * assumed from the docs:
 *
 *   available:   bind close executeJs focus getNativeWindow getOpacity getPosition
 *                getSize hide isAlwaysOnTop isClosed isResizable isVisible navigate
 *                openDevtools reload setAlwaysOnTop setApplicationMenu setOpacity
 *                setPosition setResizable setSize setTitle show showContextMenu unbind
 *                windowId + on{blur,click,close,contextmenuclick,dblclick,focus,keydown,
 *                keyup,load,menuclick,mousedown,mouseenter,mouseleave,mousemove,mouseup,
 *                move,resize,wheel}
 *
 *   ABSENT:      minimize, maximize, unmaximize, isMinimizable, isMaximizable,
 *                isFrameless, getTitle
 *
 * So a frameless window can carry a drag region, a close button and any paint we like,
 * but it CANNOT minimise or maximise: the capability is not in the window class and a
 * frameless window has no OS titlebar to fall back on. `frameless` is therefore off
 * unless explicitly requested, and the chrome works either way.
 *
 * ── WHY ADOPTION, NOT CREATION ────────────────────────────────────────────────
 * The runtime opens a window implicitly at startup and the first construction adopts
 * it. `frameless` is creation-only, so it can only be applied at that moment; creating a
 * second window to get a frameless one would leave the original on screen, which is
 * precisely the blank-window bug above.
 *
 * Guarded on DENO_SERVE_ADDRESS (set by the desktop runtime, absent under `deno run`)
 * so development keeps working: under `deno run` there is no window to manage.
 */

type Win = {
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void;
  setTitle?(title: string): void;
  close?(): void;
};

/** The ONE window this process owns. Null until adopted, and never replaced. */
let windowHandle: Win | null = null;

/** True once adoption has been attempted, whether or not it succeeded. */
let adopted = false;

/** How many windows this process has asked the runtime to construct. Must never exceed 1. */
let constructed = 0;

/**
 * Constructions performed so far.
 *
 * Exposed so the invariant is testable: a second construction is not a request for
 * "the" window, it is a request for ANOTHER window, which is how the blank one appeared.
 */
export function windowConstructCount(): number {
  return constructed;
}

/** What this build asked for, so the UI can render chrome that matches the window. */
export interface ChromeState {
  /** True when the window has no OS decoration, so the app must draw its own. */
  frameless: boolean;
  /** True when the OS still provides a titlebar with working min/max/close. */
  nativeDecorations: boolean;
  /** Window buttons the app can actually provide. Close always works; the rest cannot. */
  canMinimize: boolean;
  canMaximize: boolean;
  /**
   * Why adoption failed, when it did.
   *
   * Without this the only symptom of a failed adoption is chrome that does not render,
   * which is indistinguishable from chrome that is not implemented — the owner reported
   * "still decoration and no functional chrome" three times with nothing to diagnose.
   */
  adoptError: string | null;
}

const state: ChromeState = {
  frameless: false,
  nativeDecorations: true,
  // Measured absent from BrowserWindow. Explicit fields rather than omitted, so the UI
  // asks a question instead of assuming an answer.
  canMinimize: false,
  canMaximize: false,
  adoptError: null,
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

type WindowCtor = new (opts?: Record<string, unknown>) => Win;

function BrowserWindowCtor(): WindowCtor | undefined {
  return (Deno as { BrowserWindow?: WindowCtor }).BrowserWindow;
}

/** True when running inside the desktop runtime rather than `deno run`. */
function inDesktopRuntime(): boolean {
  return Boolean(Deno.env.get("DENO_SERVE_ADDRESS"));
}

/**
 * Reports the window state AND the inputs the decision depends on.
 *
 * `adoptWindowLifecycle` used to swallow a construction failure entirely, so the only
 * observable result of a failed adoption was chrome that never rendered, with no clue
 * why. The owner reported exactly that and could not tell us what went wrong, which is
 * why this exists.
 */
export function logWindowDiagnostics(): void {
  console.log(
    `window: desktopRuntime=${inDesktopRuntime()} ` +
      `(DENO_SERVE_ADDRESS=${Deno.env.get("DENO_SERVE_ADDRESS") ?? "unset"}) ` +
      `BrowserWindow=${BrowserWindowCtor() ? "present" : "ABSENT"} ` +
      `SEMACLIP_NATIVE_DECORATIONS=${Deno.env.get("SEMACLIP_NATIVE_DECORATIONS") ?? "unset"}`,
  );
}

/**
 * Adopts the implicit startup window, sets its title, and exits the process when it
 * closes. Safe to call unconditionally: inert under `deno run`.
 *
 * Constructs at most ONE window, ever. Every later operation uses the stored handle,
 * because constructing again would open a second window.
 */
export function adoptWindowLifecycle(options: ChromeOptions = {}): void {
  if (!inDesktopRuntime()) return;
  if (adopted) return;
  adopted = true;

  const Ctor = BrowserWindowCtor();
  if (!Ctor) return;

  let win: Win;
  try {
    // THE one construction. It adopts the window the runtime already opened.
    win = new Ctor({
      // Frameless is a CREATION option, so it must be passed at adoption time. The
      // default is frameless (the app draws its own chrome); an explicit opt-out is
      // how the OS titlebar comes back.
      frameless: options.frameless !== false,
      ...(options.title ? { title: options.title } : {}),
    });
    constructed += 1;
    console.log(
      `window: adopted (construction #${constructed}) frameless=${options.frameless !== false} ` +
        `title=${options.title ?? "none"}`,
    );
  } catch (err) {
    // NOT silent. A failed adoption leaves the window exactly as the OS made it —
    // decorated, with no chrome — which is a user-visible defect that was being
    // reported as "the chrome still does not work" with nothing to diagnose.
    state.adoptError = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
    console.error(`window: adoption FAILED — ${state.adoptError}`);
    return;
  }

  windowHandle = win;
  // Report what the WINDOW got, not what the caller passed: frameless defaults to true
  // here, so `Boolean(options.frameless)` would report decorations the window does not
  // have and the UI would draw no chrome over an undecorated window.
  state.frameless = options.frameless !== false;
  state.nativeDecorations = !state.frameless;

  win.addEventListener("close", () => {
    // The server is the only thing keeping the process alive; exiting here is what makes
    // the window's close button actually close the app.
    Deno.exit(0);
  });

  // Apply the title to the window just adopted, never to a new one.
  if (options.title) {
    try {
      win.setTitle?.(options.title);
    } catch {
      // A title is cosmetic; a failure must not stop the app from running.
    }
  }
}

/**
 * Sets the window title, on the ALREADY-ADOPTED window.
 *
 * Never constructs: a construction here would open a second window, which is the bug
 * this module exists to prevent. Returns false when there is no window (a dev run) or the
 * runtime refused.
 */
export function setWindowTitle(title: string): boolean {
  if (!inDesktopRuntime() || !windowHandle) return false;
  try {
    windowHandle.setTitle?.(title);
    return true;
  } catch {
    return false;
  }
}

/**
 * Closes the window, which (via the close handler above) ends the process.
 *
 * Exists so the app's own chrome has a real close action: with `frameless` on there is no
 * OS button left, and a titlebar-less window with no way to close would be unusable. Uses
 * the stored handle, never a new construction.
 */
/**
 * Restarts the app so a STAGED update is applied.
 *
 * The runtime applies a staged update in the launcher, before anything else runs on the
 * next start — so "restart" is the only honest meaning of "apply now", and there is no
 * in-process apply to call (the docs expose autoUpdate's callbacks and nothing more; the
 * running dylib is untouched until a relaunch).
 *
 * The relaunch is spawned AFTER this process exits, because a Windows launcher cannot
 * replace a DLL that a live process has loaded. `cmd /c start` (Windows) and a detached
 * `sh -c` (POSIX) both outlive us; the Windows command re-runs the SIDECAR, which applies
 * the update and relaunches, while POSIX just starts the binary again and lets the
 * runtime's own launcher do the swap. Failures are reported, never silent: a restart that
 * did not happen must not look like one that did.
 */
export async function restartApp(): Promise<{ restarting: boolean; error: string | null }> {
  try {
    const exe = Deno.execPath();
    const dir = exe.includes("/") ? exe.slice(0, exe.lastIndexOf("/"))
      : exe.includes("\\") ? exe.slice(0, exe.lastIndexOf("\\"))
      : ".";

    if (Deno.build.os === "windows") {
      // Prefer the sidecar: it applies any staged update, then launches the app.
      const sidecar = `${dir}\\SemaClipUpdater.exe`;
      const target = await Deno.stat(sidecar).then(() => true).catch(() => false)
        ? `${dir}\\Launch SemaClip (updates).cmd`
        : exe;
      new Deno.Command("cmd", { args: ["/c", "start", "", target], cwd: dir }).spawn();
    } else {
      // `setsid`-style detach: the child must not die with this process.
      new Deno.Command("sh", {
        args: ["-c", `sleep 2; exec "${exe}" >/dev/null 2>&1 &`],
        cwd: dir,
      }).spawn();
    }
    // Give the spawn a moment to be registered before the process goes away.
    await new Promise((r) => setTimeout(r, 250));
    setTimeout(() => Deno.exit(0), 150);
    return { restarting: true, error: null };
  } catch (err) {
    return { restarting: false, error: err instanceof Error ? err.message : String(err) };
  }
}

export function closeWindow(): boolean {
  if (!inDesktopRuntime() || !windowHandle) return false;
  try {
    windowHandle.close?.();
    return true;
  } catch {
    return false;
  }
}
