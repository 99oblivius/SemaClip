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
export function createDb(dbPath: string): Db {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  const result = runMigrations(sqlite);
  if (result.applied > 0) {
    console.log(`Migrations: ${result.applied} applied (${result.from} → ${result.to})`);
  }

  function queryAsArrays(sql: string, params: unknown[]): { rows: unknown[][] } {
    const stmt = sqlite.prepare(sql);
    const cols = stmt.columns() as { name: string }[];
    const columnNames = cols.map((c) => c.name);
    const keyedRows = stmt.all(...params as SQLInputValue[]) as Row[];
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
