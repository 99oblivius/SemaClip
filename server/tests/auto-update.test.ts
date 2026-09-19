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

Deno.test("a packaged build with NO explicit url still starts the runtime updater (non-Linux)", async () => {
  // LINUX IS EXCLUDED ON PURPOSE, not for convenience. On Linux `startAutoUpdate` never calls the
  // runtime's `autoUpdate`: its staging path is `<dylib>.update` beside the dylib, which inside an
  // AppImage is a read-only squashfs mount, so it fails on every launch and changes nothing
  // (measured: "Read-only file system (os error 30)"). Linux does its own check and download
  // instead — see the Linux tests below. The runtime call this test pins is still the WINDOWS path.
  if (Deno.build.os === "linux") return;
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
      // NO interval. `interval` is what makes the runtime keep polling; leaving it out is what
      // limits updates to the single startup check the owner asked for. Pinned here because adding
      // it back looks harmless and would silently reintroduce background polling.
      assertEquals(
        "interval" in first,
        false,
        "passing an interval starts polling; updates must be checked only when the app opens",
      );
    } finally {
      if (prev !== undefined) Deno.env.set("SEMACLIP_UPDATE_URL", prev);
    }
  });
  await run();
});

Deno.test("an explicit url OVERRIDES the baked one (non-Linux)", async () => {
  // See the note above: Linux does not go through the runtime updater.
  if (Deno.build.os === "linux") return;
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

/**
 * LINUX: the AppImage update path.
 *
 * These pin the decisions that make Linux work at all, because the runtime's own updater cannot
 * (its staging path is inside the read-only mount). The values here are what the swap depends on:
 * the location to replace comes from the runtime's `APPIMAGE` variable, and the helper must wait for
 * this process to exit before moving the file.
 */
Deno.test("the AppImage path comes from APPIMAGE, and is null elsewhere", async () => {
  const mod = await import(`@/adapters/outbound/platform/appimage-update.ts?t=${Date.now()}a`);
  const env = (k: string) => (k === "APPIMAGE" ? "/home/user/SemaClip.AppImage" : undefined);

  if (Deno.build.os === "linux") {
    assertEquals(
      mod.appImagePath(env),
      "/home/user/SemaClip.AppImage",
      "the runtime exports APPIMAGE as the file to replace",
    );
    // An empty value must not be treated as a path.
    assertEquals(mod.appImagePath(() => ""), null);
    assertEquals(mod.appImagePath(() => undefined), null);
  } else {
    assertEquals(
      mod.appImagePath(env),
      null,
      "only Linux replaces an AppImage; Windows updates through the sidecar",
    );
  }
});

Deno.test("the swap script waits for THIS pid, renames atomically, and relaunches", async () => {
  const mod = await import(`@/adapters/outbound/platform/appimage-update.ts?t=${Date.now()}b`);
  const plan = mod.swapPlan("/home/user/Applications/SemaClip.AppImage", () => "/home/user/.local/share");
  const body = mod.swapScriptBody(plan, 4242);

  // The pid is what prevents racing the running process: the file cannot be replaced while the
  // AppImage is still mounted, and the mount is released only when the process exits.
  assert(body.includes("PID=4242"), "the helper must wait for the app's own pid");
  assert(body.includes("kill -0 \"$PID\""), "it must poll for that process to disappear");
  // Same-directory rename: atomic, and no window where the target file is missing.
  assert(body.includes('mv -f "$STAGED" "$TARGET"'), "the swap must be a rename onto the target");
  assert(body.includes("chmod +x"), "a swapped file must stay executable");
  assert(body.includes('nohup "$TARGET"'), "the app must be relaunched after the swap");
  // Both paths must be the same directory for the rename to be atomic.
  assertEquals(
    plan.staged.replace(/\/[^/]*$/, ""),
    plan.target.replace(/\/[^/]*$/, ""),
    "the staged file must live beside the target so `mv` is a rename, not a copy",
  );
});

Deno.test("a checksum mismatch is refused rather than installed", async () => {
  // The manifest's sha256 is the only thing between a user and a corrupted 108MB binary replacing a
  // working one, so a mismatch must abort and leave the installed file alone.
  const mod = await import(`@/adapters/outbound/platform/appimage-update.ts?t=${Date.now()}c`);
  const bytes = new TextEncoder().encode("not a real appimage");
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, () =>
    new Response(bytes, { status: 200 }));
  const port = (server.addr as Deno.NetAddr).port;

  const prev = Deno.env.get("APPIMAGE");
  Deno.env.set("APPIMAGE", "/tmp/SemaClip-test.AppImage");
  try {
    const res = await mod.downloadAndStageAppImage(
      "http://127.0.0.1/x/latest.json",
      "26.999",
      { name: "x.AppImage", sha256: "0".repeat(64), url: `http://127.0.0.1:${port}/x.AppImage` },
      () => {},
    );
    assertEquals(res.staged, false, "a bad hash must not stage anything");
    assert(res.error?.includes("sha256 mismatch"), `expected a mismatch error, got ${res.error}`);
  } finally {
    if (prev !== undefined) Deno.env.set("APPIMAGE", prev);
    else Deno.env.delete("APPIMAGE");
    await server.shutdown();
  }
});
