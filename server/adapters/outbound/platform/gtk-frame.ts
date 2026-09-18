/**
 * Linux window control via GTK3, for the window the runtime hands us.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * The Windows path removes the frame with user32. Linux needs its own, and the app had NONE: the
 * chrome bar was drawn only when the server reported a frameless window, and nothing on Linux ever
 * made it frameless, so there was no chrome to speak of. The owner asked for it to be "there and
 * functional" on Linux too.
 *
 * ── WHY GTK AND NOT SOMETHING ELSE ───────────────────────────────────────────────────────────
 * The Linux launcher links `libgtk-3.so.0` and `libwebkit2gtk-4.1.so.0` (measured with `ldd` on
 * laufey_webview), so GTK3 is ALREADY loaded in the process that owns the window. GTK4 would be a
 * second toolkit in the same process and cannot talk to a GTK3 window at all.
 *
 * GTK3 exposes exactly what this needs (verified present in `libgtk-3.so.0`):
 *   gtk_window_list_toplevels   - find the window without a handle from JS
 *   gtk_window_set_decorated    - the server-side decorated flag
 *   gtk_window_iconify/deiconify - real minimize/restore, with a taskbar entry
 *   gtk_window_maximize/unmaximize/is_maximized
 *   gtk_window_begin_move_drag  - the OS-run move loop, WITH the compositor's snap and
 *                                 drag-threshold behaviour (GTK4 dropped this call)
 *   gtk_window_begin_resize_drag - the OS-run resize loop for the app's own edge handles
 *   gtk_window_present_with_time
 *
 * `begin_move_drag`/`begin_resize_drag` are the GTK equivalents of the Win32
 * `WM_NCLBUTTONDOWN`/`HTCAPTION` trick: the app says "the user started a move here" and the
 * toolkit does the rest. Hand-rolling a position loop from `setPosition` cannot reproduce edge
 * snapping, and the compositor would fight it.
 */

/** GdkWindowEdge, whose ORDER is part of the ABI. */
export type ResizeEdge = "nw" | "n" | "ne" | "w" | "e" | "sw" | "s" | "se";

const GDK_EDGE: Record<ResizeEdge, number> = {
  nw: 0,
  n: 1,
  ne: 2,
  w: 3,
  e: 4,
  sw: 5,
  s: 6,
  se: 7,
};

/** A pointer to a GtkWindow, opaque to JS. */
type GtkWindowPtr = Deno.PointerValue;

const GTK_SYMBOLS = {
  gtk_window_list_toplevels: { parameters: [], result: "pointer" },
  gtk_window_set_decorated: { parameters: ["pointer", "i32"], result: "void" },
  gtk_window_get_decorated: { parameters: ["pointer"], result: "i32" },
  gtk_window_iconify: { parameters: ["pointer"], result: "void" },
  gtk_window_deiconify: { parameters: ["pointer"], result: "void" },
  gtk_window_maximize: { parameters: ["pointer"], result: "void" },
  gtk_window_unmaximize: { parameters: ["pointer"], result: "void" },
  gtk_window_is_maximized: { parameters: ["pointer"], result: "i32" },
  gtk_window_present: { parameters: ["pointer"], result: "void" },
  gtk_window_present_with_time: { parameters: ["pointer", "u32"], result: "void" },
  gtk_window_begin_move_drag: {
    parameters: ["pointer", "i32", "i32", "i32", "u32"],
    result: "void",
  },
  gtk_window_begin_resize_drag: {
    parameters: ["pointer", "i32", "i32", "i32", "i32", "u32"],
    result: "void",
  },
  gtk_get_current_event_time: { parameters: [], result: "u32" },
  gtk_widget_get_visible: { parameters: ["pointer"], result: "i32" },
  gtk_widget_is_visible: { parameters: ["pointer"], result: "i32" },
  // GList traversal: GTK returns a GList of GtkWindow*.
  g_list_length: { parameters: ["pointer"], result: "u32" },
} as const;

/** GList field offsets in a `struct _GList { gpointer data; GList *next, *prev; }`. */
const GLIST_DATA_OFFSET = 0;
const GLIST_NEXT_OFFSET = 8;

let gtk: Deno.DynamicLibrary<typeof GTK_SYMBOLS> | null = null;
let cached: GtkWindowPtr = null;

function api(): Deno.DynamicLibrary<typeof GTK_SYMBOLS> | null {
  if (gtk) return gtk;
  if (Deno.build.os !== "linux") return null;
  try {
    gtk = Deno.dlopen("libgtk-3.so.0", GTK_SYMBOLS);
    return gtk;
  } catch {
    // No GTK3 in this process (a `deno run` without the launcher, or a CEF build): the caller
    // degrades to the runtime's own answer, and reports that it did.
    return null;
  }
}

