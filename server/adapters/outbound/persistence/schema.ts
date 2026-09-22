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
  /** Nullable: a MANUAL clip has no job — no engine ran, so there is nothing to reference. */
  job_id: text("job_id"),
  stream_id: text("stream_id").notNull(),
  /** Nullable: a manual clip carries no engine axis (NULL = no axis, never a sentinel one). */
  axis: text("axis"),
  /** Nullable: a manual clip is not ranked (NULL = unranked, never a fake 0). */
  score: real("score"),
  start_time: real("start_time").notNull(),
  end_time: real("end_time").notNull(),
  peak_time: real("peak_time").notNull(),
  justification: text("justification"),
  rank: integer("rank"),
  exported: integer("exported").notNull().default(0),
  export_path: text("export_path"),
  rejected: integer("rejected").notNull().default(0),
  signals_json: text("signals_json"), // JSON ClipSignals, null = no signal data
  /** The user's own name for the clip. Null = not named (never ""). NOT the axis: a name is
   *  free text and an axis is an engine enum — one column cannot honestly hold both. */
  title: text("title"),
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
  /**
   * Who the preset belongs to: `seeded` (the app shipped it) or `user` (someone saved it).
   *
   * A DATA property rather than a hardcoded id list in the frontend, because deletability is a fact
   * about the row and the server is the only place that can enforce it. The default is `seeded`,
   * which mirrors the migration's backfill: every preset written before this column existed was one
   * the app shipped.
   */
  origin: text("origin").notNull().default("seeded"),
});

/**
 * The export LIST — durable REFERENCES to clips, never copies.
 *
 * A clip is a persistent entity in its own right (`clips`), independent of whether anyone ever
 * exports it. This table is the answer to "which clips does the user intend to export", and it
 * stores only that intent: no boundaries, no name, no axis. Duplicating any of those here would make
 * two owners of one truth that drift the instant a clip is trimmed or renamed on the Review page.
 *
 * `removed_at` instead of DELETE-ing the row, so taking a clip off the list is a reversible intent
 * rather than a lost fact — and so a re-add can keep its original place in the order.
 */
export const exportList = sqliteTable("export_list", {
  clip_id: text("clip_id").primaryKey(),
  added_at: text("added_at").notNull(),
  position: integer("position").notNull(),
  removed_at: text("removed_at"),
});

/**
 * The export BATCH — durable, because a batch must survive a restart and resume.
 *
 * `clip_id` is the primary key by design: one clip has at most ONE pending export. Two rows for one
 * clip would race for the same output filename, and the schema refusing that beats the queue
 * remembering to check.
 *
 * `artifact_path` records where THIS attempt writes, so cancelling can delete precisely the partial
 * file it produced instead of re-deriving a filename from the naming rule and risking deleting the
 * wrong thing.
 */
export const exportJobs = sqliteTable("export_jobs", {
  clip_id: text("clip_id").primaryKey(),
  status: text("status").notNull().default("queued"),
  position: integer("position").notNull(),
  profile_json: text("profile_json").notNull(),
  output_dir: text("output_dir"),
  filename: text("filename"),
  artifact_path: text("artifact_path"),
  phase: text("phase"),
  percent: real("percent").notNull().default(0),
  requested_at: text("requested_at").notNull(),
  started_at: text("started_at"),
  completed_at: text("completed_at"),
  error: text("error"),
});
