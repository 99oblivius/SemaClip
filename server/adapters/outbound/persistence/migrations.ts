/**
 * Embedded migration system for distributed desktop apps.
 *
 * Migrations are TypeScript objects bundled into the binary — no disk file
 * reads at runtime. When a user updates via Deno Desktop's auto-updater,
 * the new binary carries new migrations which run automatically on startup.
 *
 * Uses a `schema_versions` table (not Drizzle's `__drizzle_migrations`) so
 * we control the tracking schema and can reason about it outside Drizzle.
 */

import type { DatabaseSync } from "node:sqlite";

export interface Migration {
  /** Semantic version of the app that introduced this migration. */
  version: string;
  /** Human-readable description for logs. */
  description: string;
  /** Ordered SQL statements, executed in a single transaction. */
  up: string[];
}

/** All migrations, ordered from oldest to newest. */
export const migrations: Migration[] = [
  {
    version: "0.1.0",
    description: "Initial schema",
    up: [
      `CREATE TABLE IF NOT EXISTS streams (
        id TEXT PRIMARY KEY,
        vod_path TEXT NOT NULL,
        chat_path TEXT,
        source_url TEXT,
        title TEXT,
        streamer TEXT,
        game TEXT,
        duration REAL,
        created_at TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending'
      )`,
      `CREATE TABLE IF NOT EXISTS jobs (
        id TEXT PRIMARY KEY,
        stream_id TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'queued',
        position INTEGER NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT,
        config_json TEXT NOT NULL DEFAULT '{}'
      )`,
      `CREATE TABLE IF NOT EXISTS clips (
        id TEXT PRIMARY KEY,
        job_id TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        axis TEXT NOT NULL,
        score REAL NOT NULL,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        peak_time REAL NOT NULL,
        justification TEXT,
        rank INTEGER,
        exported INTEGER NOT NULL DEFAULT 0,
        export_path TEXT,
        rejected INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS personas (
        id TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        stream_count INTEGER NOT NULL DEFAULT 0
      )`,
      `CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      )`,
    ],
  },
  {
    version: "0.2.0",
    description: "Add stream_metadata table for derived artifacts (waveforms, chat density, thumbnails)",
    up: [
      `CREATE TABLE IF NOT EXISTS stream_metadata (
        stream_id TEXT NOT NULL,
        key TEXT NOT NULL,
        value TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (stream_id, key)
      )`,
      `CREATE INDEX IF NOT EXISTS idx_stream_metadata_stream ON stream_metadata (stream_id)`,
    ],
  },
  // ── Future migrations appended here, oldest → newest ──
  {
    version: "0.3.0",
    description: "Add clips.signals_json (persisted ClipSignals); enable FK enforcement",
    up: [
      `ALTER TABLE clips ADD COLUMN signals_json TEXT`,
      // Enforce referential integrity the v1 schema promised but never declared.
      `CREATE INDEX IF NOT EXISTS idx_jobs_stream ON jobs (stream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_clips_stream ON clips (stream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_clips_job ON clips (job_id)`,
    ],
  },
  {
    version: "0.4.0",
    description: "Add export_presets table (P0-7 named format/aspect/caption bundles)",
    up: [
      `CREATE TABLE IF NOT EXISTS export_presets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        config_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      )`,
    ],
  },
  {
    version: "0.5.0",
    description: "Add streams.project_dir — each project records where its folder lives",
    up: [
      // A project's folder is no longer implied by its id: it is named after the stream and
      // lives wherever the user's VOD directory points, and they can move it. The path has
      // to be RECORDED, because nothing can re-derive it: the folder name depends on the
      // VOD's metadata and a collision suffix, and the location is the user's choice.
      //
      // NULL deliberately means "not recorded" rather than "missing": rows written before
      // this migration resolve their location on read (see StreamReconciler, which adopts
      // and persists it), which is why there is no data backfill here. A migration cannot
      // stat a filesystem — the value is unknowable at migration time for a folder the user
      // may have moved or unmounted, and guessing would record a path that is wrong.
      `ALTER TABLE streams ADD COLUMN project_dir TEXT`,
    ],
  },
  {
    version: "0.6.0",
    description: "Everything since the last release: clip naming and manual clips, the durable export list and batch, preset origin, and clean preset templates",
    up: [
      // ── ONE MIGRATION, BECAUSE IT IS ONE UNRELEASED STEP ────────────────────────────────────
      //
      // This consolidates what were migrations 0.6.0 through 0.10.0. None of them ever shipped: the
      // highest schema any released build created is 0.5.0 (`v26.252` / `v26.253`), so their separate
      // version numbers described the author's working history rather than any state a user can be in.
      // Five numbers for one unreleased step is noise in a list whose whole job is to describe the path
      // from a user's database to the current schema — and 0.6.0 is a REBUILD (`DROP TABLE`), so
      // chaining four more migrations onto it multiplied the risk of the one step that can lose rows.
      //
      // The statements are kept IN THEIR ORIGINAL ORDER and unedited, so the end state is identical by
      // construction rather than by argument; the tests assert the same outcomes they did before the
      // consolidation. Nothing was "simplified" while merging — a rebuilt `clips` table still gets
      // 0.7.0's column added by a later statement rather than by editing the rebuild, because editing
      // it would be a NEW migration wearing an old version number.
      //
      // Section order, preserved: rebuild clips (drop/rename/recreate) → add clips.title → create the
      // export list and export jobs → add export_presets.origin → strip the shipped template literals.


      // A clip can now be made BY HAND, with no engine and no job: create one, trim it with
      // the endpoints, export it. Such a clip has no job, no axis and no score, and all three
      // columns are NOT NULL.
      //
      // SQLite cannot drop NOT NULL with ALTER, so this is a table REBUILD. It is safe without
      // the usual foreign-key dance because no FOREIGN KEY is declared anywhere in this schema
      // (see the 0.1.0 DDL) — `PRAGMA foreign_keys = ON` is set in db.ts but has nothing to
      // enforce, so the rebuild's FK-off preamble is unnecessary here.
      //
      // NULL is the honest encoding, not a sentinel: `axis` NULL means "no engine axis" and
      // `score` NULL means "not ranked" — the same three-valued discipline as
      // `streams.project_dir`, where NULL means "not recorded" rather than "missing". A
      // sentinel axis or a score of 0 would make a hand-made clip look like a badly-ranked
      // engine finding, and "0.00" is a visible lie in the clip detail panel.
      //
      // `job_id` becomes nullable with them: a manual clip genuinely has no job, and
      // synthesising a sentinel job id would fabricate a record that the job queue and the
      // honesty rules both reject.
      `CREATE TABLE clips_new (
        id TEXT PRIMARY KEY,
        job_id TEXT,
        stream_id TEXT NOT NULL,
        axis TEXT,
        score REAL,
        start_time REAL NOT NULL,
        end_time REAL NOT NULL,
        peak_time REAL NOT NULL,
        justification TEXT,
        rank INTEGER,
        exported INTEGER NOT NULL DEFAULT 0,
        export_path TEXT,
        rejected INTEGER NOT NULL DEFAULT 0,
        signals_json TEXT
      )`,
      `INSERT INTO clips_new
        (id, job_id, stream_id, axis, score, start_time, end_time, peak_time,
         justification, rank, exported, export_path, rejected, signals_json)
        SELECT id, job_id, stream_id, axis, score, start_time, end_time, peak_time,
               justification, rank, exported, export_path, rejected, signals_json
        FROM clips`,
      `DROP TABLE clips`,
      `ALTER TABLE clips_new RENAME TO clips`,
      // The indexes belonged to the dropped table; recreate them with 0.3.0's definitions.
      `CREATE INDEX IF NOT EXISTS idx_clips_stream ON clips (stream_id)`,
      `CREATE INDEX IF NOT EXISTS idx_clips_job ON clips (job_id)`,


      // A clip needs a NAME, and it cannot live in `axis`.
      //
      // `axis` is an engine-semantics enum (hype/humor/skill/…): it is validated by `isAxis`, it is
      // what the axis filter queries, and it is what axis-weight feedback aggregates. Writing a
      // free-text name there would (a) make `isAxis` reject the row on the next engine write, and
      // (b) feed user-typed names into engine feedback as if they were detected axes — while
      // destroying the "manual clip = ABSENCE of axis" invariant that the whole manual-clip design
      // rests on. A name is a different fact and gets its own column.
      //
      // Null means "not named", which is the honest state for an engine-found clip: it has an axis
      // to be identified by, and forcing a title onto it would invent a label nobody chose. An
      // empty string is never stored — the use case refuses a blank name rather than writing the
      // absence twice in two spellings.
      `ALTER TABLE clips ADD COLUMN title TEXT`,


      // ── The export LIST ──────────────────────────────────────────────────────────────────────
      //
      // Clips are already persistent and independent of exporting — that is the point of this
      // table. It holds REFERENCES to clips, never copies: a clip's boundaries, name and axis live
      // in `clips` and a duplicate here would be a second owner of the same truth, drifting the
      // moment either side is edited.
      //
      // No `FOREIGN KEY`: none is declared anywhere in this schema (see the 0.6.0 rebuild), and
      // adding one only here would make this table's delete semantics differ from every other.
      //
      // `removed_at` rather than a row DELETE: taking a clip off the export list must not erase the
      // fact that it was once on it, and the history is what lets a re-add keep its original
      // position instead of jumping the queue.
      `CREATE TABLE IF NOT EXISTS export_list (
        clip_id TEXT PRIMARY KEY,
        added_at TEXT NOT NULL,
        position INTEGER NOT NULL,
        removed_at TEXT
      )`,

      // ── The export BATCH ─────────────────────────────────────────────────────────────────────
      //
      // DURABLE, and that is a requirement rather than a preference: a batch interrupted by a
      // restart must resume rather than silently vanish, because the user asked for those files and
      // a half-finished batch that reports "done" is a lie about their deliverables.
      //
      // `clip_id` is the primary key, not a surrogate id: one clip has at most one pending export.
      // Enqueueing the same clip twice would produce two files competing for one filename, and the
      // second would either clobber the first or fail on it — so the schema makes that state
      // unrepresentable instead of relying on the queue to avoid it.
      //
      // `artifact_path` is where THIS attempt writes. It exists so a cancel can delete exactly the
      // partial file it produced: deriving the path from the clip and its profile at cancel time
      // would be a second implementation of the naming rule, and a cancel that deletes the wrong
      // file is worse than one that leaves a fragment.
      `CREATE TABLE IF NOT EXISTS export_jobs (
        clip_id TEXT PRIMARY KEY,
        status TEXT NOT NULL DEFAULT 'queued',
        position INTEGER NOT NULL,
        profile_json TEXT NOT NULL,
        output_dir TEXT,
        filename TEXT,
        artifact_path TEXT,
        phase TEXT,
        percent REAL NOT NULL DEFAULT 0,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        error TEXT
      )`,

      `CREATE INDEX IF NOT EXISTS idx_export_jobs_status ON export_jobs(status, position)`,
      `CREATE INDEX IF NOT EXISTS idx_export_list_position ON export_list(removed_at, position)`,


      // ── WHY A COLUMN AND NOT A LIST IN THE UI ──────────────────────────────────────────────
      //
      // Deletability was hardcoded in the frontend as a Set of seeded ids
      // (`DEFAULT_PRESET_IDS = new Set(['preset-tiktok-916', ...])`). That is the wrong owner for a
      // property of a ROW: the set has to be edited in step with `DEFAULT_PRESETS`, and the server —
      // which owns the data and can be called by anything — would happily delete a seeded preset and
      // leave the UI's assumption behind. Making it a column means ONE owner, and the server can
      // refuse the delete by name instead of trusting the client to not ask.
      //
      // The default covers EVERY existing row, and that is the load-bearing part: a preset already in
      // someone's database was, at the time it was written, a preset the app shipped, because user
      // presets did not exist before this version. So `'seeded'` is the correct backfill rather than a
      // convenient one — and it fails safe, since a preset wrongly marked seeded is merely
      // undeletable, while one wrongly marked user would be deletable when it should not be.
      `ALTER TABLE export_presets ADD COLUMN origin TEXT NOT NULL DEFAULT 'seeded'`,
      // The server's delete refusal is a lookup on this column.
      `CREATE INDEX IF NOT EXISTS idx_export_presets_origin ON export_presets(origin)`,


      // ── WHY THIS IS A DATA MIGRATION AND NOT JUST A CODE CHANGE ────────────────────────────
      //
      // The seeded presets baked a literal `-tiktok` / `-shorts` into their `nameTemplate`. That text
      // was never derived from anything — there is no platform concept in the app — but it WAS written
      // into every database that has ever run this version, so removing it from `DEFAULT_PRESETS`
      // alone would only fix a fresh install and leave the person who reported it staring at the same
      // `-tiktok` in their own presets.
      //
      // The suffix is stripped ONLY from a preset whose id AND template are EXACTLY the shipped pair.
      //
      // The template match is the load-bearing guard, and it is what protects a user's own text: a
      // preset whose template differs from the shipped literal is one they have customised, and
      // sweeping every template that merely CONTAINS the word would rewrite a name they chose. The
      // ID match keeps the statement aimed at the two presets it is about rather than at the whole
      // table.
      //
      // There is deliberately NO `origin = 'seeded'` condition. It was written when this was its own
      // migration, where only previously-existing presets had been backfilled. Merged into 0.6.0 it
      // became INERT — the origin backfill earlier in this same migration sets every pre-existing row
      // to `seeded`, and no `user` row can exist yet — so it would read as protection while excluding
      // nothing. A guard that cannot fire is worse than no guard.
      `UPDATE export_presets
          SET config_json = json_set(config_json, '$.nameTemplate', '{date}-{channel}-{axis}-{ts}')
        WHERE id = 'preset-tiktok-916'
          AND json_extract(config_json, '$.nameTemplate') = '{date}-{channel}-{axis}-{ts}-tiktok'`,

      `UPDATE export_presets
          SET config_json = json_set(config_json, '$.nameTemplate', '{date}-{channel}-{axis}-{ts}')
        WHERE id = 'preset-shorts-916-vp9'
          AND json_extract(config_json, '$.nameTemplate') = '{date}-{channel}-{axis}-{ts}-shorts'`,
    ],
  },
  {
    /**
     * Preset names, the Landscape default, and the `{axis}` → `{name}` token change — for
     * INSTALLED databases.
     *
     * Every effect here is DATA in `export_presets.config_json` (and `clips.title`), which is why a
     * code change alone cannot deliver any of it: seeding is guarded by `existingPresets.length === 0`,
     * so an existing install never re-seeds.
     */
    version: "0.7.0",
    description: "Landscape preset above Portrait, {name} filename token, engine clips named by axis",
    up: [
      // ── 1. THE RENAME, AND WHY THE ID DOES NOT MOVE ────────────────────────────────────────────
      // The row was named for a platform; it is now named for its aspect ratio, which is the fact the
      // profile actually encodes. The ID stays `preset-tiktok-916`: it is not user-visible, and
      // changing it would break the delete-refusal lookup (`DEFAULT_PRESET_IDS`), the 0.6.0 template
      // statement above, and any user row that had a foreign thought about it. A rename is not an
      // identity change.
      //
      // Guarded on the OLD exact name: a user who renamed this preset themselves keeps their name,
      // because their row no longer matches and the statement simply does not fire.
      `UPDATE export_presets
          SET name = 'Portrait 9:16 H.264'
        WHERE id = 'preset-tiktok-916'
          AND name = 'TikTok 9:16 H.264'`,

      // ── 2. THE LANDSCAPE PRESET, inserted ABOVE the others ────────────────────────────────────
      // Ordering is `created_at` ASC, so "above" means an EARLIER timestamp than any existing row.
      // `INSERT OR IGNORE`, not a bare INSERT: the id is the primary key, so a re-run (or a database
      // that somehow already has it) must not throw. The 0.6.0 preset rows all carry
      // `2026-01-01T00:00:0{0,1,2}Z`, and this takes `2025-12-31T23:59:59Z` — the day before, which
      // is unambiguous rather than depending on how many rows happen to exist.
      //
      // A 16:9 profile with NO crop: the source is almost always 16:9, so this is the only shipped
      // preset that leaves the frame alone. Encoder `auto` and a full-profile body, matching what
      // `normaliseProfile` would produce, so the row is readable by the same path as every other.
      `INSERT OR IGNORE INTO export_presets (id, name, config_json, created_at, origin)
        VALUES (
          'preset-landscape-169',
          'Landscape 16:9 H.264',
          json('{"container":"mp4","videoCodec":"h264","audioCodec":"aac","encoder":"auto","encoderName":null,"maxHeight":1920,"options":{"quality":23,"maxBitrateKbps":null},"aspectRatio":"16:9","captions":{"enabled":false,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{name}-{ts}"}'),
          '2025-12-31T23:59:59Z',
          'seeded'
        )`,

      // ── 3. `{axis}` → `{name}` IN EVERY STORED TEMPLATE ───────────────────────────────────────
      // Not scoped to the three shipped ids, and deliberately so: the token was removed from the
      // VOCABULARY, so a template still containing it renders the literal text `{axis}` into a
      // filename. A user who edited their own template keeps their own text but not a dead token —
      // that is a REPAIR of a broken template, not a rewrite of a name somebody chose.
      //
      // The `LIKE '%{axis}%'` predicate is LOAD-BEARING, and for a reason that is not obvious: on a
      // row whose config_json has no `nameTemplate` at all, `json_extract` returns SQL NULL and
      // `json_set` then writes an EXPLICIT `"nameTemplate": null` into it — turning an absent key into
      // a present-but-null one. Measured. `replace(NULL, …)` is a harmless no-op; the `json_set` is
      // not. So the predicate protects schema-shaped rows, not just tidy ones.
      `UPDATE export_presets
          SET config_json = json_set(
            config_json,
            '$.nameTemplate',
            replace(json_extract(config_json, '$.nameTemplate'), '{axis}', '{name}')
          )
        WHERE json_extract(config_json, '$.nameTemplate') LIKE '%{axis}%'`,

      // ── 4. ENGINE CLIPS GET THEIR AXIS AS A NAME ──────────────────────────────────────────────
      // The owner's rule: the axis was "the right idea with the wrong applicability to user
      // creatable clips". A detected clip DOES have an axis, so the engine now writes it into
      // `title` at creation — and this backfills the clips that were detected before that change,
      // which would otherwise fall out of every `{name}` template as an empty segment.
      //
      // `title IS NULL` is the LOAD-BEARING guard: it is what stops a name the user typed from being
      // overwritten with the axis. Removing it renames every detected clip the user had edited — the
      // falsification test in manual-clips.test.ts is the one that catches that.
      //
      // `axis IS NOT NULL` is INTENT, NOT MECHANISM — do not mistake it for a guard. `SET title = axis`
      // with `axis` NULL assigns NULL to a NULL title, a no-op, so a hand-made clip stays unnamed even
      // with this condition deleted (measured: the suite stays green). It is written out because it
      // states the rule the statement is meant to express, and it keeps the predicate honest if the
      // assignment ever changes to something where NULL would matter. A test asserting "a hand-made
      // clip stays unnamed" therefore does NOT pin this clause, and should not be read as doing so.
      `UPDATE clips
          SET title = axis
        WHERE title IS NULL
          AND axis IS NOT NULL`,
    ],
  },
  {
    version: "0.8.0",
    description: "Captions off on the shipped presets, plus the MKV/FLAC archive preset",
    up: [
      // ── 1. CAPTIONS OFF, BUT ONLY WHERE THE USER NEVER TOUCHED THEM ───────────────────────────
      // Two shipped presets enabled captions; a preset must not turn a burn-in on for the user, since
      // captions change the PICTURE of every export made from it.
      //
      // The predicate matches the ENTIRE shipped captions block, not just `enabled`, and that is the
      // whole safety of this statement. `origin` cannot distinguish a preset the owner enabled
      // captions on from an untouched one: editing a seeded preset leaves `origin = 'seeded'`
      // (measured — `save()` deliberately does not update origin). So the guard is the shipped VALUE:
      // a block differing in ANY field — enabled, fontSize, position, opacity, style — was edited by
      // somebody, and their choice is not this migration's to reverse. Note this also means a user
      // who turned captions OFF themselves is already a no-op here.
      //
      // `json_extract` on each field rather than a JSON string match, because key order in a stored
      // `config_json` is not guaranteed and a substring match would depend on it.
      `UPDATE export_presets
          SET config_json = json_set(config_json, '$.captions.enabled', json('false'))
        WHERE json_extract(config_json, '$.captions.enabled') = 1
          AND json_extract(config_json, '$.captions.preset') = 'bold-white'
          AND json_extract(config_json, '$.captions.position') = 'bottom'
          AND json_extract(config_json, '$.captions.fontSize') = 48
          AND json_extract(config_json, '$.captions.backgroundOpacity') = 0.8`,

      // ── 2. THE MKV ARCHIVE PRESET ────────────────────────────────────────────────────────────
      // Last in the list: ordering is `created_at` ASC, so the newest stamp puts it after every
      // shipped row. `INSERT OR IGNORE` because the id is the primary key and a re-run must not throw.
      // FLAC, which is why `audioArgs` omits `-b:a` for it — a lossless codec has no bitrate.
      `INSERT OR IGNORE INTO export_presets (id, name, config_json, created_at, origin)
        VALUES (
          'preset-archive-mkv',
          'Archive 16:9 MKV FLAC',
          json('{"container":"mkv","videoCodec":"h264","audioCodec":"flac","encoder":"auto","encoderName":null,"maxHeight":null,"options":{"quality":23,"maxBitrateKbps":null},"aspectRatio":"16:9","captions":{"enabled":false,"preset":"bold-white","position":"bottom","fontSize":48,"backgroundOpacity":0.8},"nameTemplate":"{date}-{channel}-{name}-{ts}"}'),
          '2026-01-01T00:00:04Z',
          'seeded'
        )`,
    ],
  },
  {
    version: "0.9.0",
    description: "Drop the two Archive presets from the shipped set",
    up: [
      // ── THE ARCHIVE PRESETS ARE GONE ─────────────────────────────────────────────────────────
      // `16:9 Archive H.264` duplicated Landscape with an explicit software encoder, which is not a
      // choice worth a preset; `Archive 16:9 MKV FLAC` was added one migration ago and earned its
      // removal for the same reason — an MKV/FLAC archive preset is not something anyone reaches for.
      // MKV H.264 remains one of the five FORMATS, so nothing is lost here.
      //
      // DELETED, not hidden, and only where the user never renamed them. The predicate is
      // `origin = 'seeded'` AND the shipped NAME. `origin` alone is not enough — editing a seeded
      // preset leaves it `seeded` (measured) — so the NAME is the load-bearing part of the guard: a
      // row the user renamed keeps its own name and survives, while an untouched shipped row still
      // carries the name it was published with. A user who kept either preset and edited its display
      // name retains it; a user who never touched them loses two rows that only added noise.
      //
      // NOT keyed on `$.container`, which is where the first version of this statement was wrong: a
      // row that upgraded from 0.5.0 carries the LEGACY `$.format` string (`"mp4_h264"`), not
      // `$.container`, because 0.5.0's seeder wrote the old flat shape and only later migrations
      // rewrite templates. A `$.container` predicate therefore matched NOTHING and the delete was a
      // silent no-op on exactly the users it existed for (measured on the published-user fixture).
      `DELETE FROM export_presets
        WHERE origin = 'seeded'
          AND (
            (id = 'preset-archive-169' AND name = '16:9 Archive H.264')
            OR
            (id = 'preset-archive-mkv' AND name = 'Archive 16:9 MKV FLAC')
          )`,
    ],
  },
];

