/**
 * ONE window per process. A second construction opens a second window.
 *
 * The reported bug: "when I launch there is an additional blank 'SemaClip dev' window
 * both on Windows and Linux". Cause: `new Deno.BrowserWindow()` ADOPTS the implicit
 * startup window on the first call and OPENS A NEW WINDOW on every call after that
 * (deno docs, BrowserWindow). The module constructed one in each of adopt, setTitle and
 * close, so merely setting the title spawned a blank window and applied the title to
 * that one instead of the window showing the app.
 *
 * These tests install a fake BrowserWindow that COUNTS constructions, so the invariant
 * is asserted directly rather than inferred from behaviour.
 */
import { assert, assertEquals } from "@std/assert";

type FakeWin = {
  addEventListener(type: string, fn: () => void): void;
  setTitle(t: string): void;
  close(): void;
  getSize(): [number, number];
  setSize(w: number, h: number): void;
  hide(): void;
};

/** Install a counting fake and a desktop-runtime marker; returns a restore function. */
function withFakeWindow(
  fn: (
    counts: { constructed: number; titles: string[]; closes: number; opts: Record<string, unknown> },
  ) => Promise<void>,
  /** Constructor options the fake should record, when the call is the one under test. */
  recordOpts = false,
): () => Promise<void> {
  const counts = {
    constructed: 0,
    titles: [] as string[],
    closes: 0,
    opts: {} as Record<string, unknown>,
  };
  const deno = Deno as Record<string, unknown>;
  const realBW = deno.BrowserWindow;
  const realAddr = Deno.env.get("DENO_SERVE_ADDRESS");
  const realExit = Deno.exit;

  deno.BrowserWindow = function (this: FakeWin, options?: Record<string, unknown>) {
    counts.constructed += 1;
    if (recordOpts && options) counts.opts = options;
    this.addEventListener = () => {};
    this.setTitle = (t: string) => counts.titles.push(t);
    // The minimum-size guard reads and corrects the size, so the fake must carry both.
    this.getSize = () => [800, 600];
    this.setSize = () => {};
    this.hide = () => {};
    this.close = () => {
      counts.closes += 1;
    };
  };
  // Mark the desktop runtime so the guards let the code run.
  Deno.env.set("DENO_SERVE_ADDRESS", "tcp:127.0.0.1:1");
  // Deny exiting the test process.
  (Deno as Record<string, unknown>).exit = () => {
    throw new Error("Deno.exit called during a test");
  };

  return async () => {
    try {
      await fn(counts);
    } finally {
      deno.BrowserWindow = realBW;
      (Deno as Record<string, unknown>).exit = realExit;
      if (realAddr === undefined) Deno.env.delete("DENO_SERVE_ADDRESS");
      else Deno.env.set("DENO_SERVE_ADDRESS", realAddr);
    }
  };
}

Deno.test("adopting, titling and closing constructs exactly ONE window", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}one`
    );
    mod.adoptWindowLifecycle({ title: "SemaClip 26.183" });
    mod.setWindowTitle("SemaClip 26.183 — Library");
    mod.closeWindow();

    assertEquals(
      counts.constructed,
      1,
      "a second construction opens a SECOND window: that is the blank 'SemaClip dev' " +
        "window reported on both platforms",
    );
    // The title must land on the adopted window, not on a throwaway one.
    assertEquals(counts.titles, ["SemaClip 26.183", "SemaClip 26.183 — Library"]);
    assertEquals(counts.closes, 1);
  });
  await run();
});

Deno.test("the module's own counter agrees, so a regression is visible in the log", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}count`
    );
    mod.adoptWindowLifecycle({ title: "x" });
    mod.setWindowTitle("y");
    mod.closeWindow();
    assertEquals(mod.windowConstructCount(), 1);
    assertEquals(mod.windowConstructCount(), counts.constructed);
  });
  await run();
});

Deno.test("title and close after adoption never construct, even repeatedly", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}repeat`
    );
    mod.adoptWindowLifecycle({});
    for (let i = 0; i < 5; i++) {
      mod.setWindowTitle(`title ${i}`);
      mod.closeWindow();
    }
    assertEquals(counts.constructed, 1, "repeated calls must not multiply windows");
    assertEquals(counts.titles.length, 5);
  });
  await run();
});

Deno.test("adoption is idempotent: calling it twice does not open a window", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}twice`
    );
    mod.adoptWindowLifecycle({ title: "first" });
    mod.adoptWindowLifecycle({ title: "second" });
    assertEquals(counts.constructed, 1, "a second adopt must not open a second window");
  });
  await run();
});

