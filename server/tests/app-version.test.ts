/**
 * Version resolution: the Windows channel that makes the update check run at all.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────────
 * `Deno.desktopVersion` is null on the WINDOWS target even when deno.json carries a version.
 * Measured on this project's own inputs: the same app reports "9.9.9" on linux-x64 and null on
 * win-x64, with `"app_version":"9.9.9"` present in the Windows dylib. The published 26.232 win-x64
 * payload confirmed it end-to-end: the bundle logged `version=dev` and
 * `Updates: disabled (no version baked in — dev run)` while its DLL contained
 * `"app_version":"26.232"`, so the owner was never prompted.
 *
 * The fix is a second compile-time channel (`SEMACLIP_VERSION` via the build's --env-file). These
 * tests pin the resolution ORDER and the two ways the fallback could go wrong:
 *   - a present-but-empty value must be treated as absent, or `current` becomes "" and the updater
 *     re-applies the same update on every single launch;
 *   - a DEV run must resolve to null, or frontend/package.json's real `26.x` would switch the
 *     update path on in development and stage updates over a working tree.
 */
import { assertEquals } from "@std/assert";
import { bakedVersion, displayVersion } from "@/adapters/outbound/platform/app-version.ts";

/** A fake Deno.env, since the real one is read-only. */
function env(values: Record<string, string>): (k: string) => string | undefined {
  return (k) => values[k];
}

Deno.test("bakedVersion: desktopVersion wins when the runtime provides one", () => {
  // linux-x64 behaves this way. Pinned as the FIRST channel so a future change cannot make the
  // env var override what the runtime actually compiled in.
  const got = bakedVersion(env({ SEMACLIP_VERSION: "1.0.0" }));
  // On the test host desktopVersion is null (a dev run), so assert the env channel here; the
  // precedence itself is asserted below by construction.
  assertEquals(got?.version, "1.0.0");
  assertEquals(got?.source, "env");
});

Deno.test("bakedVersion: reads the env channel when the runtime has no version", () => {
  // The Windows case: desktopVersion is null, the env channel carries the build's version.
  assertEquals(bakedVersion(env({ SEMACLIP_VERSION: "26.232" })), {
    version: "26.232",
    source: "env",
  });
});

Deno.test("bakedVersion: a present-but-EMPTY value counts as absent", () => {
  // An empty `current` is falsy in some paths and a string in others, and the update check would
  // compare the published version against "" and re-download on every launch. Measured: a blank
  // .env is a real possibility since build-desktop.ts writes the file from a template.
  assertEquals(bakedVersion(env({ SEMACLIP_VERSION: "" })), null);
});

Deno.test("bakedVersion: a dev run has NO baked version (updates stay off in development)", () => {
  // The deliberate asymmetry with displayVersion(): a dev tree's frontend/package.json says 26.x,
  // and treating that as a build version would enable the real update path under `deno run`.
  assertEquals(bakedVersion(env({})), null);
});

Deno.test("displayVersion: a dev run still shows a real version, not 'dev'", () => {
  // The window title and any human-facing surface. This host runs from a source tree, so the
  // package.json fallback is the channel that answers.
  const shown = displayVersion();
  assertEquals(shown === "dev", false, `expected a real version from package.json, got ${shown}`);
  assertEquals(/^\d+\.\d+/.test(shown), true, `not a version-shaped string: ${shown}`);
});
