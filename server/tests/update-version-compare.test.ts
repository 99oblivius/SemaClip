/**
 * The Windows update decision, and the version comparison it rests on.
 *
 * ── THE BUG THIS PINS ────────────────────────────────────────────────────────────────────────
 * Windows NEVER showed the update banner, on any version. Two causes stacked:
 *
 *   1. the version was unresolvable, so the whole updater early-returned
 *      ("Updates: disabled (no version baked in — dev run)"); and
 *   2. once that was fixed, the runtime's own `Deno.autoUpdate()` STILL staged nothing, because it
 *      compares the manifest against `Deno.desktopVersion`, which is null on the Windows target.
 *
 * (2) was measured on a 26.232 win-x64 build with a working version channel, against a published
 * 26.233 whose patch downloaded fine (HTTP 200): the app logged
 * `Updates: current 26.232, polling the baseUrl baked into this build` and staged no patch.
 *
 * The fix is to do the reconciliation ourselves — the same shape as the Linux path — and to let the
 * sidecar apply it, since the sidecar verifiably works:
 *
 *     SemaClipUpdater.exe -check -app C:\wintest232
 *     no version recorded here; installing the published 26.233
 *     installed= latest=26.233 update=true
 *
 * `compareVersions` is load-bearing and is tested hardest: the scheme advances by commit count, so
 * a string comparison would rank "26.9" ABOVE "26.10" and the update would stop being offered as
 * the patch number reaches double digits.
 */
import { assertEquals } from "@std/assert";
import { compareVersions } from "@/adapters/outbound/platform/auto-update.ts";

Deno.test("compareVersions: ordering within the same year", () => {
  assertEquals(compareVersions("26.233", "26.232"), 1);
  assertEquals(compareVersions("26.232", "26.233"), -1);
  assertEquals(compareVersions("26.232", "26.232"), 0);
});

Deno.test("compareVersions: numeric, NOT lexical — the case a string compare gets wrong", () => {
  // "26.9" > "26.10" lexically, but the patch count makes 26.10 the LATER release. Getting this
  // backwards silently stops offering updates once the count reaches double digits.
  assertEquals(compareVersions("26.10", "26.9"), 1);
  assertEquals(compareVersions("26.9", "26.10"), -1);
  assertEquals("26.9" > "26.10", true, "documents that a plain string compare would be wrong");
});

Deno.test("compareVersions: across the year boundary", () => {
  // The patch count resets each year, so a new year's low patch number IS newer.
  assertEquals(compareVersions("27.1", "26.400"), 1);
  assertEquals(compareVersions("26.400", "27.1"), -1);
});

Deno.test("compareVersions: a longer version is not automatically newer", () => {
  assertEquals(compareVersions("26.232.0", "26.232"), 0);
  assertEquals(compareVersions("26.232.1", "26.232"), 1);
});

Deno.test("compareVersions: never ranks a release as newer than itself, so no update loop", () => {
  // The updater must not offer an update when the published version equals the running one — that
  // would re-download forever. Equal must be exactly 0, and the caller treats <= 0 as "no update".
  for (const v of ["26.1", "26.232", "26.999", "27.1"]) {
    assertEquals(compareVersions(v, v), 0, `${v} vs itself`);
  }
});
