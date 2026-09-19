/**
 * Diagnostics must report the version the app ACTUALLY has.
 *
 * ── THE BUG ─────────────────────────────────────────────────────────────────────────────────────
 * `/api/diagnostics` read `Deno.desktopVersion` directly. That field is NULL on the Windows target
 * even when the version is baked into the binary — the measurement `app-version.ts` exists to
 * document and work around — so every packaged Windows build answered `version: "dev"` to the one
 * endpoint whose purpose is to report the build. Verified on a real run: with
 * `SEMACLIP_VERSION=26.999`, diagnostics said "dev" while the app's actual version was 26.999.
 *
 * `displayVersion()` is the function that knows about both channels. Anywhere reporting a version
 * must go through it, and this pins that.
 */
import { assert, assertEquals } from "@std/assert";
import { displayVersion } from "@/adapters/outbound/platform/app-version.ts";

const ROUTES = await Deno.readTextFile(
  new URL("../../server/adapters/inbound/http/routes.ts", import.meta.url),
);

Deno.test("diagnostics reports displayVersion, not the raw desktopVersion field", () => {
  const i = ROUTES.indexOf('app.get("/api/diagnostics"');
  assert(i > 0, "the diagnostics route must exist");
  const route = ROUTES.slice(i, ROUTES.indexOf("}));", i));

  assert(
    /version:\s*displayVersion\(\)/.test(route),
    "diagnostics must use displayVersion(), which knows about the env channel",
  );
  assertEquals(
    /version:\s*\(Deno as \{[^}]*\}\)\.desktopVersion/.test(route),
    false,
    "reading the raw field reports 'dev' on every packaged Windows build",
  );
});

Deno.test("displayVersion reports the env channel when one is set", () => {
  // The property the route depends on. A packaged Windows build carries SEMACLIP_VERSION because
  // Deno.desktopVersion is null there.
  const prev = Deno.env.get("SEMACLIP_VERSION");
  try {
    Deno.env.set("SEMACLIP_VERSION", "26.999");
    assertEquals(displayVersion(), "26.999");
  } finally {
    if (prev === undefined) Deno.env.delete("SEMACLIP_VERSION");
    else Deno.env.set("SEMACLIP_VERSION", prev);
  }
});

Deno.test("no route reports a version by reading the runtime field", () => {
  // A sweep rather than one assertion: the same mistake is easy to make again in a new route, and it
  // is invisible in a dev run (where "dev" is the correct answer anyway).
  const offenders = ROUTES
    .split("\n")
    .filter((l) => /desktopVersion/.test(l) && !/^\s*(\/\/|\*)/.test(l));
  assertEquals(
    offenders.length,
    0,
    `no route may read desktopVersion directly:\n${offenders.join("\n")}`,
  );
});
