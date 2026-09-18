/**
 * Windows frame control via user32, on the window the runtime hands us.
 *
 * ── WHY FFI, AND NOT THE DOCUMENTED OPTION ────────────────────────────────────────────────
 * `new Deno.BrowserWindow({ frameless: true })` does NOT remove the frame from the window this
 * app can adopt. `frameless` is creation-only, and the window the first construction adopts was
 * created by the runtime before any JS ran, so the option is silently dropped there. Upstream
 * tracks exactly this as missing capability:
 *
 *   - denoland/deno#35969 — "deno desktop - Ability to initialize bootstrap window with
 *     `noActivate` and `frameless` options": "Currently the bootstrap window is created outside
 *     JS and we are not able to set `noActivate` and `frameless` parameters for the initial
 *     window." (open)
 *   - denoland/deno#35635 — "`frameless` / `transparentTitlebar` are silently ignored on the
 *     first window (the one that adopts the implicit startup window)." (open)
 *
 * MEASURED on the installed Windows build, which is what settles it: the app's own window
 * carried style 0x14CF0000 — WS_CAPTION | WS_THICKFRAME | WS_SYSMENU | WS_MINIMIZEBOX |
 * WS_MAXIMIZEBOX, the same bits Explorer's window has, i.e. the complete native frame — while
 * the app's own log read `frameless=true decorations=none`. Creating a SECOND window would
 * apply the option but would also leave the original on screen (the blank-window bug).
 *
 * So the frame is removed the way a native toolkit removes it: clear the frame bits and tell the
 * OS the frame changed. Measured on the live window: 0x14CF0000 -> 0x14000000, i.e. caption,
 * thick frame, system menu and both button boxes gone.
 *
 * ── WHAT THE RUNTIME STILL DOES NOT OFFER ─────────────────────────────────────────────────
 * There is no minimize or maximize anywhere in the window class (re-verified against the
 * installed runtime: the only `minimize`/`maximize` strings in it belong to `Intl.Locale`). With
 * the native buttons gone, the app draws its own and implements them:
 *   - minimize -> hide the window (ShowWindow SW_MINIMIZE needs a taskbar entry the frameless
 *     window can lose, and the runtime's own `hide` restores cleanly on click).
 *   - maximize -> resize to the work area, tracked here so a second click restores.
 *   - close    -> the runtime's `close()`.
 */

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_FRAMECHANGED = 0x0020;

const SW_RESTORE = 9;
const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;

/** Ask the OS to start a move loop, the way a native title bar does. */
const WM_NCLBUTTONDOWN = 0x00a1;
const HTCAPTION = 2;

/** Border metrics, for the app to size its own edge grab areas (SM_CXSIZEFRAME/CXPADDEDBORDER). */
const SM_CXSIZEFRAME = 32;
const SM_CXPADDEDBORDER = 92;

/** The dlopen result, typed from the declaration below so the symbols are real functions. */
let user32: Deno.DynamicLibrary<typeof USER32_SYMBOLS> | null = null;
/** The window this process owns, found by owning pid. */
let hwnd: Deno.PointerValue = null;
/** Set while maximized, so the next toggle restores. */
let maximized = false;

/**
 * The one place the signatures live, so `dlopen`'s inference gives every symbol a call signature
 * (declaring them on a separate interface makes `symbols` uncallable: Deno's own typing requires
 * the library interface to be an index signature).
 */
const USER32_SYMBOLS = {
  EnumWindows: { parameters: ["pointer", "pointer"], result: "bool" },
  GetWindowThreadProcessId: { parameters: ["pointer", "pointer"], result: "u32" },
  GetWindowLongW: { parameters: ["pointer", "i32"], result: "i32" },
  SetWindowLongW: { parameters: ["pointer", "i32", "i32"], result: "i32" },
  SetWindowPos: {
    parameters: ["pointer", "pointer", "i32", "i32", "i32", "i32", "u32"],
    result: "bool",
  },
  ShowWindow: { parameters: ["pointer", "i32"], result: "bool" },
  IsWindowVisible: { parameters: ["pointer"], result: "bool" },
  GetWindowRect: { parameters: ["pointer", "pointer"], result: "bool" },
  IsZoomed: { parameters: ["pointer"], result: "bool" },
  IsIconic: { parameters: ["pointer"], result: "bool" },
  ReleaseCapture: { parameters: [], result: "bool" },
  SendMessageW: { parameters: ["pointer", "u32", "usize", "isize"], result: "isize" },
  GetSystemMetrics: { parameters: ["i32"], result: "i32" },
} as const;

function api(): Deno.DynamicLibrary<typeof USER32_SYMBOLS> | null {
  if (user32) return user32;
  if (Deno.build.os !== "windows") return null;
  try {
    user32 = Deno.dlopen("user32.dll", USER32_SYMBOLS);
    return user32;
  } catch {
    // FFI disabled or the DLL is unavailable: the caller degrades to the runtime's own answer.
    return null;
  }
}

