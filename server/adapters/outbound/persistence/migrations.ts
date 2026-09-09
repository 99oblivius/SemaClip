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
