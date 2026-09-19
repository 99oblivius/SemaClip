/**
 * The Windows sidecar must reach a REAL file, or updates can never be applied.
 *
 * `deno desktop --include` embeds files into the compiled executable's virtual filesystem. The MSI's
 * cabinet holds only the payload and two marker files (verified against the published v26.186
 * installer), so the bundled `SemaClipUpdater.exe` never existed as a file on an installed machine —
 * and Windows is the one platform that cannot apply an update without it.
 *
 * These tests cover the decision logic and the per-user path resolution, which is where the bugs
 * would be; the extraction itself is Windows-only and exercised by the build and the VM.
 *
 * ── THE LAUNCHER IS GONE, AND WHY ───────────────────────────────────────────────────────────────
 * A `.cmd` used to be written beside the updater so a user could apply an update BY HAND, because the
 * app could not start the sidecar itself. It can now: the app spawns the updater detached with its own
 * pid and quits, and the updater swaps the payload and relaunches. The launcher was unreachable from
 * the app (nothing pointed at it any more), so keeping it would mean shipping a second, unexercised
 * way to do the same thing — and a manual step the app no longer requires.
 */
import { assert, assertEquals } from "@std/assert";
import {
  ensureSidecar,
  needsExtraction,
  SIDECAR_NAME,
  sidecarDir,
  sidecarPath,
} from "@/adapters/outbound/platform/sidecar.ts";

/** Read the sidecar module as source, for the "does not exist any more" assertions. */
const SRC = await Deno.readTextFile(
  new URL("../../server/adapters/outbound/platform/sidecar.ts", import.meta.url),
);

Deno.test("sidecarDir prefers LOCALAPPDATA and falls back to USERPROFILE", () => {
  assertEquals(
    sidecarDir((k) => (k === "LOCALAPPDATA" ? "C:\\Users\\livia\\AppData\\Local" : undefined)),
    "C:\\Users\\livia\\AppData\\Local\\SemaClip",
  );
  assertEquals(
    sidecarDir((k) => (k === "USERPROFILE" ? "C:\\Users\\livia" : undefined)),
    "C:\\Users\\livia\\AppData\\Local\\SemaClip",
    "no LOCALAPPDATA must still produce the same directory, not a relative one",
  );
});

Deno.test("the sidecar sits beside the Go updater's staging area", () => {
  const env = (k: string) => (k === "LOCALAPPDATA" ? "C:\\L" : undefined);
  assertEquals(sidecarPath(env), `C:\\L\\SemaClip\\${SIDECAR_NAME}`);
  // The Go updater resolves its own paths to <base>/SemaClip, where the app also stages the
  // downloaded payload. Two owners of this path is the bug class this whole file exists to avoid.
  assert(sidecarPath(env).startsWith(`${sidecarDir(env)}\\`));
});

Deno.test("the .cmd launcher is not written, and a stale one is removed", () => {
  // The app starts the updater itself, so a hand-run launcher has no caller. Two things are
  // asserted: the writing code is gone, AND an install that already has the file loses it. Only
  // asserting the absence would leave every existing install with a stale .cmd forever.
  assertEquals(SRC.includes("launcherBody"), false, "the launcher body must be gone");
  assertEquals(
    SRC.includes("launcherContent"),
    false,
    "a stale writer would keep producing the file",
  );
  assert(
    SRC.includes("RETIRED_LAUNCHER_NAME"),
    "the old filename must still be named, so it can be deleted",
  );
  assert(
    /await Deno\.remove\(`\$\{sidecarDir\(\)\}\\\\\$\{RETIRED_LAUNCHER_NAME\}`\)/.test(SRC),
    "ensureSidecar must delete a launcher left by an older build",
  );
  // It must run on EVERY launch, not only when the updater is rewritten: an install whose updater
  // is already current would otherwise keep the file forever.
  const removeAt = SRC.indexOf("RETIRED_LAUNCHER_NAME}`)");
  const earlyReturn = SRC.indexOf("if (!opts.force && !needsExtraction(");
  assert(
    removeAt > 0 && earlyReturn > removeAt,
    "the removal must happen BEFORE the already-current early return",
  );
});

Deno.test("extraction is needed when missing or when a DIFFERENT installer placed it", () => {
  assertEquals(needsExtraction(null, 7_200_000), true, "nothing there: write it");
  assertEquals(needsExtraction(7_200_000, 7_200_000), false, "same size: leave it alone");
  assertEquals(needsExtraction(6_900_000, 7_200_000), true, "a different build: replace it");
});

Deno.test("ensureSidecar is a no-op off Windows, and says so by reporting nothing", async () => {
  // This suite runs on Linux, where there is no sidecar to place. The point is that it must not write
  // anything or throw rather than that it does work here.
  if (Deno.build.os !== "windows") {
    const st = await ensureSidecar();
    assertEquals(st.path, null);
    assertEquals(st.extracted, false);
    assertEquals(st.error, null);
  }
});

Deno.test("a NULL path on Windows carries a REASON; off Windows it is simply not applicable", async () => {
  // The distinction the UI renders: on Windows, `path: null` means the install cannot apply updates
  // and `error` explains why, so Settings warns. On any other platform this module is not applicable
  // at all and there is nothing to report — reporting an "error" there would warn every Linux user
  // about a Windows-only mechanism.
  const st = await ensureSidecar({ force: true });
  if (Deno.build.os === "windows") {
    assert(st.path !== null || st.error !== null, "a Windows null path must explain itself");
    if (st.path !== null) assertEquals(st.error, null, "a placed sidecar carries no error");
  } else {
    assertEquals(st.path, null);
    assertEquals(st.error, null, "not applicable is not a failure");
  }
});