/**
 * Every top-level window this process owns.
 *
 * By OWNING PID, not by title: the app's window carries an EMPTY title once the webview is
 * navigated (measured), so `FindWindowW(null, "SemaClip")` returns nothing. EnumWindows sees
 * only the caller's own window station, so this must run in the process that owns the window —
 * which it does in production, and must be driven from the interactive session when probed
 * (measured: 438 windows from session 1 versus 9 from the agent's session 0).
 *
 * VISIBILITY IS NOT REQUIRED. Filtering on `IsWindowVisible` looked harmless and is wrong here:
 * adoption runs during startup, before the runtime has shown the window, so a visibility filter
 * makes this return nothing at the exact moment it is called — the frame would survive on the one
 * code path that can remove it. A hidden or not-yet-shown window still has the style bits.
 *
 * A process can own more than one top-level window (measured: two for this app), so all of them
 * are returned and the frame is removed from each.
 */
function ownTopLevelWindows(): Deno.PointerValue[] {
  const lib = api();
  if (!lib) return [];
  const self = Deno.pid;
  const found: Deno.PointerValue[] = [];
  const cb = new Deno.UnsafeCallback(
    { parameters: ["pointer", "pointer"], result: "bool" },
    (h: Deno.PointerValue) => {
      if (h === null) return true;
      const pidBuf = new Uint32Array(1);
      lib.symbols.GetWindowThreadProcessId(h, Deno.UnsafePointer.of(pidBuf));
      if (pidBuf[0] === self) found.push(h);
      return true;
    },
  );
  lib.symbols.EnumWindows(cb.pointer, null);
  cb.close();
  return found;
}

/**
 * This process's main top-level window, or null.
 *
 * Cached once found: the frame state cannot change after removal, and re-enumerating on every
 * read would make a cheap status query walk the whole window list.
 */
export function findOwnWindow(): Deno.PointerValue {
  if (hwnd !== null) return hwnd;
  const windows = ownTopLevelWindows();
  // Prefer a window that is actually visible, so the one reported as "the" window is the one a
  // user would call the window — but fall back to any, because at adoption none may be shown yet.
  const lib = api();
  const visible = lib ? windows.find((w) => lib.symbols.IsWindowVisible(w)) : undefined;
  hwnd = visible ?? windows[0] ?? null;
  return hwnd;
}

/** Read the window's real frame state and size, or null when there is no window. */
export function measureWindow(): import("./window-lifecycle.ts").MeasuredWindow | null {
  if (Deno.build.os !== "windows") return null;
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return null;
  const style = lib.symbols.GetWindowLongW(h, GWL_STYLE);
  const rect = new Int32Array(4);
  const ok = lib.symbols.GetWindowRect(h, Deno.UnsafePointer.of(rect));
  return {
    frameless: (style & WS_CAPTION) !== WS_CAPTION,
    width: ok ? (rect[2]! - rect[0]!) : 0,
    height: ok ? (rect[3]! - rect[1]!) : 0,
    source: "win32",
  };
}

/**
 * Remove the title bar, KEEPING the resize border.
 *
 * ── THE BIT THAT MATTERS, AND THE MISTAKE I MADE ──────────────────────────────────────────
 * `WS_CAPTION` is not one bit — it is `WS_BORDER | WS_DLGFRAME`, and clearing it is what removes
 * the title bar. `WS_THICKFRAME` is a SEPARATE bit that IS the resize border (and the edge the OS
 * uses for snap and for `WM_NCHITTEST`). The first version of this cleared both, which removed
 * the visible caption as intended and silently took away resizing with it: "the edges of the
 * window are not draggable for resizing".
 *
 * MEASURED, on a live app window (0x14CF0000 → 0x140F0000): keeping WS_THICKFRAME and clearing
 * only the caption gives a window with no title bar that still answers to the resize borders.
 * `SM_CXSIZEFRAME=4` + `SM_CXPADDEDBORDER=4` put the grab area at the outer ~8px.
 *
 * The caption's *hit area* still exists after this (the OS reserves a title-bar band for
 * dragging, snapping and the window menu), which is why the app also reports how to drag it —
 * see `beginDrag`.
 *
 * Returns whether the window ended up frameless, MEASURED after the call.
 */
