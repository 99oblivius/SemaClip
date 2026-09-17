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
};

/** Install a counting fake and a desktop-runtime marker; returns a restore function. */
function withFakeWindow(
  fn: (counts: { constructed: number; titles: string[]; closes: number }) => Promise<void>,
): () => Promise<void> {
  const counts = { constructed: 0, titles: [] as string[], closes: 0 };
  const deno = Deno as Record<string, unknown>;
  const realBW = deno.BrowserWindow;
  const realAddr = Deno.env.get("DENO_SERVE_ADDRESS");
  const realExit = Deno.exit;

  deno.BrowserWindow = function (this: FakeWin) {
    counts.constructed += 1;
    this.addEventListener = () => {};
    this.setTitle = (t: string) => counts.titles.push(t);
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
  const counts = { constructed: 0, titles: [] as string[], closes: 0 };
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
