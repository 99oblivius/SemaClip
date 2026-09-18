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

import {
  beginDrag as winBeginDrag,
  isMaximized as winIsMaximized,
  measureWindow as measureWin32Window,
  minimizeWindow as winMinimizeWindow,
  removeNativeFrame,
  resizeBorderPx as winResizeBorderPx,
  showWindow as winShowWindow,
  toggleMaximize as winToggleMaximize,
} from "./win-frame.ts";
import {
  beginMoveDrag as gtkBeginMoveDrag,
  beginResizeDrag as gtkBeginResizeDrag,
  deiconify as gtkDeiconify,
  iconify as gtkIconify,
  measureDecorated as gtkMeasureDecorated,
  removeDecorations as gtkRemoveDecorations,
  toggleMaximizeGtk,
  type ResizeEdge,
} from "./gtk-frame.ts";

type Win = {
  addEventListener(type: string, fn: (e: { preventDefault(): void }) => void): void;
  setTitle?(title: string): void;
  close?(): void;
  hide?(): void;
  show?(): void;
  focus?(): void;
  getSize?(): [number, number];
  setSize?(width: number, height: number): void;
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
/**
 * What the WINDOW is, measured — never what the caller asked for.
 *
 * The distinction is not pedantic: `frameless` was reported from the option this module PASSED,
 * so the API said `frameless: true, nativeDecorations: false` while the actual Win32 window
 * carried WS_CAPTION|WS_THICKFRAME|WS_SYSMENU — the full native frame — because the runtime
 * silently ignores `frameless` on the construction that adopts its implicit startup window
 * (denoland/deno#35969, #35635, both open). The app drew no chrome over a decorated window, and
 * the log agreed with the wrong side.
 *
 * `actual` is therefore read back from the window: Win32 style bits on Windows, the runtime's
 * own `getSize` elsewhere. When no window exists (a dev run) it stays null and the UI falls back
 * to asking the runtime, which is the honest answer there.
 */
export interface MeasuredWindow {
  /**
   * True when the window genuinely has no caption/frame, false when it has one, and **null when
   * it cannot be determined**.
   *
   * Only Windows can answer this from JS: the frame state is a Win32 style bit, read back via
   * user32. Elsewhere the runtime exposes no `isFrameless` (verified absent from its own
   * prototype), so the honest answer is null rather than a claim echoing the request we made —
   * which is exactly how a decorated window reported itself as frameless for three rounds.
   */
  frameless: boolean | null;
  width: number;
  height: number;
  /** How the answer was obtained, so a wrong one can be traced. */
  source: "win32" | "gtk" | "runtime" | "none";
}

export interface ChromeState {
  /** True when the window has no OS decoration, so the app must draw its own. */
  frameless: boolean;
  /** True when the OS still provides a titlebar with working min/max/close. */
  nativeDecorations: boolean;
  /** Window buttons the app can actually provide. Close always works; the rest cannot. */
  canMinimize: boolean;
  canMaximize: boolean;
  /** The window's real geometry and frame state, or null when there is no window. */
  actual: MeasuredWindow | null;
  /** True when the app must draw its own edge handles (the platform has no live borders). */
  needsEdgeHandles: boolean;
  /** The platform's resize-border thickness, when it has one. */
  borderPx: number;
  /**
   * Why adoption failed, when it did.
   *
   * Without this the only symptom of a failed adoption is chrome that does not render,
   * which is indistinguishable from chrome that is not implemented — the owner reported
   * "still decoration and no functional chrome" three times with nothing to diagnose.
   */
  adoptError: string | null;
}

/**
 * The window's default and minimum size.
 *
 * 1260x890 is the size the app's layout is designed for; 1040x800 is the point below which the
 * three-pane review screen stops fitting (the timeline plus both side panels).
 */
export const DEFAULT_WINDOW_WIDTH = 1260;
export const DEFAULT_WINDOW_HEIGHT = 890;
export const MIN_WINDOW_WIDTH = 1040;
export const MIN_WINDOW_HEIGHT = 800;

const state: ChromeState = {
  frameless: false,
  nativeDecorations: true,
  // Measured absent from BrowserWindow. Explicit fields rather than omitted, so the UI
  // asks a question instead of assuming an answer.
  canMinimize: false,
  canMaximize: false,
  adoptError: null,
  actual: null,
  needsEdgeHandles: false,
  borderPx: 0,
};

export function chromeState(): ChromeState {
  // Re-measure on every read for the fields that can change behind us (size, maximized) — the
  // chrome controls are drawn from this, and a stale answer is what makes a maximize button
  // toggle the wrong way. The frame state cannot change after adoption, so it is cached.
  const measured = Deno.build.os === "windows" ? measureWin32Window() : null;
  if (measured && measured.frameless !== null) {
    state.actual = measured;
    state.frameless = measured.frameless;
    state.nativeDecorations = !measured.frameless;
  }
  // These depend only on the platform, not on the window, so they are cheap to report on every
  // read and cannot go stale.
  state.needsEdgeHandles = needsEdgeHandles();
  state.borderPx = windowBorderPx();
  return { ...state };
}

/**
 * Remove the OS frame when one is actually present, and record what the window IS.
 *
 * A request for frameless is not evidence a frameless window exists, so this applies the removal
 * first and then measures. On non-Windows nothing is done: the runtimes there honour `frameless`
 * at adoption (the upstream reports concern the webview backend, and the AppImage smoke test is
 * what would confirm it per platform) — so the measured answer degrades to the runtime's.
 */
function applyFrameRemoval(wantFrameless: boolean): void {
  if (!wantFrameless) {
    // Decorated on purpose: the OS titlebar carries the buttons, so the app must NOT draw its
    // own. Claiming them here would put two sets of controls on one window.
    state.frameless = false;
    state.nativeDecorations = true;
    state.canMinimize = false;
    state.canMaximize = false;
    return;
  }
  if (Deno.build.os === "windows") {
    const res = removeNativeFrame();
    if (!res.ok && res.error) {
      // Loud, because the only symptom otherwise is a decorated window with no chrome drawn
      // over it — the exact state that went unexplained for three rounds.
      console.error(`window: could not remove the native frame — ${res.error}`);
    }
    const measured = measureWin32Window();
    const frameless = measured?.frameless ?? false;
    state.actual = measured;
    state.frameless = frameless;
    state.nativeDecorations = !frameless;
    // The app draws its own buttons when there is no frame, so it can always provide all three.
    // Reported as a capability of the CHROME, not of the window class (which has none).
    state.canMinimize = frameless;
    state.canMaximize = frameless;
    console.log(
      `window: measured style=0x${(res.style >>> 0).toString(16).toUpperCase()} ` +
        `frameless=${frameless} ` +
        (measured ? `size=${measured.width}x${measured.height}` : "size=unknown"),
    );
    return;
  }
  // LINUX: GTK3 is already loaded in this process (the launcher links it — measured with ldd on
  // laufey_webview), so the decorations and the window actions come from there. The app had no
  // Linux window handling at all before this, which is why there was no chrome to speak of.
  if (Deno.build.os === "linux") {
    const res = gtkRemoveDecorations();
    if (!res.ok && res.error) {
      // Named, because the only symptom otherwise is a decorated window with no chrome drawn
      // over it — and a compositor that refuses to undecorate is a real possibility on Wayland.
      console.error(`window: could not remove GTK decorations — ${res.error}`);
    }
    const size = windowHandle?.getSize?.();
    // GTK reports the decorated flag back, so this is MEASURED, not echoed. It can legitimately
    // stay true when the compositor refuses, and saying so is the point.
    //
    // TRI-STATE, and the middle value matters: `decorated === null` means GTK could not be asked
    // at all (no window in this process), so the frame state is UNKNOWN — reporting `false` there
    // would be a claim about a window that does not exist. `frameless` below is then the
    // REQUEST, which is what the UI draws chrome on, while `actual.frameless: null` records that
    // it is unconfirmed.
    const measured = res.decorated === null ? null : res.decorated === false;
    const frameless = measured ?? true;
    state.actual = {
      frameless: measured,
      width: size?.[0] ?? 0,
      height: size?.[1] ?? 0,
      source: res.decorated === null ? "runtime" : "gtk",
    };
    state.frameless = frameless;
    state.nativeDecorations = !frameless;
    // gtk_window_iconify / maximize are real, so the app owns these buttons only if the
    // decorations really went away — otherwise the OS titlebar already has them.
    state.canMinimize = frameless;
    state.canMaximize = frameless;
    console.log(
      `window: gtk decorated=${res.decorated} frameless=${frameless} ` +
        `size=${size?.[0] ?? "?"}x${size?.[1] ?? "?"}`,
    );
    return;
  }

  // Any other platform: the frame state cannot be measured, so it is reported as unknown rather
  // than as a claim. Only the size is real (the runtime's own getSize).
  const size = windowHandle?.getSize?.();
  state.actual = size
    ? { frameless: null, width: size[0], height: size[1], source: "runtime" }
    : { frameless: null, width: 0, height: 0, source: "none" };
  state.frameless = true;
  state.nativeDecorations = false;
  state.canMinimize = false;
  state.canMaximize = false;
}

/**
 * Keep the window at or above the minimum size.
 *
 * The runtime has no min-size option, so the floor is enforced by correcting a too-small resize.
 * Called from the window's own resize handler.
 */
export function enforceMinimumSize(): void {
  const size = windowHandle?.getSize?.();
  if (!size) return;
  const [w, h] = size;
  const targetW = Math.max(w, MIN_WINDOW_WIDTH);
  const targetH = Math.max(h, MIN_WINDOW_HEIGHT);
  if (targetW === w && targetH === h) return;
  try {
    windowHandle?.setSize?.(targetW, targetH);
  } catch {
    // A refused resize is cosmetic; never let it break the window.
  }
}

/**
 * Window actions, one implementation per platform behind one name.
 *
 * The UI never asks which OS it is on: it calls these, and each reports what the platform did
 * rather than what was requested. The mechanisms differ (Win32 `ShowWindow`/`SendMessage` versus
 * GTK's `iconify`/`begin_move_drag`) but the contract is the same.
 */
export function minimizeWindow(): boolean {
  if (Deno.build.os === "windows") return winMinimizeWindow();
  if (Deno.build.os === "linux") return gtkIconify();
  return false;
}

export function toggleMaximizeWindow(): { maximized: boolean } | null {
  if (Deno.build.os === "windows") return winToggleMaximize();
  if (Deno.build.os === "linux") return toggleMaximizeGtk();
  return null;
}

export function restoreWindow(): boolean {
  if (Deno.build.os === "windows") return winShowWindow();
  if (Deno.build.os === "linux") return gtkDeiconify();
  return false;
}

/**
 * Start dragging the window from a press in the app's chrome.
 *
 * THE mechanism for a frameless window, on both platforms, and NOT `-webkit-app-region: drag`:
 * that CSS is an Electron extension, this app runs on the `webview` backend, and searching the
 * installed runtime for `app-region` returns zero matches — which is exactly why the chrome could
 * not be dragged. Both platforms hand the move to the OS/toolkit so snapping and drag thresholds
 * behave natively.
 *
 * Returns whether the platform accepted the request; a refusal is reported rather than hidden.
 */
export function beginWindowDrag(x: number, y: number): boolean {
  if (Deno.build.os === "windows") return winBeginDrag();
  if (Deno.build.os === "linux") return gtkBeginMoveDrag(Math.round(x), Math.round(y));
  return false;
}

/** Start resizing from one of the app's own edge handles. */
export function beginWindowResize(edge: ResizeEdge, x: number, y: number): boolean {
  if (Deno.build.os === "windows") {
    // Windows does not need this: WS_THICKFRAME is kept (see win-frame.ts), so the OS's own
    // resize borders are live and the app draws handles only to make them discoverable.
    return false;
  }
  if (Deno.build.os === "linux") return gtkBeginResizeDrag(edge, Math.round(x), Math.round(y));
  return false;
}

/** Whether the app must draw its own edge handles, or the platform's borders already work. */
export function needsEdgeHandles(): boolean {
  if (Deno.build.os === "windows") return false;
  if (Deno.build.os === "linux") return true;
  return true;
}

/** The platform's resize-border thickness in pixels, when it has one. */
export function windowBorderPx(): number {
  if (Deno.build.os === "windows") return winResizeBorderPx();
  return 0;
}

export { winIsMaximized };

/** Options for the adopted window. `frameless` is creation-only, so it is passed here. */
export interface ChromeOptions {
  /** Draw our own chrome and remove the OS decoration. */
  frameless?: boolean;
  title?: string;
  /** Initial size in logical pixels. */
  width?: number;
  height?: number;
  /**
   * Smallest size the user may resize to.
   *
   * The runtime exposes no minimum-size option (verified against its own option set: title,
   * width, height, x, y, resizable, alwaysOnTop, frameless, noActivate, transparentTitlebar),
   * so the floor is enforced on the resize event instead — see `enforceMinimumSize`.
   */
  minWidth?: number;
  minHeight?: number;
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
  const wantFrameless = options.frameless !== false;
  const width = options.width ?? DEFAULT_WINDOW_WIDTH;
  const height = options.height ?? DEFAULT_WINDOW_HEIGHT;
  try {
    // THE one construction. It adopts the window the runtime already opened.
    win = new Ctor({
      // Passed for the record, but MEASURED NOT TO APPLY on this construction — the runtime
      // creates the startup window before JS runs and silently drops `frameless` there
      // (denoland/deno#35969, #35635). `removeNativeFrame` below is what actually removes it on
      // Windows; this line is the correct request for any runtime that fixes it.
      frameless: wantFrameless,
      // Size DOES apply (measured: the default was 800x600, the runtime's own default, i.e.
      // nothing was passed before).
      width,
      height,
      ...(options.title ? { title: options.title } : {}),
    });
    constructed += 1;
    console.log(
      `window: adopted (construction #${constructed}) requested: frameless=${wantFrameless} ` +
        `size=${width}x${height} title=${options.title ?? "none"}`,
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
  // Report what the WINDOW got, not what the caller passed.
  //
  // This module used to set these from `options.frameless`, so it reported `frameless: true`
  // for a window carrying WS_CAPTION|WS_THICKFRAME|WS_SYSMENU on Windows — a full native frame.
  // The UI then drew no chrome (it believed the frame was gone) over a window that had one, and
  // the log backed the wrong answer. The state is now MEASURED.
  applyFrameRemoval(wantFrameless);

  // The runtime exposes no minimum size, so the floor is held here.
  win.addEventListener("resize", () => enforceMinimumSize());

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

/** The adopted window handle, for the operations this module implements on its behalf. */
export function windowHandleRef(): {
  hide?: () => void;
  show?: () => void;
  focus?: () => void;
} | null {
  return windowHandle;
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
