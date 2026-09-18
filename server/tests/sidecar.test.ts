/**
 * The Windows sidecar must reach a REAL file, or staged updates can never be applied.
 *
 * `deno desktop --include` embeds files into the compiled executable's virtual
 * filesystem. The MSI's cabinet holds only the payload, the launcher and two marker
 * files (verified against the published v26.186 installer), so the bundled
 * `SemaClipUpdater.exe` never existed as a file on an installed machine — and Windows
 * is the one platform that cannot apply an update without it.
 *
 * These tests cover the decision logic and the per-user path resolution, which is where
 * the bugs would be; the extraction itself is Windows-only and exercised by the build.
 */
import { assert, assertEquals } from "@std/assert";
import {
  bundleLauncherContent,
  ensureSidecar,
  LAUNCHER_NAME,
  launcherContent,
  launcherPath,
  needsExtraction,
  SIDECAR_NAME,
  sidecarDir,
  sidecarPath,
} from "@/adapters/outbound/platform/sidecar.ts";

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

Deno.test("the sidecar and launcher sit together, beside the Go updater's state file", () => {
  const env = (k: string) => (k === "LOCALAPPDATA" ? "C:\\L" : undefined);
  assertEquals(sidecarPath(env), `C:\\L\\SemaClip\\${SIDECAR_NAME}`);
  assertEquals(launcherPath(env), `C:\\L\\SemaClip\\${LAUNCHER_NAME}`);
  // The Go updater resolves its state file to <base>/SemaClip/state.txt, so one
  // directory holds the updater, its launcher and its state. Two owners of this path
  // is the bug class this whole file exists to avoid.
  assert(sidecarPath(env).startsWith(`${sidecarDir(env)}\\`));
  assert(launcherPath(env).startsWith(`${sidecarDir(env)}\\`));
});

Deno.test("extraction is needed when missing or when a DIFFERENT installer placed it", () => {
  assertEquals(needsExtraction(null, 7_200_000), true, "nothing there: write it");
  assertEquals(needsExtraction(7_200_000, 7_200_000), false, "same size: leave it alone");
  assertEquals(needsExtraction(6_900_000, 7_200_000), true, "a different build: replace it");
});

Deno.test("ensureSidecar is a no-op off Windows, and says so by reporting nothing", async () => {
  // This suite runs on Linux, where there is no sidecar to place. The point is that it
  // must not write anything or throw rather than that it does work here.
  if (Deno.build.os !== "windows") {
    const st = await ensureSidecar();
    assertEquals(st.path, null);
    assertEquals(st.extracted, false);
    assertEquals(st.error, null);
  }
});

Deno.test("a NULL path on Windows carries a REASON; off Windows it is simply not applicable", async () => {
  // The distinction the UI renders: on Windows, `path: null` means the install cannot
  // apply updates and `error` explains why, so Settings warns. On any other platform
  // this module is not applicable at all and there is nothing to report — reporting an
  // "error" there would warn every Linux user about a Windows-only mechanism.
  const st = await ensureSidecar({ force: true });
  if (Deno.build.os === "windows") {
    assert(st.path !== null || st.error !== null, "a Windows null path must explain itself");
    if (st.path !== null) assertEquals(st.error, null, "a placed sidecar carries no error");
  } else {
    assertEquals(st.path, null);
    assertEquals(st.error, null, "not applicable is not a failure");
  }
});

Deno.test("BOTH launchers pass -app, because the updater defaults to its OWN directory", () => {
  // THE BUG THIS PINS: the updater targets its own directory when not told otherwise, so
  // a launcher that omits -app makes it look for version.txt beside the UPDATER — which
  // for an MSI install is a per-user directory holding no bundle, so it refuses to run
  // with "is this a SemaClip bundle?". The first launcher written here omitted it.
  for (const [name, body] of [
    ["bundle", bundleLauncherContent()],
    ["runtime", launcherContent("C:\\Program Files\\SemaClip")],
  ] as const) {
    assert(body.includes("-app"), `${name} launcher must pass -app`);
    assert(body.includes(SIDECAR_NAME), `${name} launcher must run the updater`);
    assert(body.includes("%*"), `${name} launcher must forward arguments`);
  }
});

Deno.test("the portable launcher aims at its own directory; the install launcher names the app dir", () => {
  const bundle = bundleLauncherContent();
  assert(
    bundle.includes('set "APPDIR=%~dp0"'),
    "a portable bundle unpacks the updater beside the app, so %~dp0 is the app dir",
  );
  const installed = launcherContent("C:\\Program Files\\SemaClip");
  assert(
    installed.includes("C:\\Program Files\\SemaClip"),
    "an MSI install extracted the updater elsewhere, so the app dir must be named",
  );
  // And the install launcher must NOT use %~dp0 for the app dir: that is where the
  // UPDATER was extracted, not where the app lives.
  assert(
    !installed.includes('set "APPDIR=%~dp0"'),
    "an install must name the app directory, not the updater's own",
  );
});
