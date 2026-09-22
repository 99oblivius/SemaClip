/**
 * The seeder must fill in what is MISSING and touch nothing else.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * The gate was `existingPresets.length === 0`. That was correct while nothing else wrote preset
 * rows: a fresh database arrived empty and received the whole shipped set. The migration chain then
 * began inserting `preset-landscape-169` (0.7.0 adds it, because an EXISTING user needs it too), so
 * at boot the table was never empty — the gate was skipped every time, and a FIRST-RUN user received
 * exactly ONE preset.
 *
 * Measured on a real first boot BEFORE the fix: `count: 1`, Landscape only. AFTER: `count: 3`, with
 * the log reading `Seeded 2 default export preset(s): preset-tiktok-916, preset-shorts-916-vp9`.
 *
 * Both directions matter. A regression to "always save the defaults" would bring back the older bug
 * the gate was added for: the shipped rows overwriting a preset the user had edited, silently, on
 * every restart.
 *
 * These call the REAL `missingShippedPresets` and read the REAL shipped list out of the container
 * source, so neither the rule nor the list can drift from what boots.
 */
import { assertEquals, assert } from "@std/assert";
import { missingShippedPresets } from "../domain/export-profile.ts";
import type { ExportPreset } from "shared/types";

/** A preset as the seeder writes it; only `id` matters to the rule under test. */
const p = (id: string): ExportPreset =>
  ({ id, name: id, profile: {}, createdAt: "2026-01-01T00:00:00Z", origin: "seeded" }) as unknown as ExportPreset;

const DEFAULTS: ExportPreset[] = [
  p("preset-landscape-169"),
  p("preset-tiktok-916"),
  p("preset-shorts-916-vp9"),
];

Deno.test("a database holding ONLY the chain's preset still receives the rest", () => {
  // The exact broken state: 0.7.0's migration inserted Landscape, so the table is non-empty and the
  // old `length === 0` gate then seeded NOTHING — leaving a first-run user with one preset.
  const missing = missingShippedPresets(DEFAULTS, [{ id: "preset-landscape-169" }]);
  assertEquals(missing.map((m) => m.id), ["preset-tiktok-916", "preset-shorts-916-vp9"]);
});

Deno.test("an EMPTY database receives ALL of them", () => {
  assertEquals(missingShippedPresets(DEFAULTS, []).map((m) => m.id), DEFAULTS.map((m) => m.id));
});

Deno.test("a fully seeded database receives NOTHING — the user's rows are left alone", () => {
  // The property the original gate protected: saving a row the user edited reverts their change on
  // the next restart. Nothing may be returned here even though the ids all match.
  const stored = DEFAULTS.map((d) => ({ id: d.id }));
  assertEquals(missingShippedPresets(DEFAULTS, stored), []);
});

Deno.test("an EDITED shipped preset is not re-written", () => {
  // The row exists (so it is not missing) even though its config differs from the shipped one — the
  // rule keys on IDENTITY, never on content. A content comparison would clobber the edit.
  const edited = [{ id: "preset-landscape-169" }, { id: "preset-tiktok-916" }, { id: "preset-shorts-916-vp9" }];
  assertEquals(missingShippedPresets(DEFAULTS, edited), []);
});

Deno.test("a USER preset is never touched", () => {
  // A preset id the shipped set does not own is invisible to this rule in both directions.
  const withUser = [...DEFAULTS.map((d) => ({ id: d.id })), { id: "user-abc123" }];
  assertEquals(missingShippedPresets(DEFAULTS, withUser).map((m) => m.id), []);
  // AND the presence of a user preset does not suppress the shipped ones.
  assertEquals(missingShippedPresets(DEFAULTS, [{ id: "user-abc123" }]).length, 3);
});

Deno.test("the rule keys on IDs, and does not depend on the stored order", () => {
  const shuffled = [{ id: "preset-shorts-916-vp9" }, { id: "preset-landscape-169" }];
  assertEquals(missingShippedPresets(DEFAULTS, shuffled).map((m) => m.id), ["preset-tiktok-916"]);
});

Deno.test("the container SHIPS three presets and no archive", async () => {
  // Read out of the real source file: `DEFAULT_PRESETS` lives in a module with heavy side effects, so
  // it cannot be imported here. Parsing the ids keeps this honest about the shipped SET, which is
  // what the owner's archive removal changed. (The migration chain's own inserts are covered by
  // `migrations.test.ts`.)
  const src = await Deno.readTextFile(
    new URL("../composition/container.ts", import.meta.url),
  );
  const block = src.slice(src.indexOf("const DEFAULT_PRESETS"), src.indexOf("const existingPresets"));
  const ids = [...block.matchAll(/id: "(preset-[a-z0-9-]+)"/g)].flatMap((m) => (m[1] ? [m[1]] : []));
  assertEquals(ids.length, 3, `the shipped set is three presets (got ${ids.join(", ")})`);
  assert(!ids.some((id) => id.includes("archive")), "no archive preset may ship");
  assert(ids.includes("preset-landscape-169"), "Landscape is the default and must ship");
  assert(ids.includes("preset-tiktok-916"), "Portrait must ship");
  assert(ids.includes("preset-shorts-916-vp9"), "Shorts must ship");
});
