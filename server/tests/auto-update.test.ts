/**
 * The updater must not disable itself when the build carries a baseUrl.
 *
 * The measured bug: `startAutoUpdate` required an explicit url (arg or
 * SEMACLIP_UPDATE_URL) and returned early otherwise, logging
 *   Updates: disabled (no release baseUrl configured)
 * in EVERY packaged build — while server/deno.json set desktop.release.baseUrl and
 * that manifest answered HTTP 200. Deno's docs: "Deno.autoUpdate() defaults to this
 * URL, but can override it per call", and the option table marks `url` as required
 * only "if no desktop.release.baseUrl is set in deno.json". So a build that HAS one
 * must reach the call with no url at all.
 *
 * These tests drive the real module through a fake Deno.autoUpdate, so they assert
 * the decision the app actually makes rather than a copy of it.
 */
import { assert, assertEquals } from "@std/assert";

type Captured = { url?: string; interval?: number; publicKey?: string };

/** Install a fake Deno.autoUpdate and capture what the module decides to pass. */
function withFakeAutoUpdate(
  desktopVersion: string | null,
  fn: (captured: Captured[]) => Promise<void>,
): () => Promise<void> {
  const captured: Captured[] = [];
  const real = (Deno as Record<string, unknown>).autoUpdate;
  const realVersion = (Deno as Record<string, unknown>).desktopVersion;
  (Deno as Record<string, unknown>).desktopVersion = desktopVersion;
  // The REAL call returns undefined, not a Promise — that is exactly what made
  // `autoUpdate({...}).catch(...)` throw on every launch. The fake must match, or it
  // would hide the bug it exists to prevent.
  (Deno as Record<string, unknown>).autoUpdate = (opts: Captured) => {
    captured.push(opts);
    return undefined;
  };
  return async () => {
    try {
      await fn(captured);
    } finally {
      // Restore, so a later test in the same process is unaffected.
      (Deno as Record<string, unknown>).autoUpdate = real;
      (Deno as Record<string, unknown>).desktopVersion = realVersion;
    }
  };
}

Deno.test("a packaged build with NO explicit url still starts the updater", async () => {
  const run = withFakeAutoUpdate("26.178-nightly.18", async (captured) => {
    // Fresh import so the module re-reads Deno.desktopVersion at load.
    const mod = await import(
      `@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}`
    );
    const prev = Deno.env.get("SEMACLIP_UPDATE_URL");
    Deno.env.delete("SEMACLIP_UPDATE_URL");
    try {
      mod.startAutoUpdate();
      await new Promise((r) => setTimeout(r, 10));
      assertEquals(
        captured.length,
        1,
        "autoUpdate must be called — a baked baseUrl is enough; requiring an " +
          "explicit url made the feature dead in every packaged build",
      );
      // No override means no url key, so the runtime uses the baked baseUrl.
      const first = captured[0];
      assert(first, "expected one captured call");
      assertEquals(
        "url" in first,
        false,
        "no url should be passed when the build already carries one",
      );
      assertEquals(first.interval, 6 * 60 * 60 * 1000);
    } finally {
      if (prev !== undefined) Deno.env.set("SEMACLIP_UPDATE_URL", prev);
    }
  });
  await run();
});

Deno.test("an explicit url OVERRIDES the baked one", async () => {
  const run = withFakeAutoUpdate("26.178-nightly.18", async (captured) => {
    const mod = await import(
      `@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}b`
    );
    mod.startAutoUpdate("https://example.test/staging");
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(captured.length, 1);
    const first = captured[0];
    assert(first, "expected one captured call");
    assertEquals(first.url, "https://example.test/staging");
  });
  await run();
});

Deno.test("a dev run (no baked version) stays inert", async () => {
  const run = withFakeAutoUpdate(null, async (captured) => {
    const mod = await import(
      `@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}c`
    );
    mod.startAutoUpdate("https://example.test/staging");
    await new Promise((r) => setTimeout(r, 10));
    assertEquals(
      captured.length,
      0,
      "deno run has no version, so the check must not fire",
    );
  });
  await run();
});

Deno.test("startAutoUpdate must not THROW when the runtime returns undefined", async () => {
  // The regression: `autoUpdate({...}).catch(...)` on a call that returns undefined
  // threw "TypeError: Cannot read properties of undefined (reading 'catch')" as an
  // UNCAUGHT desktop error on every launch — the app still served, so nothing in CI
  // noticed. The fake above returns undefined precisely so this test is meaningful.
  const run = withFakeAutoUpdate("26.180-nightly.20", async () => {
    const mod = await import(
      `@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}throw`
    );
    const prev = Deno.env.get("SEMACLIP_UPDATE_URL");
    Deno.env.delete("SEMACLIP_UPDATE_URL");
    try {
      mod.startAutoUpdate(); // throws => this test fails
    } finally {
      if (prev !== undefined) Deno.env.set("SEMACLIP_UPDATE_URL", prev);
    }
  });
  await run();
});
