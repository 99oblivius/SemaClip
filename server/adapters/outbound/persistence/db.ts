import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as schema from "./schema.ts";
import { runMigrations } from "./migrations.ts";

export type Db = SqliteRemoteDatabase<typeof schema>;

type Row = Record<string, unknown>;
type BatchRemoteCallback = (queries: { sql: string; params: unknown[] }[]) => Promise<{ rows: unknown[][] }[]>;
type RemoteCallback = (sql: string, params: unknown[]) => Promise<{ rows: unknown[][] }>;

/**
 * Creates the Drizzle database wrapper.
 * Migrations run on the raw `node:sqlite` connection before Drizzle is wired,
 * so the schema is guaranteed current before any query executes.
 */

/** node:sqlite under concurrent writers can throw transient "disk I/O error"
 *  (SQLITE_BUSY/IOERR) — a short bounded retry keeps progress writes alive. */
function withRetry<T>(fn: () => T, attempts = 4): T {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return fn();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!/disk I\/O error|database is locked|SQLITE_BUSY/i.test(msg)) throw err;
      lastErr = err;
      // Synchronous spin — the drizzle callback chain is sync anyway (≤200ms).
      const until = performance.now() + 50 * (i + 1);
      while (performance.now() < until) {
        // spin
      }
    }
  }
  throw lastErr;
}

export function createDb(dbPath: string): Db {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  // Progress writes fire at ~1 Hz from several code paths; without a busy
  // timeout a concurrent write surfaces as "disk I/O error" (SQLITE_BUSY).
  sqlite.exec("PRAGMA busy_timeout = 5000");
  // WAL's default FULL sync on tmpfs hiccups under concurrent writers.
  sqlite.exec("PRAGMA synchronous = NORMAL");

  const result = runMigrations(sqlite);
  if (result.applied > 0) {
    console.log(`Migrations: ${result.applied} applied (${result.from} → ${result.to})`);
  }

  function queryAsArrays(sql: string, params: unknown[]): { rows: unknown[][] } {
    const stmt = withRetry(() => sqlite.prepare(sql));
    const cols = stmt.columns() as { name: string }[];
    const columnNames = cols.map((c) => c.name);
    const keyedRows = withRetry(() => stmt.all(...params as SQLInputValue[])) as Row[];
    if (columnNames.length === 0) return { rows: [] };
    const rows = keyedRows.map((row) => columnNames.map((col) => row[col] ?? null));
    return { rows };
  }

  const callback: RemoteCallback = (sql, params) => Promise.resolve(queryAsArrays(sql, params));

  const batchCallback: BatchRemoteCallback = (queries) =>
    Promise.resolve(queries.map((q) => queryAsArrays(q.sql, q.params)));

  return drizzle(callback, batchCallback, { schema });
}

export { schema };
