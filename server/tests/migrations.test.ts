/**
 * MIGRATIONS — the one thing that cannot be a mode of failure.
 *
 * A migration that throws leaves an existing user's app unable to open, and there is no second
 * chance to get it right: the DB is theirs and it is the only copy. So this file tests the paths
 * every user can actually take, not just the developer's own:
 *
 *   1. A FRESH database — the most common path of all. A new user applies EVERY migration at once,
 *      so one broken migration breaks every install, not just upgrades.
 *   2. An upgrade from EVERY prior version, with data, asserting the data survives. A user three
 *      versions behind must reach LATEST in one open.
 *   3. Idempotency — the runner is called on every startup.
 *   4. Drift between `migrations.ts` (raw SQL) and `schema.ts` (what Drizzle queries). These are two
 *      owners of one truth: the SQL creates the columns, the schema declares them, and nothing in
 *      either file forces them to agree. A column added to `schema.ts` alone type-checks perfectly
 *      and then fails at runtime on every user's machine — so the sets are compared here.
 *   5. Atomicity — a migration that fails mid-way must roll back and leave the previous version
 *      recorded, so the app reports an honest error instead of a half-built schema.
 */
import { assert, assertEquals } from "@std/assert";
import { DatabaseSync } from "node:sqlite";
import { createDb } from "@/adapters/outbound/persistence/db.ts";
import { LATEST_VERSION, migrations, runMigrations } from "@/adapters/outbound/persistence/migrations.ts";
import { SqliteExportPresetRepository } from "@/adapters/outbound/persistence/repositories.ts";
import * as schema from "@/adapters/outbound/persistence/schema.ts";

/** Drizzle stores the SQL table name and its columns under these well-known symbols. */
const DRIZZLE_NAME = Symbol.for("drizzle:Name");
const DRIZZLE_COLUMNS = Symbol.for("drizzle:Columns");