export const LATEST_VERSION = migrations.at(-1)?.version ?? "0.0.0";

/**
 * Runs all pending migrations in a single transaction.
 * Safe to call on every startup — skips already-applied migrations.
 * Records each migration in the `schema_versions` table.
 */
export function runMigrations(db: DatabaseSync): { from: string; to: string; applied: number } {
  // Tracking table — created first, before any other migration.
  db.exec(`CREATE TABLE IF NOT EXISTS schema_versions (
    version TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_versions").all().map((r) => r.version as string),
  );

  let count = 0;
  let firstNew = "";
  let lastNew = "";

  for (const migration of migrations) {
    if (applied.has(migration.version)) continue;

    if (!firstNew) firstNew = migration.version;
    lastNew = migration.version;

    db.exec("BEGIN");
    try {
      for (const stmt of migration.up) {
        db.exec(stmt);
      }
      db.prepare("INSERT INTO schema_versions (version, description, applied_at) VALUES (?, ?, ?)")
        .run(migration.version, migration.description, new Date().toISOString());
      db.exec("COMMIT");
      count++;
    } catch (err) {
      db.exec("ROLLBACK");
      throw new Error(
        `Migration ${migration.version} (${migration.description}) failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  return { from: firstNew || LATEST_VERSION, to: lastNew || LATEST_VERSION, applied: count };
}