Deno.test("under `deno run` there is no window, so nothing is constructed", async () => {
  const counts = { constructed: 0 };
  const deno = Deno as Record<string, unknown>;
  const realBW = deno.BrowserWindow;
  const realAddr = Deno.env.get("DENO_SERVE_ADDRESS");
  deno.BrowserWindow = function (this: FakeWin) {
    counts.constructed += 1;
  };
  Deno.env.delete("DENO_SERVE_ADDRESS");
  try {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}dev`
    );
    mod.adoptWindowLifecycle({ title: "dev" });
    assertEquals(counts.constructed, 0, "a dev run must not try to open a window");
    assertEquals(mod.setWindowTitle("x"), false);
    assertEquals(mod.closeWindow(), false);
  } finally {
    deno.BrowserWindow = realBW;
    if (realAddr !== undefined) Deno.env.set("DENO_SERVE_ADDRESS", realAddr);
  }
});

/**
 * The owner's requirement is a desktop app with its OWN chrome, and the window had
 * decoration on Windows when it should not. Frameless is now the default, so the
 * assertion that matters is what the WINDOW was created with — not what the caller
 * omitted — plus that the reported state agrees with it (otherwise the UI draws no
 * chrome over an undecorated window).
 */
Deno.test("the window is REQUESTED frameless by default", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}frameless`
    );
    mod.adoptWindowLifecycle({ title: "x" });
    assertEquals(
      counts.opts.frameless,
      true,
      "with no explicit choice the window must be created without OS decoration",
    );
  }, true);
  await run();
});

/**
 * The state must never assert a frame state it has not measured.
 *
 * This is the defect that hid the Windows decoration for three rounds: the module reported
 * `frameless: true, nativeDecorations: false` because it echoed the OPTION it passed, while the
 * real Win32 window carried WS_CAPTION|WS_THICKFRAME|WS_SYSMENU — style 0x14CF0000, the same
 * bits Explorer's window has. The UI trusted it and drew no chrome over a decorated window.
 */
Deno.test("the window state is MEASURED, never inferred from the request", async () => {
  const run = withFakeWindow(async () => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}measured`
    );
    mod.adoptWindowLifecycle({ frameless: true, title: "x" });
    const c = mod.chromeState();
    // There is no Win32 window in this process, so the only honest answer is "not measured".
    // A test host is `deno test`, so `actual` must be null here rather than a fabricated
    // frameless claim: on Windows the real measurement happens against the real window.
    if (Deno.build.os !== "windows") {
      // Not Windows: the frame state cannot be measured from JS, so it must be reported as
      // UNKNOWN rather than as a claim. `frameless` may still be true (the UI must draw chrome
      // to be usable), but `actual.frameless === null` is what records that it is a request.
      assertEquals(
        c.actual?.frameless,
        null,
        "an unmeasurable frame state must be reported as unknown, never asserted",
      );
      assertEquals(c.actual?.source, "runtime", "the size still comes from the runtime");
    }
    // The fields must never contradict each other, whatever the measurement returned.
    assertEquals(c.frameless, !c.nativeDecorations);
  });
  await run();
});

Deno.test("an explicit opt-out restores the OS titlebar, in the window and the state", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}decorated`
    );
    mod.adoptWindowLifecycle({ frameless: false, title: "x" });
    assertEquals(counts.opts.frameless, false, "the escape hatch must reach the window");
    assertEquals(mod.chromeState().frameless, false);
    assertEquals(mod.chromeState().nativeDecorations, true);
  }, true);
  await run();
});

Deno.test("capabilities describe the CHROME, and never outrun the window", async () => {
  const run = withFakeWindow(async () => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}caps`
    );
    module1: {
      mod.adoptWindowLifecycle({ title: "x" });
      const c = mod.chromeState();
      // The invariant the UI depends on: the app provides these buttons EXACTLY WHEN it draws
      // its own chrome. That is what keeps one window from showing two sets of controls — if the
      // bar is drawn, the buttons must be in it (a frameless window with no minimize is
      // unusable); if it is not, the OS titlebar has them.
      //
      // Stated against `c.frameless` rather than `c.actual.frameless` on purpose: the latter is
      // null when the frame state cannot be measured, while `frameless` is the REQUEST the UI
      // renders from. Both must agree with the buttons or the bar is wrong in one of the two
      // directions. The window CLASS still has neither action (re-verified against the installed
      // runtime: the only minimize/maximize strings in it belong to Intl.Locale) — the actions
      // come from user32/GTK, which is why they are reported separately from the class.
      assertEquals(c.canMinimize, c.frameless, "the buttons follow the chrome");
      assertEquals(c.canMaximize, c.frameless, "the buttons follow the chrome");
      // And the two frame fields must never contradict each other.
      assertEquals(c.frameless, !c.nativeDecorations);
    }
  });
  await run();
});

/**
 * An explicit opt-out must reach the window AND the state: that is the escape hatch for a
 * platform where removing the frame misbehaves.
 */
Deno.test("opting out of frameless reports native decorations", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}optout`
    );
    mod.adoptWindowLifecycle({ frameless: false, title: "x" });
    assertEquals(counts.opts.frameless, false);
    const c = mod.chromeState();
    assertEquals(c.frameless, false);
    assertEquals(c.nativeDecorations, true);
    assertEquals(c.canMinimize, false, "the OS buttons are the window's, not the app's");
  }, true);
  await run();
});

