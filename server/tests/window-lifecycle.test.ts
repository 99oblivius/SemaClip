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
      // The window CLASS still has neither (re-verified against the installed runtime: the only
      // minimize/maximize strings in it belong to Intl.Locale). With the native frame present
      // the OS draws those buttons, so the app must not claim to provide them.
      // Minimize/maximize are only OURS when the frame is gone AND that is known. On a platform
      // where the frame state is unmeasurable, claiming to provide the buttons would risk a
      // window with both the OS buttons and ours.
      const ours = c.actual?.frameless === true;
      assertEquals(c.canMinimize, ours);
      assertEquals(c.canMaximize, ours);
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
