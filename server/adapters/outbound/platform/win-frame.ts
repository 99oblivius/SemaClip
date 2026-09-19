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
 * So the frame is removed the way a native toolkit removes it: clear the CAPTION only and tell the
 * OS the frame changed. Measured on the live window: 0x14CF0000 -> 0x140F0000 — the title bar and
 * its buttons gone, `WS_THICKFRAME` deliberately kept because that bit IS the resize border (see
 * the note on `removeNativeFrame`).
 *
 * ── WHAT THE RUNTIME STILL DOES NOT OFFER ─────────────────────────────────────────────────
 * There is no minimize or maximize anywhere in the window class (re-verified against the
 * installed runtime: the only `minimize`/`maximize` strings in it belong to `Intl.Locale`). With
 * the native buttons gone, the app draws its own and implements them against the OS:
 *   - minimize -> `SW_MINIMIZE`, so the window keeps a taskbar button (see `minimizeWindow`).
 *   - maximize -> `SW_MAXIMIZE` / `SW_RESTORE`.
 *   - close    -> the runtime's `close()`.
 *
 * ── THE MINIMUM SIZE, AND WHY IT IS NOT ENFORCED NATIVELY ─────────────────────────────────
 * The runtime exposes no minimum-size option, and there are only two native channels for one:
 *
 *   1. `WM_GETMINMAXINFO`, which requires INSTALLING A WINDOW PROC on a window this process does not
 *      own the proc of. Measured: a Deno FFI callback installed with `SetWindowLongPtrW(GWLP_WNDPROC)`
 *      HANGS the app the first time Windows sends a message — it was tried both thread-safe and
 *      plain, with per-step logging, and the launch never got past window selection. A hook that can
 *      wedge the app is far worse than the cosmetic problem it fixes, so it was removed.
 *   2. `WM_SIZING`/`WM_WINDOWPOSCHANGING`, same requirement, same risk.
 *
 * So the floor is enforced where it is safe: the resize event corrects an undersized window (see
 * `enforceMinimumSize`). That CAN look like a snap-back, which is the honest trade — the alternative
 * measured as a hang. If Deno ever exposes a minimum size, this is the place to delete.
 */

const GWL_STYLE = -16;
const GWL_EXSTYLE = -20;
const WS_CAPTION = 0x00c00000;
const WS_THICKFRAME = 0x00040000;
const WS_SYSMENU = 0x00080000;
const WS_MINIMIZEBOX = 0x00020000;
const WS_MAXIMIZEBOX = 0x00010000;
/**
 * DWM border colour, for the thin frame DWM paints around a resizable window.
 *
 * `WS_THICKFRAME` is what keeps edge-resizing alive, and DWM draws a ~1px frame for it. That frame
 * follows the SYSTEM's light/dark setting, which is why a dark app shows a thin light bar along the
 * top: it is not the caption (that bit is cleared) and not the app's own paint. This attribute is
 * the documented way to set its colour, so the app can make it match its own background.
 */
const DWMWA_BORDER_COLOR = 34;
/**
 * Immersive dark mode, which also darkens the frame DWM draws.
 *
 * 20 on Windows 10 20H1+ and Windows 11; 19 on the earliest builds that had the feature. Both are
 * attempted, newest first, because a wrong attribute index is simply ignored.
 */
const DWMWA_USE_IMMERSIVE_DARK_MODE = 20;
const DWMWA_USE_IMMERSIVE_DARK_MODE_OLD = 19;

/**
 * The app's foundation colour (`--color-foundation: #0b0b10` in app.css) as a Win32 COLORREF.
 *
 * COLORREF is `0x00BBGGRR`, the reverse of the usual RGB hex: `#0b0b10` is R=0x0b G=0x0b B=0x10,
 * so the value is `(B << 16) | (G << 8) | R`. Painted on DWM's frame it makes the 1px border
 * vanish into the app's own background instead of showing the system's light grey.
 */