/**
 * The size defaults are the app's layout contract, so a regression to the runtime's own default
 * (800x600, measured on the installed build before this change) is a real regression.
 */
Deno.test("the adopted window is asked for the app's default size", async () => {
  const run = withFakeWindow(async (counts) => {
    const mod = await import(
      `@/adapters/outbound/platform/window-lifecycle.ts?t=${Date.now()}size`
    );
    mod.adoptWindowLifecycle({ title: "x" });
    assertEquals(counts.opts.width, 1260, "default width");
    assertEquals(counts.opts.height, 890, "default height");
    assertEquals(mod.MIN_WINDOW_WIDTH, 1040);
    assertEquals(mod.MIN_WINDOW_HEIGHT, 800);
  }, true);
  await run();
});

/**
 * The caption is removed; the RESIZE BORDER is not.
 *
 * `WS_CAPTION` is `WS_BORDER|WS_DLGFRAME`, and clearing it is what removes the title bar.
 * `WS_THICKFRAME` is a separate bit that IS the resize border. The first version cleared both,
 * which removed the caption as intended and silently took edge-resizing with it — the owner's
 * "the edges of the window are not draggable for resizing".
 *
 * The bits are asserted from the module's own constants so the two can never be conflated again
 * without this failing.
 */
Deno.test("the frame removal clears the caption but NOT the resize border", async () => {
  const src = await Deno.readTextFile(
    new URL("../adapters/outbound/platform/win-frame.ts", import.meta.url),
  );
  // The mask applied to the style, as source: it must not include WS_THICKFRAME.
  const maskLine = src.split("\n").find((l) => l.includes("const after = before & ~"));
  assert(maskLine, "the style mask must exist for this to be checkable");
  assert(
    !maskLine!.includes("WS_THICKFRAME"),
    "WS_THICKFRAME is the RESIZE BORDER: clearing it removes edge-resizing (and the snap target)",
  );
  assert(
    maskLine!.includes("WS_CAPTION"),
    "the caption is what must be cleared for the title bar to go",
  );
  // And the capability bits the native actions depend on must survive too.
  for (const bit of ["WS_MINIMIZEBOX", "WS_MAXIMIZEBOX", "WS_SYSMENU"]) {
    assert(
      !maskLine!.includes(bit),
      `${bit} must be KEPT: the OS refuses to iconify/maximize a window whose style forbids it`,
    );
  }
});

/**
 * The drag must not rely on `-webkit-app-region`.
 *
 * That CSS is an Electron extension; this app runs on the `webview` backend and the installed
 * runtime contains no `app-region` handling at all — which is why the chrome could not be dragged.
 * The mechanism is a native move loop on both platforms.
 */
Deno.test("the chrome drag uses a native move loop, never -webkit-app-region", async () => {
  const layout = await Deno.readTextFile(
    new URL("../../frontend/src/routes/+layout.svelte", import.meta.url),
  );
  // Only real USAGE counts: the string legitimately appears in a comment explaining why the CSS
  // is not used, and a substring check would fail on the documentation.
  const usesAppRegion = layout
    .split("\n")
    .some((line) => !line.trim().startsWith("*") && !line.trim().startsWith("//") &&
      line.includes("-webkit-app-region"));
  assert(
    !usesAppRegion,
    "that CSS does nothing on this runtime; the drag must call the platform",
  );
  assert(layout.includes("/api/window/drag"), "the chrome must drive the native move loop");
  assert(layout.includes("/api/window/resize"), "edge handles must drive the native resize loop");
});

/**
 * The Linux path must exist and be reachable, since the chrome is required there too.
 */
