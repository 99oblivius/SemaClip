import { drizzle, type SqliteRemoteDatabase } from "drizzle-orm/sqlite-proxy";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import * as schema from "./schema.ts";

export type Db = SqliteRemoteDatabase<typeof schema>;

type Row = Record<string, unknown>;
type BatchRemoteCallback = (queries: { sql: string; params: unknown[] }[]) => Promise<{ rows: unknown[][] }[]>;
type RemoteCallback = (sql: string, params: unknown[]) => Promise<{ rows: unknown[][] }>;

const DDL = [
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
];

/**
 * Bridges node:sqlite (Deno-compatible) to Drizzle's sqlite-proxy driver.
 * sqlite-proxy's mapResultRow expects positional arrays, so we convert
 * node:sqlite's keyed objects into arrays using the statement's column names.
 */
export function createDb(dbPath: string): Db {
  const sqlite = new DatabaseSync(dbPath);
  sqlite.exec("PRAGMA journal_mode = WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");

  for (const ddl of DDL) sqlite.exec(ddl);

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