const FOUNDATION_COLORREF = (0x10 << 16) | (0x0b << 8) | 0x0b;

/** Not a frame bit: a DISABLED window ignores the mouse, so it can never be the drag target. */
const WS_DISABLED = 0x08000000;
/** The runtime's own helpers are popups; the app's window is not. */
const WS_POPUP = 0x80000000;

const SWP_NOSIZE = 0x0001;
const SWP_NOMOVE = 0x0002;
const SWP_NOZORDER = 0x0004;
const SWP_FRAMECHANGED = 0x0020;

const SW_RESTORE = 9;
const SW_SHOW = 5;
const SW_MINIMIZE = 6;
const SW_MAXIMIZE = 3;
/** The one flag the drag needs that the block above does not already define. */
const SWP_NOACTIVATE = 0x0010;

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
  GetClassNameW: { parameters: ["pointer", "buffer", "i32"], result: "i32" },
  IsWindow: { parameters: ["pointer"], result: "bool" },
  IsZoomed: { parameters: ["pointer"], result: "bool" },
  IsIconic: { parameters: ["pointer"], result: "bool" },
  GetCursorPos: { parameters: ["pointer"], result: "bool" },
  GetSystemMetrics: { parameters: ["i32"], result: "i32" },
} as const;

/**
 * dwmapi, for the frame colour. Loaded lazily and separately: DWM is absent on the Server Core
 * images and on any Windows older than Vista, and a missing dwmapi must not stop the app from
 * starting — the frame simply keeps its system colour.
 */
const DWM_SYMBOLS = {
  DwmSetWindowAttribute: { parameters: ["pointer", "u32", "pointer", "u32"], result: "i32" },
} as const;

let dwmapi: Deno.DynamicLibrary<typeof DWM_SYMBOLS> | null = null;
function dwm(): Deno.DynamicLibrary<typeof DWM_SYMBOLS> | null {
  if (dwmapi) return dwmapi;
  if (Deno.build.os !== "windows") return null;
  try {
    dwmapi = Deno.dlopen("dwmapi.dll", DWM_SYMBOLS);
    return dwmapi;
  } catch {
    return null;
  }
}

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
 * A process can own more than one top-level window (the count varies with the runtime's internal
 * helpers — a live check found one, earlier ones two), so all of them are returned and the frame is
 * removed from each.
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
 * This process's main APPLICATION window, or null.
 *
 * ── THE RULE, AND THE TWO WRONG ONES BEFORE IT ────────────────────────────────────────────
 * The app window is the process's LARGEST top-level window that is neither DISABLED nor a POPUP.
 * That is all, and each clause is here because the alternative misfired on a real build:
 *
 *   - VISIBILITY CANNOT BE REQUIRED. Adoption runs during startup, BEFORE the runtime shows the
 *     window (documented, and the reason an earlier visibility filter returned nothing). Ranking
 *     visible-first and falling back to "largest of anything" is what selected a hidden, DISABLED
 *     popup — and every native call after that (frame removal, drag, minimum size) was aimed at a
 *     window nobody can see, while the real one kept its title bar.
 *   - `framed` (caption/thickframe) CANNOT BE REQUIRED. This module's own job is to CLEAR the
 *     caption, so a window that has already been processed would stop qualifying.
 *   - A DISABLED window ignores the mouse, so as a drag target it is inert by definition. A POPUP
 *     is the runtime's own helper. Excluding both leaves the app window and nothing else.
 *
 * Among what remains, a VISIBLE one wins (it is the window the user has), and otherwise the
 * largest — because at adoption the app window exists but is not shown yet.
 *
 * Every candidate is logged with its style, class and size, so which window was chosen — and what
 * the alternatives were — is answerable from the owner's log alone. That diagnostic is what this
 * whole class of bug was missing.
 */