/** Read a pointer-sized field out of a native struct. */
function readPtr(base: Deno.PointerValue, offset: number): Deno.PointerValue {
  if (base === null) return null;
  const view = new Deno.UnsafePointerView(base);
  return view.getPointer(offset);
}

/**
 * The process's main GtkWindow, or null.
 *
 * `gtk_window_list_toplevels` is the only way in from JS — the runtime gives no native handle
 * (its `getNativeWindow` wraps a WebGPU surface, not a window pointer). The list is walked to its
 * end so the LAST toplevel wins: GTK appends in creation order, and dialogs come and go.
 *
 * Cached once found: a window does not change identity, and this walks a linked list.
 */
export function findWindow(): GtkWindowPtr {
  if (cached !== null) return cached;
  const lib = api();
  if (!lib) return null;
  try {
    let node = lib.symbols.gtk_window_list_toplevels();
    let last: GtkWindowPtr = null;
    // Bounded: a malformed list must not spin forever.
    for (let i = 0; node !== null && i < 64; i++) {
      const win = readPtr(node, GLIST_DATA_OFFSET);
      if (win !== null) last = win;
      node = readPtr(node, GLIST_NEXT_OFFSET);
    }
    cached = last;
    return cached;
  } catch {
    return null;
  }
}

/** True when the window's decorations are off, as GTK reports it (not as the app requested). */
export function measureDecorated(): boolean | null {
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) return null;
  try {
    return lib.symbols.gtk_window_get_decorated(win) !== 0;
  } catch {
    return null;
  }
}

/**
 * Turn the server-side decorations off.
 *
 * GTK applies this through the window manager, so the result depends on the compositor honouring
 * it — which is why the state is MEASURED afterwards (`measureDecorated`) rather than assumed.
 * Returns whether decorations ended up off.
 */
export function removeDecorations(): { ok: boolean; decorated: boolean | null; error: string | null } {
  if (Deno.build.os !== "linux") return { ok: false, decorated: null, error: "not linux" };
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) {
    return { ok: false, decorated: null, error: "no GTK window found in this process" };
  }
  try {
    lib.symbols.gtk_window_set_decorated(win, 0);
    const decorated = lib.symbols.gtk_window_get_decorated(win) !== 0;
    return { ok: !decorated, decorated, error: null };
  } catch (err) {
    return {
      ok: false,
      decorated: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Start an OS-run move, from a mouse press in the app's chrome bar.
 *
 * The coordinates are the press's position in WINDOW coordinates, and the button is 1 (left).
 * The timestamp comes from GTK's current event so the compositor can correlate the request with
 * the press it already saw — passing 0 makes some compositors ignore it (the "starts dragging from
 * wherever the cursor happens to be" failure).
 */
export function beginMoveDrag(x: number, y: number, button = 1): boolean {
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) return false;
  try {
    const t = lib.symbols.gtk_get_current_event_time();
    lib.symbols.gtk_window_begin_move_drag(win, button, x, y, t);
    return true;
  } catch {
    return false;
  }
}

/** Start an OS-run resize from one of the app's edge handles. */
export function beginResizeDrag(edge: ResizeEdge, x: number, y: number, button = 1): boolean {
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) return false;
  try {
    const t = lib.symbols.gtk_get_current_event_time();
    lib.symbols.gtk_window_begin_resize_drag(win, GDK_EDGE[edge], button, x, y, t);
    return true;
  } catch {
    return false;
  }
}

/** Minimize, with a taskbar entry the user can click to restore. */
export function iconify(): boolean {
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) return false;
  try {
    lib.symbols.gtk_window_iconify(win);
    return true;
  } catch {
    return false;
  }
}

export function deiconify(): boolean {
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) return false;
  try {
    lib.symbols.gtk_window_deiconify(win);
    lib.symbols.gtk_window_present(win);
    return true;
  } catch {
    return false;
  }
}

/** Toggle maximized, reporting what GTK says afterwards. */
export function toggleMaximizeGtk(): { maximized: boolean } | null {
  const lib = api();
  const win = findWindow();
  if (!lib || win === null) return null;
  try {
    if (lib.symbols.gtk_window_is_maximized(win) !== 0) {
      lib.symbols.gtk_window_unmaximize(win);
      return { maximized: lib.symbols.gtk_window_is_maximized(win) !== 0 };
    }
    lib.symbols.gtk_window_maximize(win);
    return { maximized: lib.symbols.gtk_window_is_maximized(win) !== 0 };
  } catch {
    return null;
  }
}
