import { sqliteTable, text, real, integer } from "drizzle-orm/sqlite-core";

/** Drizzle schema mirrors the domain shapes. JSON columns store nested objects. */
export const streams = sqliteTable("streams", {
  id: text("id").primaryKey(),
  vod_path: text("vod_path").notNull(),
  chat_path: text("chat_path"),
  source_url: text("source_url"),
  title: text("title"),
  streamer: text("streamer"),
  game: text("game"),
  duration: real("duration"),
  created_at: text("created_at").notNull(),
  status: text("status").notNull().default("pending"),
  /** The project's folder, as recorded. NULL = not recorded yet (pre-0.5.0 rows). */
  project_dir: text("project_dir"),
});

export const jobs = sqliteTable("jobs", {
  id: text("id").primaryKey(),
  stream_id: text("stream_id").notNull(),
  status: text("status").notNull().default("queued"),
  position: integer("position").notNull(),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  error: text("error"),
  config_json: text("config_json").notNull().default("{}"),
});

export const clips = sqliteTable("clips", {
  id: text("id").primaryKey(),
  job_id: text("job_id").notNull(),
  stream_id: text("stream_id").notNull(),
  axis: text("axis").notNull(),
  score: real("score").notNull(),
  start_time: real("start_time").notNull(),
  end_time: real("end_time").notNull(),
  peak_time: real("peak_time").notNull(),
  justification: text("justification"),
  rank: integer("rank"),
  exported: integer("exported").notNull().default(0),
  export_path: text("export_path"),
  rejected: integer("rejected").notNull().default(0),
  signals_json: text("signals_json"), // JSON ClipSignals, null = no signal data
});

export const personas = sqliteTable("personas", {
  id: text("id").primaryKey(),
  state_json: text("state_json").notNull(),
  updated_at: text("updated_at").notNull(),
  stream_count: integer("stream_count").notNull().default(0),
});

export const streamMetadata = sqliteTable("stream_metadata", {
  stream_id: text("stream_id").notNull(),
  key: text("key").notNull(),
  value: text("value").notNull(),
  created_at: text("created_at").notNull(),
  updated_at: text("updated_at").notNull(),
});

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value").notNull(),
});

/** Export presets (P0-7): named format/aspect/caption bundles, user-editable. */
export const exportPresets = sqliteTable("export_presets", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  config_json: text("config_json").notNull(),
  created_at: text("created_at").notNull(),
});