Deno.test("Linux gets the same window control surface as Windows", async () => {
  const lifecycle = await Deno.readTextFile(
    new URL("../adapters/outbound/platform/window-lifecycle.ts", import.meta.url),
  );
  for (const fn of ["beginWindowDrag", "beginWindowResize", "minimizeWindow", "toggleMaximizeWindow", "restoreWindow"]) {
    assert(lifecycle.includes(`export function ${fn}`), `${fn} must be exported`);
  }
  assert(
    lifecycle.includes('Deno.build.os === "linux"'),
    "the Linux branch must be wired, not left as Windows-only",
  );
  const gtk = await Deno.readTextFile(
    new URL("../adapters/outbound/platform/gtk-frame.ts", import.meta.url),
  );
  // GTK3, not GTK4: the launcher links libgtk-3 (measured with ldd on laufey_webview), so GTK4
  // would be a second toolkit in one process and could not address this window at all.
  assert(gtk.includes("libgtk-3.so.0"), "must use the GTK3 the launcher already loaded");
  assert(gtk.includes("gtk_window_begin_move_drag"), "the move loop is what makes dragging native");
  assert(gtk.includes("gtk_window_iconify"), "minimize must leave a taskbar entry");
});

/**
 * The drag must carry the press point, and the frame removal must touch ONLY the app window.
 *
 * Both are pinned as pure/source invariants because neither is observable without a real window, and
 * both shipped as defects that were measured in the owner's VM:
 *
 *   1. `SendMessage(WM_NCLBUTTONDOWN, HTCAPTION, 0)` puts the press at the top-left of the DESKTOP, so
 *      Windows decides the click is not on the caption and the move loop never starts — while the app
 *      reported `{"dragging":true}`. The packing is the thing that was wrong, so it is a function.
 *   2. `removeNativeFrame` looped over EVERY top-level window the process owns and returned the LAST
 *      one's style. This process also owns two IME helper windows (`IME`, `MSCTFIME UI`, style
 *      0x8C000000), so the log reported `measured style=0x8C000000` for a window that was actually
 *      0x140F0000 — and it cleared the caption off the OS's input-method windows as well.
 */
Deno.test("the drag packs the press point into lParam, never 0", async () => {
  const src = await Deno.readTextFile(
    new URL("../adapters/outbound/platform/win-frame.ts", import.meta.url),
  );
  assert(
    src.includes("makeLParam"),
    "the lParam must be built from the press point: a zero press point starts no move loop",
  );
  // The message call must use it, not a literal. Comments also mention this message, so the match
  // requires a line that actually CALLS it (an indented statement, not a `*` comment).
  const call = src.split("\n").find((l) =>
    l.includes("SendMessageW(") && l.includes("WM_NCLBUTTONDOWN") && !l.trimStart().startsWith("*")
  );
  assert(call, "the move-loop message must be sent");
  assert(
    !/WM_NCLBUTTONDOWN,\s*BigInt\(HTCAPTION\),\s*0n\)/.test(call!),
    "lParam 0 means (0,0) on the desktop: the press misses the caption and nothing moves",
  );
  assert(call!.includes("lparam"), "the packed press point must be passed through");
});

Deno.test("the frame removal touches ONLY the chosen window, never the whole process", async () => {
  const src = await Deno.readTextFile(
    new URL("../adapters/outbound/platform/win-frame.ts", import.meta.url),
  );
  const body = src.slice(
    src.indexOf("export function removeNativeFrame"),
    src.indexOf("/**\n * Colour the frame DWM draws"),
  );
  assert(
    !body.includes("ownTopLevelWindows()"),
    "iterating every owned window clears the caption off the runtime's IME helpers and reports the " +
      "wrong window's style in the log",
  );
  assert(
    body.includes("findOwnWindow()"),
    "the frame is removed from the window that was chosen as the app window",
  );
});

/**
 * The frame-removal reporting must be MEASURED from the window it acted on.
 *
 * The value is what every later diagnosis is read from, and it was wrong for a whole investigation.
 */
Deno.test("the frame removal reports the measured style of the window it acted on", async () => {
  const src = await Deno.readTextFile(
    new URL("../adapters/outbound/platform/win-frame.ts", import.meta.url),
  );
  const body = src.slice(
    src.indexOf("export function removeNativeFrame"),
    src.indexOf("/**\n * Colour the frame DWM draws"),
  );
  assert(
    body.includes("GetWindowLongW(h, GWL_STYLE)") && body.includes("const confirmed"),
    "the returned style must be read BACK from the window, not derived from the mask",
  );
  assert(
    body.includes("(confirmed & WS_CAPTION) !== WS_CAPTION"),
    "frameless is reported from the measured bits",
  );
});