export function findOwnWindow(): Deno.PointerValue {
  const lib = api();
  if (!lib) return null;
  // A cached handle is reused only while it is still a usable window. `IsWindow` catches one that
  // was destroyed, and the DISABLED check catches the case that caused the reported symptoms: a
  // hidden, disabled placeholder picked during startup and then kept for ever, while the real
  // window kept its title bar and never received the drag or the size floor.
  if (hwnd !== null) {
    if (lib.symbols.IsWindow(hwnd)) {
      const cachedStyle = lib.symbols.GetWindowLongW(hwnd, GWL_STYLE);
      if ((cachedStyle & WS_DISABLED) === 0 && (cachedStyle & WS_POPUP) === 0) return hwnd;
    }
    hwnd = null;
  }
  const windows = ownTopLevelWindows();

  /**
   * Describe a window for the log — and NEVER throw.
   *
   * This diagnostic is what made the "every window fix missed" class of bug answerable from the
   * owner's log. It also killed the app once: a pointer was interpolated directly, a Deno FFI
   * pointer has no primitive conversion, and the resulting TypeError propagated out of
   * `removeNativeFrame` and out of `main.ts` — so a LOGGING fault meant no window setup at all, and
   * the app exited before it could show anything. Diagnosis must never be able to do that.
   */
  const describe = (w: Deno.PointerValue): string => {
    try {
      const style = lib.symbols.GetWindowLongW(w, GWL_STYLE);
      const rect = new Int32Array(4);
      lib.symbols.GetWindowRect(w, Deno.UnsafePointer.of(rect));
      const classes = new Uint8Array(64);
      lib.symbols.GetClassNameW(w, classes, 32);
      const className = new TextDecoder("utf-16le").decode(classes).replace(/\0.*$/s, "");
      // The pointer address as a NUMBER: interpolating the pointer itself is what threw.
      return `hwnd=${Deno.UnsafePointer.value(w)} class=${className} ` +
        `style=0x${(style >>> 0).toString(16).toUpperCase()} ` +
        `${rect[2]! - rect[0]!}x${rect[3]! - rect[1]!} ` +
        `visible=${lib.symbols.IsWindowVisible(w)} ` +
        `disabled=${(style & WS_DISABLED) !== 0} popup=${(style & WS_POPUP) !== 0}`;
    } catch (err) {
      return `hwnd=? (describe failed: ${err instanceof Error ? err.message : String(err)})`;
    }
  };

  const candidates = windows.map((w) => {
    const style = lib.symbols.GetWindowLongW(w, GWL_STYLE);
    const rect = new Int32Array(4);
    lib.symbols.GetWindowRect(w, Deno.UnsafePointer.of(rect));
    return {
      w,
      area: Math.max(0, rect[2]! - rect[0]!) * Math.max(0, rect[3]! - rect[1]!),
      visible: lib.symbols.IsWindowVisible(w),
      disabled: (style & WS_DISABLED) !== 0,
      popup: (style & WS_POPUP) !== 0,
    };
  });
  console.log(
    `window: candidates (${candidates.length}): ` + candidates.map((c) => describe(c.w)).join(" | "),
  );

  const sane = candidates.filter((c) => !c.disabled && !c.popup).sort((a, b) => b.area - a.area);
  const pick = sane.find((c) => c.visible) ?? sane[0] ?? null;
  if (pick === null) {
    // Nothing that can be the app window yet. NOT cached, so the next call re-resolves — a
    // startup-order race must not cost the window every later operation.
    console.error("window: no candidate is usable as the app window yet");
    return null;
  }
  hwnd = pick.w;
  console.log(`window: chose ${describe(pick.w)}`);
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
    // ONLY the window that was CHOSEN as the app window.
    //
    // The first version looped over EVERY top-level window the process owns, "so a leftover decorated
    // one could not sit there" — which is wrong twice over, and the log is what gave it away:
    //
    //   * It reported the style of the LAST window it touched, so `measured style=` described
    //     whichever window happened to be enumerated last. This process owns two IME helpers
    //     (`IME`, `MSCTFIME UI`, style 0x8C000000), so the log insisted the app window was
    //     0x8C000000 — WS_POPUP|WS_CLIPSIBLINGS|WS_DISABLED, no caption, no thickframe — while an
    //     external probe of the same window read 0x140F0000. A whole investigation was built on that
    //     one misleading number.
    //   * It CLEARED THE CAPTION off the IME windows. Those are the OS input-method windows; their
    //     style is not the app's to edit, and a window with its caption cleared is not what the IME
    //     expects.
    //
    // A window the app has not chosen is not the app's to modify.
    const before = lib.symbols.GetWindowLongW(h, GWL_STYLE);
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
    lib.symbols.SetWindowLongW(h, GWL_STYLE, after);
    lib.symbols.SetWindowPos(
      h,
      null,
      0,
      0,
      0,
      0,
      SWP_NOSIZE | SWP_NOMOVE | SWP_NOZORDER | SWP_FRAMECHANGED,
    );
    const confirmed = lib.symbols.GetWindowLongW(h, GWL_STYLE);
    return { ok: (confirmed & WS_CAPTION) !== WS_CAPTION, style: confirmed, error: null };
  } catch (err) {
    return { ok: false, style: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Colour the frame DWM draws, and ask for dark mode.
 *
 * The thin light bar along the top of a dark app is DWM's frame: `WS_THICKFRAME` keeps resizing
 * alive and DWM paints a ~1px border for it in the SYSTEM's light/dark colour, which the app's own
 * CSS cannot influence. `DWMWA_BORDER_COLOR` sets that colour directly, and
 * `DWMWA_USE_IMMERSIVE_DARK_MODE` darkens the rest of the frame chrome DWM still owns.
 *
 * Both are best-effort: DWM may be absent (Server Core) or the build may predate the attribute, and
 * a frame that keeps the system colour is cosmetic. The result is MEASURED (the HRESULT) so a
 * silent no-op is visible in the log rather than assumed to have worked.
 */
export function applyDwmFrame(options: { borderColor?: number; dark?: boolean } = {}): {
  border: number;
  dark: number;
} {
  const lib = dwm();
  const h = findOwnWindow();
  if (!lib || h === null) return { border: -1, dark: -1 };
  const out = { border: -1, dark: -1 };
  try {
    if (options.dark !== false) {
      const value = new Int32Array([1]);
      out.dark = lib.symbols.DwmSetWindowAttribute(
        h,
        DWMWA_USE_IMMERSIVE_DARK_MODE,
        Deno.UnsafePointer.of(value),
        4,
      );
      if (out.dark !== 0) {
        // Older builds use 19. Retried rather than assumed, because a wrong index is ignored.
        out.dark = lib.symbols.DwmSetWindowAttribute(
          h,
          DWMWA_USE_IMMERSIVE_DARK_MODE_OLD,
          Deno.UnsafePointer.of(value),
          4,
        );
      }
    }
    if (options.borderColor !== undefined) {
      // COLORREF is 0x00BBGGRR — the reverse of the usual RGB hex.
      const color = new Int32Array([options.borderColor & 0xffffff]);
      out.border = lib.symbols.DwmSetWindowAttribute(
        h,
        DWMWA_BORDER_COLOR,
        Deno.UnsafePointer.of(color),
        4,
      );
    }
  } catch {
    // Reported through the sentinel values; never fatal.
  }
  return out;
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
 * Move the window so the point that was grabbed stays under the cursor.
 *
 * ── WHY THIS IS NOT THE OS MOVE LOOP ──────────────────────────────────────────────────────
 * The obvious Win32 idiom is `ReleaseCapture()` + `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION, pt)`,
 * which hands the drag to the OS. It DOES NOT WORK HERE, and it is not a matter of getting the
 * parameters right: that handoff needs the mouse-down to be owned by the window that will run the
 * move loop, and in a WebView2-hosted window the mouse capture during a press is held by WebView2's
 * own process. `ReleaseCapture()` from this thread therefore cannot hand the drag off — measured
 * symptom: `SendMessage` returns success, the app reports success, and the window never moves.
 * (Reported and fixed the same way by another WebView2 app: gwdevhub/slopterm#77 — it removed
 * exactly this code as "wrong mechanism for a webview".)
 *
 * The mechanism that does work is to follow the pointer ourselves:
 *
 *   - The press records where inside the window it landed (the "grab offset").
 *   - Each subsequent move reads the REAL cursor position and puts the window at
 *     `cursor - grabOffset`.
 *
 * Doing it server-side is deliberate. The cursor is read with `GetCursorPos` and the window is
 * moved with `SetWindowPos`, both in the same physical-pixel space, so there is no client/screen or
 * CSS/physical conversion to get wrong — and `devicePixelRatio` scaling never enters the picture.
 * It also makes the behaviour testable: a synthetic pointer move is enough to observe the window
 * move, which the OS move loop could never be driven by.
 *
 * Returns whether the move succeeded; a refusal is reported rather than hidden.
 */

/** The point inside the window that a drag grabbed, in screen pixels. Null when not dragging. */
let dragGrabX: number | null = null;
let dragGrabY: number | null = null;
/** The cursor position at grab time, so the first move is computed as a delta and cannot jump. */
let dragCursorX = 0;
let dragCursorY = 0;

/** Point the OS reports for the cursor, in physical pixels. */
function cursorPos(): { x: number; y: number } | null {
  const lib = api();
  if (!lib) return null;
  try {
    const pt = new Int32Array(2);
    if (!lib.symbols.GetCursorPos(Deno.UnsafePointer.of(pt))) return null;
    return { x: pt[0]!, y: pt[1]! };
  } catch {
    return null;
  }
}

/** The window's top-left in screen pixels. */
function windowOrigin(h: Deno.PointerValue): { x: number; y: number } | null {
  const lib = api();
  if (!lib) return null;
  try {
    const r = new Int32Array(4);
    if (!lib.symbols.GetWindowRect(h, Deno.UnsafePointer.of(r))) return null;
    return { x: r[0]!, y: r[1]! };
  } catch {
    return null;
  }
}

/**
 * Record the grab offset for a drag that is starting.
 *
 * `clientX/clientY` are the DOM press coordinates, which are already window-relative — the offset
 * into the window is exactly what following the pointer needs, so no coordinate conversion happens
 * here at all. The cursor is read only to seed the delta.
 */
export function beginDrag(clientX: number, clientY: number): boolean {
  const h = findOwnWindow();
  const cur = cursorPos();
  if (h === null || !cur) return false;
  dragGrabX = Math.round(clientX);
  dragGrabY = Math.round(clientY);
  dragCursorX = cur.x;
  dragCursorY = cur.y;
  return true;
}

/**
 * Continue a drag: put the window where the pointer says, keeping the grab point fixed.
 *
 * Called on every pointer move while the button is held. The delta form (cursor now vs cursor at
 * grab) rather than an absolute `cursor - grabOffset` is what keeps this correct when the window is
 * moved by something else mid-drag, and it makes a synthetic test unambiguous.
 */
export function continueDrag(): { x: number; y: number } | null {
  if (dragGrabX === null || dragGrabY === null) return null;
  const lib = api();
  const h = findOwnWindow();
  const cur = cursorPos();
  if (!lib || h === null || !cur) return null;
  const origin = windowOrigin(h);
  if (!origin) return null;
  // Where the window must go so the grabbed point sits under the cursor again.
  const targetX = cur.x - dragGrabX;
  const targetY = cur.y - dragGrabY;
  try {
    lib.symbols.SetWindowPos(
      h,
      null,
      targetX,
      targetY,
      0,
      0,
      SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE,
    );
  } catch {
    return null;
  }
  return { x: targetX, y: targetY };
}

/** End a drag. Idempotent, so a lost mouse-up cannot leave a stale grab offset behind. */
export function endDrag(): void {
  dragGrabX = null;
  dragGrabY = null;
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