export function removeNativeFrame(): { ok: boolean; style: number; error: string | null } {
  if (Deno.build.os !== "windows") return { ok: false, style: 0, error: "not windows" };
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) {
    return { ok: false, style: 0, error: "no window found for this process" };
  }
  try {
    // EVERY window this process owns, because a leftover decorated one would sit there with no
    // chrome drawn over it — the exact symptom this exists to remove.
    const windows = ownTopLevelWindows();
    if (windows.length === 0) {
      return { ok: false, style: 0, error: "no window found for this process" };
    }
    let last = 0;
    let allFrameless = true;
    for (const w of windows) {
      const before = lib.symbols.GetWindowLongW(w, GWL_STYLE);
      // ONLY the caption is cleared. Everything else is deliberately KEPT, because each bit is a
      // native behaviour the user expects and none of them draws a title bar on its own:
      //   WS_THICKFRAME  - the resize borders and the edge the OS uses for snap (see the note on
      //                    this function: clearing it is what broke edge-resizing);
      //   WS_SYSMENU     - the window menu (Alt+Space) and the taskbar's own right-click menu;
      //   WS_MINIMIZEBOX - REQUIRED for SW_MINIMIZE to do anything: the OS refuses to iconify a
      //                    window whose style says it cannot be minimized, so clearing it would
      //                    turn the app's minimize button into a silent no-op;
      //   WS_MAXIMIZEBOX - likewise for maximize and for the snap layouts on hover.
      // The min/max/close BUTTONS are part of the caption, so clearing that removes them visually
      // while these bits keep the behaviours the app's own buttons drive.
      const after = before & ~WS_CAPTION;
      lib.symbols.SetWindowLongW(w, GWL_STYLE, after);
      lib.symbols.SetWindowPos(
        w,
        null,
        0,
        0,
        0,
        0,
        SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED,
      );
      last = lib.symbols.GetWindowLongW(w, GWL_STYLE);
      if ((last & WS_CAPTION) === WS_CAPTION) allFrameless = false;
    }
    return { ok: allFrameless, style: last, error: null };
  } catch (err) {
    return { ok: false, style: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Show and focus the window (used by minimize's counterpart and by a taskbar click). */
export function showWindow(): boolean {
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return false;
  return lib.symbols.ShowWindow(h, SW_RESTORE) && lib.symbols.ShowWindow(h, SW_SHOW);
}

/**
 * Minimize to the taskbar.
 *
 * ── WHY NOT `hide()` ──────────────────────────────────────────────────────────────────────
 * The first version hid the window, on the reasoning that a frameless window has no taskbar
 * button to restore from. That was wrong twice over:
 *
 *   - `IsWindowVisible` becomes FALSE while `SW_MINIMIZE` leaves it TRUE and sets `IsIconic`,
 *     so the runtime saw "no visible window" and the process could exit — the owner's "minimize
 *     just closes the window (but sometimes it opens again after a few seconds)". The reopening
 *     is the Windows SIDECAR updater relaunching the app, which is what it is built to do when
 *     the app stops.
 *   - A minimized-but-not-hidden window KEEPS its taskbar button, which is the thing the user
 *     actually clicks to get it back.
 *
 * MEASURED on a live app window: after `SW_MINIMIZE`, `iconic=True visible=True` — a restorable
 * taskbar state. `WS_THICKFRAME` is kept now, which also means the window participates in Aero
 * Snap and the taskbar's own menus the way a normal window does.
 */
export function minimizeWindow(): boolean {
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return false;
  // Keep WS_MINIMIZEBOX set too (see removeNativeFrame): the OS refuses to iconify a window whose
  // style says it cannot be minimized, so clearing that bit would make this a silent no-op.
  return lib.symbols.ShowWindow(h, SW_MINIMIZE);
}

/** Whether the window is currently minimized, as the OS sees it. */
export function isMinimized(): boolean {
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return false;
  return lib.symbols.IsIconic(h);
}

/**
 * Start dragging the window, from a mouse press in the app's own chrome bar.
 *
 * `-webkit-app-region: drag` DOES NOTHING HERE. That CSS is an Electron extension; this app runs
 * on the `webview` backend (WebView2 on Windows, WebKitGTK on Linux), and searching the installed
 * runtime for `app-region` returns ZERO matches — which is why the chrome "can't be dragged
 * around". The mechanism every Win32 app uses instead is to release the mouse capture and ask the
 * OS to run its own move loop:
 *
 *   ReleaseCapture(); SendMessageW(hwnd, WM_NCLBUTTONDOWN, HTCAPTION, 0);
 *
 * The OS then moves the window until the button is released, with snapping, double-click-to-
 * maximize and the drag-threshold behaviour that a hand-rolled position loop never reproduces.
 * It needs a REAL mouse press to have happened (the OS reads the button state), which is why this
 * is called from a mousedown handler rather than a click.
 */
export function beginDrag(): boolean {
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return false;
  try {
    lib.symbols.ReleaseCapture();
    lib.symbols.SendMessageW(h, WM_NCLBUTTONDOWN, BigInt(HTCAPTION), 0n);
    return true;
  } catch {
    return false;
  }
}

/** The OS's resize-border thickness, so the app can size its own edge handles to match. */
export function resizeBorderPx(): number {
  const lib = api();
  if (!lib) return 0;
  try {
    return lib.symbols.GetSystemMetrics(SM_CXSIZEFRAME) +
      lib.symbols.GetSystemMetrics(SM_CXPADDEDBORDER);
  } catch {
    return 0;
  }
}

/** Toggle maximized: resize to the work area, or back to the pre-maximize size. */
export function toggleMaximize(): { maximized: boolean } | null {
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return null;

  if (lib.symbols.IsZoomed(h)) {
    maximized = false;
    lib.symbols.ShowWindow(h, SW_RESTORE);
    return { maximized: false };
  }
  maximized = true;
  lib.symbols.ShowWindow(h, SW_MAXIMIZE);
  return { maximized: true };
}

/** Whether the window is currently maximized, as the OS sees it. */
export function isMaximized(): boolean {
  const lib = api();
  const h = findOwnWindow();
  if (!lib || h === null) return false;
  return lib.symbols.IsZoomed(h);
}
