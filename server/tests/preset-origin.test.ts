/**
 * Preset origin policy: what may be deleted, and what a missing preset looks like.
 *
 * Two failures are being held shut here.
 *
 * 1. The POLICY. The UI hides the delete button for seeded presets, but a hidden button is not a
 *    policy — any client can call the endpoint. The server refuses by name, and this asserts the
 *    refusal text rather than merely a non-200: a test that only checks "it failed" would pass if the
 *    request died for an unrelated reason (a wrong-reason pass is a false green).
 *
 * 2. The EXISTENCE CHECK. Drizzle's `.get()` returns an EMPTY OBJECT, not undefined, when nothing
 *    matches. The first version of `originOf` tested `if (!row) return null`, so a nonexistent id fell
 *    through to the `seeded` fallback — every unknown preset reported as undeletable and the 404
 *    branch was unreachable. That is asserted directly below, because the route's 409/404 split is
 *    only correct if this returns null for an absent row.
 */
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/adapters/outbound/persistence/db.ts";
import { SqliteExportPresetRepository } from "@/adapters/outbound/persistence/repositories.ts";

/**
 * A repository over a REAL file, plus a raw handle on the same file for assertions that must bypass
 * the ORM (reading the stored column, writing a value the type does not cover).
 *
 * `:memory:` cannot be shared between the drizzle wrapper and a second connection, and the raw
 * DatabaseSync is what makes the COLUMN itself observable rather than the repository's opinion of it.
 */
function freshRepo(dir: string) {
  const path = `${dir}/presets.db`;
  const db = createDb(path);
  const raw = new DatabaseSync(path);
  return { db, raw, repo: new SqliteExportPresetRepository(db) };
}

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir();
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

const PROFILE = {
  container: "mp4", videoCodec: "h264", audioCodec: "aac", encoder: "auto", encoderName: null,
  maxHeight: null, options: { quality: 23, maxBitrateKbps: null },
  aspectRatio: "16:9",
  captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 32, backgroundOpacity: 0.5 },
  nameTemplate: "{date}",
} as const;

Deno.test("a MISSING preset reads as absent, not as seeded", async () => {
  await withTempDir(async (dir) => {
  const { repo } = freshRepo(dir);
  assertEquals(
    await repo.originOf("no-such-preset"),
    null,
    "an unknown id must be null — reporting it as 'seeded' makes the route's 404 branch unreachable " +
    "and tells the user the preset exists but is protected",
  );
  });
});

Deno.test("origin round-trips, and a seeded preset cannot be promoted by re-saving it", async () => {
  await withTempDir(async (dir) => {
  const { repo } = freshRepo(dir);

  await repo.save({ id: "mine", name: "Mine", profile: { ...PROFILE }, createdAt: "2026-01-01", origin: "user" });
  await repo.save({ id: "theirs", name: "Theirs", profile: { ...PROFILE }, createdAt: "2026-01-01", origin: "seeded" });

  assertEquals(await repo.originOf("mine"), "user");
  assertEquals(await repo.originOf("theirs"), "seeded");

  // Re-saving over a seeded preset must NOT make it deletable: the origin is a property of the
  // EXISTING row, and the repo deliberately omits it from the conflict-update set.
  await repo.save({ id: "theirs", name: "Renamed", profile: { ...PROFILE }, createdAt: "2026-01-01", origin: "user" });
  assertEquals(
    await repo.originOf("theirs"),
    "seeded",
    "re-saving a seeded preset must not promote it to user-origin — that would be a silent path to " +
    "deleting an app preset through the save endpoint",
  );
  });
});

Deno.test("origin is a COLUMN, so it never round-trips through the config blob", async () => {
  await withTempDir(async (dir) => {
  const { raw, repo } = freshRepo(dir);
  await repo.save({ id: "mine", name: "Mine", profile: { ...PROFILE }, createdAt: "2026-01-01", origin: "user" });

  const row = raw.prepare("SELECT config_json, origin FROM export_presets WHERE id = ?").get("mine") as
    | { config_json: string; origin: string }
    | undefined;
  assert(row, "the row must exist");
  assertEquals(row.origin, "user", "the column is authoritative");
  assertEquals(
    JSON.parse(row.config_json).origin,
    undefined,
    "origin must NOT be duplicated inside config_json — two owners of one fact drift, and a stale blob " +
    "value would override the column",
  );
  raw.close();
  });
});

Deno.test("a row with an unreadable origin degrades to seeded, never to user", async () => {
  await withTempDir(async (dir) => {
  const { raw, repo } = freshRepo(dir);
  await repo.save({ id: "odd", name: "Odd", profile: { ...PROFILE }, createdAt: "2026-01-01", origin: "user" });
  // Something wrote a value the type does not cover (a hand-edited database, an older client).
  raw.prepare("UPDATE export_presets SET origin = ? WHERE id = ?").run("banana", "odd");
  assertEquals(
    await repo.originOf("odd"),
    "seeded",
    "an unrecognised origin must fail SAFE: an undeletable preset is a nuisance, a wrongly deletable " +
    "one is data loss",
  );
  raw.close();
  });
});