async function withTempDir<T>(fn: (dir: string) => T | Promise<T>): Promise<T> {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-mig-" });
  try {
    return await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

function columnNames(db: DatabaseSync, table: string): Set<string> {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[];
  return new Set(rows.map((r) => r.name));
}

function tableExists(db: DatabaseSync, table: string, type = "table"): boolean {
  const row = db.prepare("SELECT name FROM sqlite_master WHERE name = ? AND type = ?")
    .get(table, type);
  return Boolean(row);
}

function appliedVersions(db: DatabaseSync): string[] {
  return (db.prepare("SELECT version FROM schema_versions").all() as { version: string }[])
    .map((r) => r.version);
}

/**
 * Build a database as it existed at `upto` migrations applied, by running the real migration SQL.
 *
 * Hand-writing a version's schema would test my guess at it; running the shipped SQL tests the
 * thing users actually have.
 */
/**
 * The index of a NAMED migration, so a test builds the schema as it stood BEFORE that version.
 *
 * `migrations.length - 1` looks like "the previous one" and is not: appending a migration silently
 * retargets every such call to the NEW last version, so the test starts building a schema that already
 * contains the change it is meant to be testing. That happened the first time a migration was added
 * after 0.9.0 — the 0.9.0 backfill test began asserting against a schema where `origin` already
 * existed, and the failure looked like a broken migration rather than a broken test.
 */
function versionIndex(version: string): number {
  const i = migrations.findIndex((m) => m.version === version);
  if (i < 0) throw new Error(`no migration named ${version}`);
  return i;
}

/** Build the schema as it stood immediately BEFORE `version`. */
function buildBefore(db: DatabaseSync, version: string): void {
  buildAtVersion(db, versionIndex(version));
}

function buildAtVersion(db: DatabaseSync, upto: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version TEXT PRIMARY KEY, description TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of migrations.slice(0, upto)) {
    for (const stmt of migration.up) db.exec(stmt);
    db.prepare("INSERT INTO schema_versions (version, description, applied_at) VALUES (?, ?, ?)")
      .run(migration.version, migration.description, "2020-01-01T00:00:00.000Z");
  }
}

/** A row that must survive migration, using only the columns that exist at this version. */
function seed(db: DatabaseSync, tag: string): void {
  const streamCols = columnNames(db, "streams");
  const pick = (values: Record<string, unknown>): [string[], unknown[]] => {
    const cols = Object.keys(values).filter((c) => streamCols.has(c));
    return [cols, cols.map((c) => values[c])];
  };
  const [cols, vals] = pick({
    id: `s-${tag}`, title: `stream ${tag}`, status: "completed",
    // NOT NULL from 0.1.0 — a seed that omitted it would fail on the constraint, not on the code
    // under test.
    vod_path: `/media/${tag}.mp4`,
    source_url: `https://twitch.tv/videos/${tag}`,
    created_at: "2020-01-01T00:00:00.000Z",
  });
  db.prepare(`INSERT INTO streams (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`)
    .run(...vals as string[]);

  const clipCols = columnNames(db, "clips");
  const clipPick = (values: Record<string, unknown>): [string[], unknown[]] => {
    const cs = Object.keys(values).filter((c) => clipCols.has(c));
    return [cs, cs.map((c) => values[c])];
  };
  const [cc, cv] = clipPick({
    id: `c-${tag}`, stream_id: `s-${tag}`, start_time: 100, end_time: 130, peak_time: 110,
    axis: "hype", score: 0.75, rejected: 0,
    // job_id, axis and score are NOT NULL before 0.6.0 makes them nullable, so the realistic
    // pre-0.6 state is an ENGINE clip — one with all three. Only the filter drops them where the
    // column is absent.
    job_id: `j-${tag}`,
    created_at: "2020-01-01T00:00:00.000Z",
  });
  db.prepare(`INSERT INTO clips (${cc.join(",")}) VALUES (${cc.map(() => "?").join(",")})`)
    .run(...cv as string[]);
}

// ── 1. Fresh install ─────────────────────────────────────────────────────────────────────────

Deno.test("a FRESH database reaches LATEST_VERSION through the real entry point", async () => {
  await withTempDir((dir) => {
    // `createDb` is what the app calls: it runs migrations on the raw connection before Drizzle.
    const db = createDb(`${dir}/fresh.db`);
    assert(db, "createDb must return a usable handle");

    const raw = new DatabaseSync(`${dir}/fresh.db`, { readOnly: true });
    try {
      assertEquals(appliedVersions(raw).sort(), migrations.map((m) => m.version).sort(),
        "every migration must be recorded on a fresh install");
      for (const table of ["export_list", "export_jobs", "clips", "streams"]) {
        assert(tableExists(raw, table), `${table} must exist after a fresh install`);
      }
    } finally {
      raw.close();
    }
  });
});

// ── 2. Every upgrade path, with data ─────────────────────────────────────────────────────────

Deno.test("every prior version upgrades to LATEST and keeps its data", async () => {
  // From zero migrations (a DB predating the tracking table) through the second-to-last.
  for (let upto = 0; upto < migrations.length; upto++) {
    await withTempDir((dir) => {
      const path = `${dir}/v${upto}.db`;
      const db = new DatabaseSync(path);
      try {
        buildAtVersion(db, upto);
        const seeded = tableExists(db, "streams") && tableExists(db, "clips");
        if (seeded) seed(db, String(upto));

        const before = seeded
          ? (db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c
          : 0;

        const result = runMigrations(db);

        assertEquals(appliedVersions(db).sort(), migrations.map((m) => m.version).sort(),
          `from ${upto} applied: every version must be recorded`);

        if (seeded) {
          const after = (db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c;
          assertEquals(after, before, `from ${upto}: the clip rows must survive`);
          const clip = db.prepare("SELECT start_time, end_time FROM clips WHERE id = ?")
            .get(`c-${upto}`) as { start_time: number; end_time: number } | undefined;
          assert(clip, `from ${upto}: the seeded clip must still be there`);
          assertEquals(clip.start_time, 100, `from ${upto}: start_time must be preserved`);
          assertEquals(clip.end_time, 130, `from ${upto}: end_time must be preserved`);
          const stream = db.prepare("SELECT id FROM streams WHERE id = ?").get(`s-${upto}`);
          assert(stream, `from ${upto}: the seeded stream must still be there`);
        }

        assert(result.applied > 0 || upto >= migrations.length,
          `from ${upto}: at least one migration should have been applied`);

        // The new tables must be usable, not merely present.
        db.exec(`INSERT INTO export_list (clip_id, added_at, position, removed_at)
                 VALUES ('probe', '2020-01-01T00:00:00.000Z', 1, NULL)`);
        assertEquals((db.prepare("SELECT COUNT(*) c FROM export_list").get() as { c: number }).c, 1);
      } finally {
        db.close();
      }
    });
  }
});

// ── 3. Idempotency ──────────────────────────────────────────────────────────────────────────

Deno.test("running migrations twice applies nothing the second time", async () => {
  await withTempDir((dir) => {
    const path = `${dir}/twice.db`;
    const db = new DatabaseSync(path);
    try {
      const first = runMigrations(db);
      assert(first.applied > 0, "the first run must apply migrations");
      const second = runMigrations(db);
      assertEquals(second.applied, 0, "the second run must apply nothing");
      assertEquals(appliedVersions(db).length, migrations.length,
        "and must not duplicate the recorded versions");
    } finally {
      db.close();
    }
  });
});

Deno.test("a database already at LATEST is left completely alone", async () => {
  await withTempDir((dir) => {
    const path = `${dir}/current.db`;
    const db = new DatabaseSync(path);
    try {
      runMigrations(db);
      seed(db, "current");
      const before = (db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c;
      const result = runMigrations(db);
      assertEquals(result.applied, 0);
      assertEquals((db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c, before,
        "running migrations on a current DB must not touch its rows");
    } finally {
      db.close();
    }
  });
});

// ── 4. Drift between the migration SQL and the Drizzle schema ───────────────────────────────

Deno.test("migration SQL and schema.ts agree on the columns of every table", async () => {
  await withTempDir((dir) => {
    const db = new DatabaseSync(`${dir}/drift.db`);
    try {
      runMigrations(db);

      const tables = Object.values(schema as Record<string, unknown>).filter((value) => {
        if (typeof value !== "object" || value === null) return false;
        const v = value as Record<symbol, unknown>;
        return typeof v[DRIZZLE_NAME] === "string" && v[DRIZZLE_COLUMNS] !== undefined;
      });
      assert(tables.length > 0, "no Drizzle tables were found to compare — the introspection broke");

      for (const table of tables) {
        const t = table as Record<symbol, unknown>;
        const name = t[DRIZZLE_NAME] as string;
        const declared = Object.values(t[DRIZZLE_COLUMNS] as Record<string, { name: string }>)
          .map((c) => c.name).sort();
        const actual = [...columnNames(db, name)].sort();

        // A column Drizzle queries but SQL never created fails at runtime for EVERY user; the
        // reverse is dead weight that silently accumulates. Both are drift.
        assertEquals(actual, declared,
          `table "${name}": schema.ts and the migrations disagree.\n` +
          `  in SQL only: ${actual.filter((c) => !declared.includes(c)).join(", ") || "none"}\n` +
          `  in schema.ts only: ${declared.filter((c) => !actual.includes(c)).join(", ") || "none"}`);
      }
    } finally {
      db.close();
    }
  });
});

Deno.test("the export repositories work against a migrated database", async () => {
  await withTempDir(async (dir) => {
    const db = createDb(`${dir}/repos.db`);
    assert(
      (schema.exportJobs as unknown as Record<symbol, unknown>)[DRIZZLE_NAME] === "export_jobs",
      "the schema must expose the export job table",
    );

    // A real insert/select through Drizzle proves the SQL and the schema agree in PRACTICE, which
    // the column-name comparison above cannot (types, NOT NULLs, defaults).
    const now = new Date().toISOString();
    await db.insert(schema.exportJobs).values({
      clip_id: "c1", status: "queued", position: 1, profile_json: "{}",
      output_dir: null, filename: null, artifact_path: null, phase: null,
      percent: 0, requested_at: now, started_at: null, completed_at: null, error: null,
    }).run();

    const rows = await db.select().from(schema.exportJobs).all();
    assertEquals(rows.length, 1);
    assertEquals(rows[0]?.clip_id, "c1");
    assertEquals(rows[0]?.status, "queued");
    assertEquals(rows[0]?.percent, 0);
  });
});

// ── 5. Atomicity ────────────────────────────────────────────────────────────────────────────

Deno.test("FAULT INJECTION: a failing migration rolls back its earlier statements", async () => {
  await withTempDir((dir) => {
    const db = new DatabaseSync(`${dir}/rollback.db`);
    try {
      // A real user state: everything applied, with data.
      runMigrations(db);
      seed(db, "rb");
      const versionsBefore = appliedVersions(db).sort();

      // The shipped migrations are hard to fail on purpose — every statement is `IF NOT EXISTS`,
      // so a pre-existing name conflict is SUPPRESSED rather than fatal (measured: creating a VIEW
      // named export_jobs, and an INDEX of an existing index's name, both succeed silently). That
      // robustness is asserted on its own below. To test the RUNNER's transaction, the failure has
      // to be genuine, so a synthetic migration is appended: its first statement succeeds, its
      // second cannot.
      const version = "99.0.0";
      migrations.push({
        version,
        description: "synthetic fault injection",
        up: [
          "CREATE TABLE synth_first_statement (a TEXT)",
          "INSERT INTO a_table_that_does_not_exist (a) VALUES (1)",
        ],
      });
      try {
        let threw = false;
        try {
          runMigrations(db);
        } catch (err) {
          threw = true;
          assert(err instanceof Error, "the failure must surface as an Error");
          assert(err.message.includes(version),
            `the error must name the failing migration, got: ${err.message}`);
        }
        assert(threw, "a failing migration must THROW rather than be swallowed");

        assertEquals(appliedVersions(db).sort(), versionsBefore,
          "the failed migration must not be recorded as applied");
        assert(!appliedVersions(db).includes(version), `${version} must not appear as applied`);
        // The load-bearing assertion: DDL inside the transaction is undone. Measured to hold for
        // node:sqlite, and it is the difference between a failed upgrade and a half-built schema.
        assert(!tableExists(db, "synth_first_statement"),
          "the successful FIRST statement must be rolled back with the failing second one");

        // And the user's data survives: an app that cannot open must not also have eaten their rows.
        assert(tableExists(db, "clips"));
        assertEquals((db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c, 1,
          "the rollback must leave existing rows intact");

        // Recovery: with the fault gone, the same DB upgrades cleanly.
        migrations.pop();
        const recovered = runMigrations(db);
        assertEquals(recovered.applied, 0, "nothing further to apply once the fault is removed");
        assert(appliedVersions(db).includes(LATEST_VERSION),
          "the database must be at LATEST after the fault is removed");
      } finally {
        const i = migrations.findIndex((m) => m.version === version);
        if (i >= 0) migrations.splice(i, 1);
      }
    } finally {
      db.close();
    }
  });
});

Deno.test("a REBUILD migration copies its rows before it drops the table", () => {
  // The data-loss shape for an existing user: `DROP TABLE x` with no prior copy. Migrations run in
  // a transaction, so a crash is safe — but a missing INSERT is not, and it is silent: the app opens
  // on an empty table and reports success.
  for (const m of migrations) {
    const drops = m.up.filter((s) => /^\s*DROP\s+TABLE\b/i.test(s));
    if (drops.length === 0) continue;
    for (const drop of drops) {
      const dropped = /DROP\s+TABLE\s+(?:IF\s+EXISTS\s+)?([\w"]+)/i.exec(drop)?.[1]?.replace(/"/g, "");
      assert(dropped, `could not parse the dropped table in ${m.version}`);
      const copy = m.up.findIndex((s) =>
        new RegExp(`INSERT\\s+INTO\\s+\\w+[\\s\\S]*SELECT[\\s\\S]*FROM\\s+${dropped}\\b`, "i").test(s));
      assert(copy >= 0,
        `migration ${m.version} drops "${dropped}" without copying it first — that is silent data loss`);
      assert(copy < m.up.indexOf(drop),
        `migration ${m.version} must copy "${dropped}" BEFORE dropping it`);
    }
  }
});

Deno.test("each migration is self-contained and ordered: a rebuild drops what it later recreates", () => {
  for (const m of migrations) {
    const sql = m.up.join("\n");
    const rebuilds = /RENAME TO/i.test(sql);
    if (!rebuilds) continue;
    // The rebuild idiom: create <x>_new, copy, drop <x>, rename <x>_new to <x>. `IF NOT EXISTS` on
    // the CREATE would be WRONG here — it would silently reuse a stale partial table and then
    // either duplicate rows or fail confusingly — so a rebuild is deliberately allowed to fail
    // loudly. That is only safe because the runner wraps each migration in a transaction, which the
    // fault-injection test above measures. What must hold is that every index the rebuild dropped
    // with the old table is recreated for the new one.
    const dropIdx = m.up.findIndex((s) => /^\s*DROP\s+TABLE\b/i.test(s));
    const after = m.up.slice(dropIdx);
    for (const stmt of after) {
      if (!/^\s*CREATE\s+INDEX/i.test(stmt)) continue;
      assert(/IF NOT EXISTS/i.test(stmt),
        `migration ${m.version} recreates an index without IF NOT EXISTS: ${stmt.slice(0, 70)}`);
    }
  }
});

Deno.test("the migration list is well-formed: unique, ordered versions", () => {
  const versions = migrations.map((m) => m.version);
  assertEquals(new Set(versions).size, versions.length, "two migrations share a version");
  const sorted = [...versions].sort((a, b) => {
    const [am = 0, ap = 0] = a.split(".").map(Number);
    const [bm = 0, bp = 0] = b.split(".").map(Number);
    return (am - bm) || (ap - bp);
  });
  assertEquals(versions, sorted, "migrations must be in ascending version order");
  assert(versions.every((v) => /^\d+\.\d+\.\d+$/.test(v)), "every version must be major.minor.patch");
  assertEquals(LATEST_VERSION, versions[versions.length - 1], "LATEST_VERSION must be the last entry");
  for (const m of migrations) {
    assert(m.description.trim().length > 0, `migration ${m.version} has an empty description`);
    assert(m.up.length > 0, `migration ${m.version} has no statements`);
  }
});

/**
 * 0.9.0 adds `export_presets.origin`. The property that matters is the BACKFILL: a user's existing
 * presets must come out marked `seeded`, not NULL and not `user`.
 *
 * It is also the reason a preset wrongly marked seeded is the safe direction to fail in — undeletable
 * is a nuisance, wrongly deletable is data loss — so the assertion is one-sided on purpose.
 */
Deno.test("the preset-origin statement backfills every existing preset as seeded, and it reads back", async () => {
  await withTempDir((dir) => {
    const db = new DatabaseSync(`${dir}/t.db`);
    db.exec("PRAGMA foreign_keys = ON");
    // Build the schema as it stood BEFORE 0.9.0, then put real presets in it — the state a user of
    // 0.8.0 actually has on disk.
    buildBefore(db, "0.6.0");

    const cols = columnNames(db, "export_presets");
    assert(!cols.has("origin"), "the pre-0.6.0 schema must not already have the column");

    const insert = db.prepare(
      `INSERT INTO export_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)`,
    );
    insert.run("preset-tiktok-916", "TikTok 9:16 H.264", "{}", "2026-01-01T00:00:00.000Z");
    insert.run("preset-archive-169", "Archive 16:9", "{}", "2026-01-01T00:00:01.000Z");

    const result = runMigrations(db);
    assert(result.applied >= 1, "the consolidated migration must actually apply");

    const rows = db.prepare("SELECT id, origin FROM export_presets ORDER BY id").all();
    // The two fixtures survive, and migration 0.7.0 adds the Landscape preset — so this asserts the
    // SEEDED set is present rather than a bare count, which would read the intended insert as loss.
    const ids = rows.map((r) => r.id as string);
    for (const expected of ["preset-tiktok-916", "preset-archive-169", "preset-landscape-169"]) {
      assert(ids.includes(expected), `${expected} must exist after the migration`);
    }
    for (const r of rows) {
      assertEquals(
        r.origin, "seeded",
        `preset ${r.id} must be backfilled as seeded — a NULL or 'user' here would make an app preset deletable`,
      );
    }

    // Fresh inserts may state their own origin and must keep it.
    insert.run("mine-abc", "My profile", "{}", "2026-02-01T00:00:00.000Z");
    db.prepare("UPDATE export_presets SET origin = 'user' WHERE id = ?").run("mine-abc");
    const mine = db.prepare("SELECT origin FROM export_presets WHERE id = ?").get("mine-abc") as
      | { origin: string }
      | undefined;
    assertEquals(mine?.origin, "user");

    db.close();
  });
});

/**
 * One database per case, because `id` is the PRIMARY KEY.
 *
 * This is the shape the guards need and the shape a single fixture cannot give: "the shipped template
 * gets stripped" and "a template the user edited is kept" are two states of the SAME id. An earlier
 * version of this test put the edited row under a DIFFERENT id, so the id guard excluded it and the
 * template guard was never exercised — the test passed while proving nothing about the guard it named.
 * Falsifying the template guard is what exposed that.
 */
function migrateWithPresets(
  dir: string,
  rows: { id: string; name: string; template: string }[],
): Record<string, { origin: string; template: string }> {
  const db = new DatabaseSync(`${dir}/t.db`);
  db.exec("PRAGMA foreign_keys = ON");
  buildBefore(db, "0.6.0");
  const insert = db.prepare(
    `INSERT INTO export_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)`,
  );
  rows.forEach((r, i) => {
    insert.run(r.id, r.name, JSON.stringify({ nameTemplate: r.template }), `2026-01-01T00:00:0${i}.000Z`);
  });
  const result = runMigrations(db);
  assert(result.applied >= 1, "the consolidated migration must apply");
  const out = db.prepare("SELECT id, origin, config_json FROM export_presets").all() as
    { id: string; origin: string; config_json: string }[];
  // Every fixture row must survive. NOT `=== rows.length`: migration 0.7.0 also INSERTS the Landscape
  // preset, so the table legitimately grows by one — asserting equality would make that insert look
  // like data loss. The fixtures are checked by presence below.
  for (const r of rows) {
    assert(out.some((o) => o.id === r.id), `${r.id} must survive the migration`);
  }
  db.close();
  return Object.fromEntries(
    out.map((r) => [r.id, { origin: r.origin, template: JSON.parse(r.config_json).nameTemplate as string }]),
  );
}

/**
 * One database per case, for the same reason the template tests need it: the captions guard's two cases
 * are two states of ONE row, and `id` is the primary key.
 */
function captionsAfterMigration(
  dir: string,
  config: Record<string, unknown>,
): Record<string, unknown> {
  const db = new DatabaseSync(`${dir}/t.db`);
  db.exec("PRAGMA foreign_keys = ON");
  buildBefore(db, "0.7.0");
  db.prepare(`INSERT INTO export_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)`)
    .run("preset-tiktok-916", "Portrait 9:16 H.264", JSON.stringify(config), "2026-01-01T00:00:01.000Z");
  runMigrations(db);
  const row = db.prepare("SELECT config_json FROM export_presets WHERE id = 'preset-tiktok-916'")
    .get() as { config_json: string };
  db.close();
  return JSON.parse(row.config_json);
}

Deno.test("0.8.0 turns captions OFF on a preset that still carries the shipped block", async () => {
  await withTempDir((dir) => {
    const after = captionsAfterMigration(dir, {
      container: "mp4", videoCodec: "h264", audioCodec: "aac",
      // EXACTLY the block the seeder ships, captions on.
      captions: { enabled: true, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
    });
    const captions = after.captions as Record<string, unknown>;
    assertEquals(captions.enabled, false, "a preset must not turn a caption burn-in on for the user");
    // The REST of the block must survive: this is a repair of one flag, not a reset of the style.
    assertEquals(captions.preset, "bold-white");
    assertEquals(captions.position, "bottom");
    assertEquals(captions.fontSize, 48);
    assertEquals(captions.backgroundOpacity, 0.8);
  });
});

Deno.test("0.8.0 leaves a captions block the user EDITED completely alone", async () => {
  // The case the whole-value guard exists for. `origin` cannot protect this row — editing a seeded
  // preset leaves origin='seeded' (measured) — so the guard is the shipped VALUE. Each variant below
  // differs in exactly ONE field, which is enough to mark it as somebody's choice.
  const variants: Record<string, Record<string, unknown>[]> = {
    "a different font size": [
      { enabled: true, preset: "bold-white", position: "bottom", fontSize: 32, backgroundOpacity: 0.8 },
    ],
    "a different position": [
      { enabled: true, preset: "bold-white", position: "top", fontSize: 48, backgroundOpacity: 0.8 },
    ],
    "a different style": [
      { enabled: true, preset: "yellow", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
    ],
    "a different opacity": [
      { enabled: true, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.5 },
    ],
  };
  for (const [label, [captions]] of Object.entries(variants)) {
    await withTempDir((dir) => {
      const after = captionsAfterMigration(dir, {
        container: "mp4", videoCodec: "h264", audioCodec: "aac", captions,
      });
      assertEquals(
        (after.captions as Record<string, unknown>).enabled,
        true,
        `${label}: the user's own captions choice must not be reversed`,
      );
    });
  }
});

Deno.test("0.8.0 is a no-op on a preset that never had captions on", async () => {
  // The third state: already off. It must stay off, and the statement must not touch it at all.
  await withTempDir((dir) => {
    const after = captionsAfterMigration(dir, {
      container: "mp4", videoCodec: "h264", audioCodec: "aac",
      captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
    });
    assertEquals((after.captions as Record<string, unknown>).enabled, false);
  });
});

Deno.test("0.8.0 adds the MKV archive preset and 0.9.0 REMOVES it again", async () => {
  await withTempDir((dir) => {
    const db = new DatabaseSync(`${dir}/t.db`);
    db.exec("PRAGMA foreign_keys = ON");
    buildBefore(db, "0.7.0");
    db.prepare(`INSERT INTO export_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)`)
      .run("preset-tiktok-916", "Portrait 9:16 H.264", `{"container":"mp4","videoCodec":"h264"}`, "2026-01-01T00:00:01.000Z");
    runMigrations(db);
    // 0.8.0 inserted the MKV/FLAC archive preset LAST (ordering is `created_at` ASC and it carried
    // the newest stamp). 0.9.0 then DELETES it along with `16:9 Archive H.264`: an MKV/FLAC archive
    // preset is not something a user reaches for, and `16:9 Archive` duplicated Landscape with an
    // explicit software encoder. So the chain's end state is that NEITHER archive row exists, which
    // is what this asserts — the intermediate state is 0.8.0's business and is covered by the
    // migration list itself.
    const ids = db.prepare("SELECT id FROM export_presets").all() as { id: string }[];
    const present = ids.map((r) => r.id);
    for (const gone of ["preset-archive-169", "preset-archive-mkv"]) {
      assert(!present.includes(gone), `${gone} must have been removed by 0.9.0`);
    }
    // And the presets that must SURVIVE are still there: deleting two shipped rows must not take the
    // rest with them.
    assert(present.includes("preset-tiktok-916"), "the user's own row must survive the delete");
    assert(present.includes("preset-landscape-169"), "Landscape must survive the delete");
    db.close();
  });
});

Deno.test("the template statements strip the SHIPPED literal and retire the {axis} token", async () => {
  await withTempDir((dir) => {
    const after = migrateWithPresets(dir, [
      { id: "preset-tiktok-916", name: "TikTok", template: "{date}-{channel}-{axis}-{ts}-tiktok" },
      { id: "preset-shorts-916-vp9", name: "Shorts", template: "{date}-{channel}-{axis}-{ts}-shorts" },
      { id: "preset-archive-169", name: "Archive", template: "{date}-{channel}-{axis}-{ts}" },
    ]);
    // Two migrations act on these templates in sequence: 0.6.0 strips the invented platform suffix
    // from the two shipped ids, then 0.7.0 retires `{axis}` because the TOKEN no longer exists — a
    // template keeping it would render the literal text `{axis}` into a filename.
    assertEquals(after["preset-tiktok-916"]!.template, "{date}-{channel}-{name}-{ts}");
    assertEquals(after["preset-shorts-916-vp9"]!.template, "{date}-{channel}-{name}-{ts}");
    // NOTE this row was "already clean" under 0.6.0 and is NOT clean under 0.7.0: it still carries the
    // retired token. That is the point of scoping the rewrite by content rather than by id.
    assertEquals(after["preset-archive-169"]!.template, "{date}-{channel}-{name}-{ts}");
    for (const id of Object.keys(after)) {
      assertEquals(after[id]!.origin, "seeded", `${id} must be backfilled as seeded`);
    }
  });
});

Deno.test("the {axis} rewrite LEAVES a template the user edited, when it has no {axis} in it", async () => {
  // Same id as the shipped preset, custom template — the case ONLY a content-based rule can protect,
  // and the case that a test scoping the rewrite by id would silently fail to cover.
  await withTempDir((dir) => {
    const after = migrateWithPresets(dir, [
      { id: "preset-tiktok-916", name: "TikTok", template: "{date}-{channel}-my-cut-{ts}" },
    ]);
    assertEquals(after["preset-tiktok-916"]!.template, "{date}-{channel}-my-cut-{ts}",
      "the user's own text must survive — the token check, not the id, is what protects it");
  });
});

Deno.test("the {axis} rewrite reaches ANY preset whose template still uses the retired token", async () => {
  // Deliberately the OPPOSITE of the 0.6.0 template rule, and the difference is intentional:
  // 0.6.0 stripped a literal from two specific shipped templates (an id+content match), because
  // `-tiktok` was invented text that only those rows carried. `{axis}` is a TOKEN that no longer
  // exists in the vocabulary, so any template containing it is BROKEN and renders `{axis}` literally
  // — repairing it is not the same as renaming something a user chose.
  await withTempDir((dir) => {
    const after = migrateWithPresets(dir, [
      { id: "mine-custom", name: "My profile", template: "{date}-{axis}-{ts}" },
    ]);
    assertEquals(after["mine-custom"]!.template, "{date}-{name}-{ts}",
      "a dead token must be repaired wherever it appears, not only in the shipped presets");
  });
});

Deno.test("the {axis} rewrite leaves a preset with NO template key untouched — it must not write null", async () => {
  // The predicate's real job, found by falsification rather than assumed: on a row whose config_json
  // has no `nameTemplate` at all, `json_extract` yields SQL NULL and `json_set` then writes an explicit
  // `"nameTemplate": null` INTO the row. `replace(NULL, …)` is a harmless no-op — the `json_set` is
  // not, and it turns an absent key into a present-but-null one for every later reader.
  // So this is not tidiness: it is the difference between "no opinion" and "explicitly nothing".
  await withTempDir((dir) => {
    const after = migrateWithPresets(dir, [
      // No `template` field: the fixture writes a config_json without the key.
      { id: "preset-no-template", name: "Legacy row", template: undefined as unknown as string },
    ]);
    // Read the RAW json, because the repository's normaliser would fill the field on read and hide it.
    const db = new DatabaseSync(`${dir}/t.db`);
    const row = db.prepare("SELECT config_json FROM export_presets WHERE id = 'preset-no-template'")
      .get() as { config_json: string };
    db.close();
    assert(
      !("nameTemplate" in JSON.parse(row.config_json)),
      `the key must stay ABSENT, not become null — got ${row.config_json}`,
    );
  });
});

Deno.test("0.7.0 inserts the Landscape preset ABOVE every existing row", async () => {
  await withTempDir((dir) => {
    const after = migrateWithPresets(dir, [
      { id: "preset-tiktok-916", name: "TikTok", template: "{date}-{channel}-{axis}-{ts}" },
    ]);
    assert("preset-landscape-169" in after, "the Landscape preset must be added to an existing database");
    // Ordering is `created_at` ASC, so "above" is an EARLIER stamp than any shipped row. Asserted
    // against the shipped stamps rather than assumed.
    const db = new DatabaseSync(`${dir}/t.db`);
    const order = db.prepare("SELECT id FROM export_presets ORDER BY created_at ASC").all() as { id: string }[];
    assertEquals(order[0]?.id, "preset-landscape-169", "Landscape must sort FIRST");
    const counts = db.prepare("SELECT count(*) AS n FROM export_presets").get() as { n: number };
    // The fixture row plus Landscape (0.7.0). The MKV archive preset 0.8.0 adds is REMOVED again by
    // 0.9.0, so the chain's end state has two rows. Asserted by NAMING what must be present rather
    // than only by a count, so a later migration adding a preset updates this test only if it
    // actually changes what this test is about.
    assertEquals(counts.n, 2, "the fixture plus Landscape, with both archive presets removed");
    for (const id of ["preset-landscape-169", "preset-tiktok-916"]) {
      assert(
        (db.prepare("SELECT count(*) AS n FROM export_presets WHERE id = ?").get(id) as { n: number }).n === 1,
        `${id} must be present exactly once`,
      );
    }
    db.close();
  });
});

Deno.test("0.7.0 renames the platform-named preset only when it still carries the shipped name", async () => {
  await withTempDir((dir) => {
    migrateWithPresets(dir, [
      { id: "preset-tiktok-916", name: "TikTok 9:16 H.264", template: "{date}-{channel}-{name}-{ts}" },
    ]);
    const db = new DatabaseSync(`${dir}/t.db`);
    const row = db.prepare("SELECT name FROM export_presets WHERE id = 'preset-tiktok-916'").get() as { name: string };
    assertEquals(row.name, "Portrait 9:16 H.264", "the shipped platform name must be replaced");
    db.close();
  });
  // A user who renamed it themselves keeps their name: the statement is guarded on the OLD name.
  await withTempDir((dir) => {
    migrateWithPresets(dir, [
      { id: "preset-tiktok-916", name: "My vertical one", template: "{date}-{channel}-{name}-{ts}" },
    ]);
    const db = new DatabaseSync(`${dir}/t.db`);
    const row = db.prepare("SELECT name FROM export_presets WHERE id = 'preset-tiktok-916'").get() as { name: string };
    assertEquals(row.name, "My vertical one", "a user's own name for the preset must not be overwritten");
    db.close();
  });
});

Deno.test("after an upgrade to the latest schema the repository reads every preset back with a full profile", async () => {
  // The join between the two halves of the fix: a database that took the whole upgrade must be READABLE
  // through the real repository, because that is what the export page does on the next request.
  await withTempDir(async (dir) => {
    const path = `${dir}/t.db`;
    const raw = new DatabaseSync(path);
    raw.exec("PRAGMA foreign_keys = ON");
    buildAtVersion(raw, versionIndex("0.5.0") + 1);
    raw.prepare(`INSERT INTO export_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)`)
      .run("preset-tiktok-916", "TikTok 9:16 H.264",
        `{"format":"mp4_h264","aspectRatio":"9:16","cropPosition":"center","captions":{"enabled":true,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}-tiktok"}`,
        "2026-01-01T00:00:00.000Z");
    runMigrations(raw);
    raw.close();

    const repo = new SqliteExportPresetRepository(createDb(path));
    const all = await repo.list();
    // The fixture row plus the Landscape preset 0.7.0 inserts. Ordered by `created_at`, so the
    // Landscape row sorts FIRST and the fixture is the second entry. The two archive presets are
    // absent: 0.8.0 added one and 0.9.0 removes both.
    assertEquals(all.length, 2);
    const p = all.find((x) => x.id === "preset-tiktok-916")!;
    assert(p, "the fixture preset must be readable through the repository");
    // The field whose absence froze the export page.
    assert(p.profile, "`profile` must be present after the chain");
    assertEquals(p.profile.videoCodec, "h264");
    assertEquals(p.profile.container, "mp4");
    assertEquals(p.profile.aspectRatio, "9:16");
    assertEquals(p.origin, "seeded");
    // The end state of both template migrations, seen through the reader the page uses.
    assertEquals(p.profile.nameTemplate, "{date}-{channel}-{name}-{ts}");
    assertEquals(p.name, "Portrait 9:16 H.264", "the rename must be visible through the repository too");
    // And the row 0.7.0 added is fully readable, not a half-built blob.
    const landscape = all[0]!;
    assertEquals(landscape.id, "preset-landscape-169");
    assertEquals(landscape.profile.aspectRatio, "16:9");
    assertEquals(landscape.profile.videoCodec, "h264");
    assertEquals(landscape.profile.audioCodec, "aac");
    assertEquals(landscape.origin, "seeded");
  });
});

Deno.test("0.5.0 migrates FLAWLESSLY to the LATEST schema — the REAL published-user path", async () => {
  // 0.5.0 is the highest schema any shipped release created (`v26.252`/`v26.253`), so this is the
  // upgrade EVERY existing user performs on the next release. It is also the worst case for the
  // export_presets rows: 0.4.0 created the table, 0.5.0's own seeder wrote the legacy FLAT blob with
  // the `-tiktok` / `-shorts` literals, and `origin` does not exist yet. The consolidated 0.6.0 — the
  // only migration this path runs — is a REBUILD (`DROP TABLE`), the one kind that can lose rows.
  await withTempDir((dir) => {
    const db = new DatabaseSync(`${dir}/t.db`);
    db.exec("PRAGMA foreign_keys = ON");
    buildAtVersion(db, versionIndex("0.5.0") + 1); // INCLUSIVE: 0.5.0 IS the shipped schema

    assert(!columnNames(db, "export_presets").has("origin"),
      "the 0.5.0 schema must not already have `origin`");

    const insert = db.prepare(
      `INSERT INTO export_presets (id, name, config_json, created_at) VALUES (?, ?, ?, ?)`,
    );
    // Verbatim what the PUBLISHED seeder wrote (checked against origin/main's container.ts).
    insert.run("preset-tiktok-916", "TikTok 9:16 H.264",
      `{"format":"mp4_h264","aspectRatio":"9:16","cropPosition":"center","captions":{"enabled":true,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}-tiktok"}`,
      "2026-01-01T00:00:00.000Z");
    insert.run("preset-shorts-916-vp9", "Shorts 9:16 VP9",
      `{"format":"webm","aspectRatio":"9:16","cropPosition":"center","captions":{"enabled":true,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}-shorts"}`,
      "2026-01-01T00:00:01.000Z");
    insert.run("preset-archive-169", "16:9 Archive H.264",
      `{"format":"mp4_h264","aspectRatio":"16:9","cropPosition":"center","captions":{"enabled":false,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{axis}-{ts}"}`,
      "2026-01-01T00:00:02.000Z");

    // Real user data that the 0.6.0 REBUILD touches.
    seed(db, "v5");
    const clipsBefore = (db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c;
    const streamsBefore = (db.prepare("SELECT COUNT(*) c FROM streams").get() as { c: number }).c;

    const result = runMigrations(db);

    assertEquals(appliedVersions(db).sort(), migrations.map((m) => m.version).sort(),
      "0.5.0 must reach the latest schema in one open, recording every version");
    assertEquals(result.applied, 4,
      "0.5.0 upgrades by exactly FOUR steps: the consolidated 0.6.0, then 0.7.0, 0.8.0, then 0.9.0");

    // Nothing lost to the rebuild.
    assertEquals((db.prepare("SELECT COUNT(*) c FROM clips").get() as { c: number }).c, clipsBefore,
      "the 0.6.0 rebuild must not lose clip rows");
    assertEquals((db.prepare("SELECT COUNT(*) c FROM streams").get() as { c: number }).c, streamsBefore,
      "the 0.6.0 rebuild must not lose stream rows");
    // THREE, not five: the published user's three presets, plus Landscape (0.7.0), MINUS the two
    // Archive presets 0.9.0 deletes (`16:9 Archive H.264`, which came from the old seeder, and the
    // MKV/FLAC one 0.8.0 had just added).
    assertEquals((db.prepare("SELECT COUNT(*) c FROM export_presets").get() as { c: number }).c, 3,
      "the surviving presets: the two still-shipped ones plus Landscape");

    const rows = db.prepare("SELECT id, origin, config_json FROM export_presets ORDER BY id").all() as
      { id: string; origin: string; config_json: string }[];
    for (const r of rows) assertEquals(r.origin, "seeded", `${r.id} must be backfilled as seeded`);
    const parsed = (id: string) => JSON.parse(rows.find((r) => r.id === id)!.config_json);
    const template = (id: string) => parsed(id).nameTemplate;
    // The end state of BOTH template migrations for an upgrading user: the invented suffix is gone
    // (0.6.0) and the retired token is replaced (0.7.0).
    assertEquals(template("preset-tiktok-916"), "{date}-{channel}-{name}-{ts}",
      "the shipped literal must be gone AND the retired token repaired for an upgrading user");
    assertEquals(template("preset-shorts-916-vp9"), "{date}-{channel}-{name}-{ts}");
    assertEquals(template("preset-landscape-169"), "{date}-{channel}-{name}-{ts}");

    // The rename reached this user too.
    const tiktok = db.prepare("SELECT name FROM export_presets WHERE id = 'preset-tiktok-916'").get() as { name: string };
    assertEquals(tiktok.name, "Portrait 9:16 H.264");

    // ── 0.8.0's effect, on the path a REAL upgrading user takes ────────────────────────────────
    // This is the statement whose guard matters most: two of the three published presets come out of
    // 0.5.0 with captions ON and EXACTLY the shipped block, so they must be turned OFF.
    for (const id of ["preset-tiktok-916", "preset-shorts-916-vp9"]) {
      assertEquals(
        parsed(id).captions.enabled, false,
        `${id} shipped with the untouched captions block, so 0.8.0 must turn its captions OFF`,
      );
    }

    // ── 0.9.0's effect: the archive presets are GONE ───────────────────────────────────────────
    // Both, and by the shipped-name predicate: the published user's `16:9 Archive H.264` row carries
    // the name the guard requires, so it is deleted; the MKV one 0.8.0 added goes with it.
    const remaining = rows.map((r) => r.id);
    for (const gone of ["preset-archive-169", "preset-archive-mkv"]) {
      assert(!remaining.includes(gone), `${gone} must have been removed by 0.9.0`);
    }
    // And the row that must SURVIVE did: a delete that also took the user's other presets would be a
    // catastrophic, silent data loss, so this is asserted rather than implied by the count above.
    assert(remaining.includes("preset-tiktok-916"), "the still-shipped Portrait preset must survive");
    assert(remaining.includes("preset-shorts-916-vp9"), "the still-shipped Shorts preset must survive");

    db.close();
  });
});
