import { eq, and, asc, desc } from "drizzle-orm";
import type { Db } from "./db.ts";
import { schema } from "./db.ts";
import { normaliseProfile } from "shared/types";
import type {
  StreamRepository,
  JobRepository,
  ClipRepository,
  PersonaRepository,
  StreamMetadataRepository,
  ExportListRepository,
  ExportListRow,
  ExportJobRepository,
  ExportJobRecord,
} from "@/application/ports/outbound.ts";
import type { Stream, Job, Clip, Persona, StreamStatus, Axis, ExportPreset, ExportProfile } from "shared/types";

// ── Row → domain mappers ──────────────────────────────────────
// SQLite stores JSON as text; booleans as 0/1.

function rowToStream(r: typeof schema.streams.$inferSelect): Stream {
  return {
    id: r.id,
    vodPath: r.vod_path,
    chatPath: r.chat_path,
    sourceUrl: r.source_url,
    title: r.title,
    streamer: r.streamer,
    game: r.game,
    duration: r.duration,
    createdAt: r.created_at,
    status: r.status as Stream["status"],
    projectDir: r.project_dir ?? null,
  };
}

function rowToJob(r: typeof schema.jobs.$inferSelect): Job {
  return {
    id: r.id,
    streamId: r.stream_id,
    status: r.status as Job["status"],
    position: r.position,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    error: r.error,
    config: JSON.parse(r.config_json) as Job["config"],
  };
}

function rowToClip(r: typeof schema.clips.$inferSelect): Clip {
  return {
    id: r.id,
    // Null for a manual clip — the absence of a job IS the fact that it was made by hand.
    jobId: r.job_id,
    streamId: r.stream_id,
    // Null for a manual clip: no engine axis, no score, no signals. Never coerced to a
    // default, because a fabricated axis/score would present a hand-cut clip as an engine
    // finding (and "0.00" as a bad one).
    axis: r.axis as Axis | null,
    score: r.score,
    startTime: r.start_time,
    endTime: r.end_time,
    peakTime: r.peak_time,
    justification: r.justification,
    // Not named yet — the honest state, and the one an engine-found clip keeps: it is identified
    // by its axis, and inventing a title would be a label nobody chose.
    title: r.title,
    rank: r.rank,
    exported: r.exported === 1,
    exportPath: r.export_path,
    rejected: r.rejected === 1,
    signals: r.signals_json ? (JSON.parse(r.signals_json) as Clip["signals"]) : null,
  };
}

function rowToPersona(r: typeof schema.personas.$inferSelect): Persona {
  return {
    id: r.id,
    state: JSON.parse(r.state_json),
    updatedAt: r.updated_at,
    streamCount: r.stream_count,
  };
}

// ── Stream repository ──────────────────────────────────────────

export class SqliteStreamRepository implements StreamRepository {
  constructor(private readonly db: Db) {}

  async save(stream: Stream): Promise<void> {
    await this.db.insert(schema.streams).values({
      id: stream.id,
      vod_path: stream.vodPath,
      chat_path: stream.chatPath,
      source_url: stream.sourceUrl,
      title: stream.title,
      streamer: stream.streamer,
      game: stream.game,
      duration: stream.duration,
      created_at: stream.createdAt,
      status: stream.status,
      project_dir: stream.projectDir ?? null,
    }).run();
  }

  async findById(id: string): Promise<Stream | null> {
    const rows = await this.db.select().from(schema.streams).where(eq(schema.streams.id, id)).limit(1).all();
    return rows[0] ? rowToStream(rows[0]) : null;
  }

  async list(status?: StreamStatus): Promise<Stream[]> {
    // NEWEST FIRST. The Library lists projects under a "Recent" heading, so the most
    // recently created project belongs at the top; ascending order put the newest at the
    // bottom of the list. `created_at` is a fixed-width ISO-8601 UTC string, so a lexical
    // ORDER BY is a chronological one — no cast, and no chance of a timezone-dependent sort.
    const q = status
      ? this.db.select().from(schema.streams).where(eq(schema.streams.status, status)).orderBy(desc(schema.streams.created_at))
      : this.db.select().from(schema.streams).orderBy(desc(schema.streams.created_at));
    return (await q.all()).map(rowToStream);
  }

  async update(stream: Stream): Promise<void> {
    await this.db.update(schema.streams).set({
      vod_path: stream.vodPath,
      chat_path: stream.chatPath,
      source_url: stream.sourceUrl,
      title: stream.title,
      streamer: stream.streamer,
      game: stream.game,
      duration: stream.duration,
      status: stream.status,
      project_dir: stream.projectDir ?? null,
    }).where(eq(schema.streams.id, stream.id)).run();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.streams).where(eq(schema.streams.id, id)).run();
  }
}

// ── Job repository ──────────────────────────────────────────────

export class SqliteJobRepository implements JobRepository {
  constructor(private readonly db: Db) {}

  async save(job: Job): Promise<void> {
    await this.db.insert(schema.jobs).values({
      id: job.id,
      stream_id: job.streamId,
      status: job.status,
      position: job.position,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      error: job.error,
      config_json: JSON.stringify(job.config),
    }).run();
  }

  async findById(id: string): Promise<Job | null> {
    const rows = await this.db.select().from(schema.jobs).where(eq(schema.jobs.id, id)).limit(1).all();
    return rows[0] ? rowToJob(rows[0]) : null;
  }

  async listByStream(streamId: string): Promise<Job[]> {
    const rows = await this.db.select().from(schema.jobs)
      .where(eq(schema.jobs.stream_id, streamId))
      .orderBy(asc(schema.jobs.position)).all();
    return rows.map(rowToJob);
  }

  async listQueued(): Promise<Job[]> {
    const rows = await this.db.select().from(schema.jobs)
      .where(eq(schema.jobs.status, "queued"))
      .orderBy(asc(schema.jobs.position)).all();
    return rows.map(rowToJob);
  }

  async listRunning(): Promise<Job[]> {
    const rows = await this.db.select().from(schema.jobs)
      .where(eq(schema.jobs.status, "running")).all();
    return rows.map(rowToJob);
  }

  async update(job: Job): Promise<void> {
    await this.db.update(schema.jobs).set({
      status: job.status,
      position: job.position,
      started_at: job.startedAt,
      completed_at: job.completedAt,
      error: job.error,
      config_json: JSON.stringify(job.config),
    }).where(eq(schema.jobs.id, job.id)).run();
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.jobs).where(eq(schema.jobs.id, id)).run();
  }
}

// ── Clip repository ─────────────────────────────────────────────

export class SqliteClipRepository implements ClipRepository {
  constructor(private readonly db: Db) {}

  async save(clip: Clip): Promise<void> {
    await this.db.insert(schema.clips).values({
      id: clip.id,
      job_id: clip.jobId,
      stream_id: clip.streamId,
      axis: clip.axis,
      score: clip.score,
      start_time: clip.startTime,
      end_time: clip.endTime,
      peak_time: clip.peakTime,
      justification: clip.justification,
      title: clip.title,
      rank: clip.rank,
      exported: clip.exported ? 1 : 0,
      export_path: clip.exportPath,
      rejected: clip.rejected ? 1 : 0,
      signals_json: clip.signals ? JSON.stringify(clip.signals) : null,
    }).run();
  }

  async findById(id: string): Promise<Clip | null> {
    const rows = await this.db.select().from(schema.clips).where(eq(schema.clips.id, id)).limit(1).all();
    return rows[0] ? rowToClip(rows[0]) : null;
  }

  async listByStream(streamId: string, filter?: { axis?: Axis; rejected?: boolean }): Promise<Clip[]> {
    const conditions = [eq(schema.clips.stream_id, streamId)];
    if (filter?.axis) conditions.push(eq(schema.clips.axis, filter.axis));
    if (filter?.rejected !== undefined) {
      conditions.push(eq(schema.clips.rejected, filter.rejected ? 1 : 0));
    }
    const rows = await this.db.select().from(schema.clips)
      .where(and(...conditions))
      .orderBy(asc(schema.clips.rank)).all();
    return rows.map(rowToClip);
  }

  async update(clip: Clip): Promise<Clip> {
    await this.db.update(schema.clips).set({
      score: clip.score,
      start_time: clip.startTime,
      end_time: clip.endTime,
      peak_time: clip.peakTime,
      justification: clip.justification,
      title: clip.title,
      rank: clip.rank,
      exported: clip.exported ? 1 : 0,
      export_path: clip.exportPath,
      rejected: clip.rejected ? 1 : 0,
      signals_json: clip.signals ? JSON.stringify(clip.signals) : null,
    }).where(eq(schema.clips.id, clip.id)).run();
    return clip;
  }
}

// ── Persona repository ──────────────────────────────────────────

export class SqlitePersonaRepository implements PersonaRepository {
  constructor(private readonly db: Db) {}

  async findById(id: string): Promise<Persona | null> {
    const rows = await this.db.select().from(schema.personas)
      .where(eq(schema.personas.id, id)).limit(1).all();
    return rows[0] ? rowToPersona(rows[0]) : null;
  }

  async save(persona: Persona): Promise<void> {
    await this.db.insert(schema.personas).values({
      id: persona.id,
      state_json: JSON.stringify(persona.state),
      updated_at: persona.updatedAt,
      stream_count: persona.streamCount,
    }).onConflictDoUpdate({
      target: schema.personas.id,
      set: {
        state_json: JSON.stringify(persona.state),
        updated_at: persona.updatedAt,
        stream_count: persona.streamCount,
      },
    }).run();
  }
}

// ── Stream metadata repository ─────────────────────────────────

export class SqliteStreamMetadataRepository implements StreamMetadataRepository {
  constructor(private readonly db: Db) {}

  async get(streamId: string, key: string): Promise<string | null> {
    const rows = await this.db.select().from(schema.streamMetadata)
      .where(and(
        eq(schema.streamMetadata.stream_id, streamId),
        eq(schema.streamMetadata.key, key),
      )).limit(1).all();
    return rows[0]?.value ?? null;
  }

  async set(streamId: string, key: string, value: string): Promise<void> {
    const now = new Date().toISOString();
    await this.db.insert(schema.streamMetadata).values({
      stream_id: streamId,
      key,
      value,
      created_at: now,
      updated_at: now,
    }).onConflictDoUpdate({
      target: [schema.streamMetadata.stream_id, schema.streamMetadata.key],
      set: { value, updated_at: now },
    }).run();
  }

  async delete(streamId: string, key: string): Promise<void> {
    await this.db.delete(schema.streamMetadata)
      .where(and(
        eq(schema.streamMetadata.stream_id, streamId),
        eq(schema.streamMetadata.key, key),
      )).run();
  }

  async deleteAll(streamId: string): Promise<void> {
    await this.db.delete(schema.streamMetadata)
      .where(eq(schema.streamMetadata.stream_id, streamId)).run();
  }
}

// ── Export preset repository (P0-7) ────────────────────────────

export class SqliteExportPresetRepository {
  constructor(private readonly db: Db) {}

  async list(): Promise<ExportPreset[]> {
    const rows = await this.db.select().from(schema.exportPresets)
      .orderBy(asc(schema.exportPresets.created_at)).all();
    return rows.map((r) => {
      const cfg = JSON.parse(r.config_json) as Record<string, unknown>;
      // ── NORMALISED ON READ, and that is not belt-and-braces ────────────────────────────────
      // `config_json` is the profile, and it has TWO shapes in the wild. Presets written before the
      // full profile existed carry the legacy FLAT subset (`format`, `aspectRatio`, `cropPosition`,
      // `captions`, `nameTemplate`); presets written since carry the profile itself, nested under
      // `profile`. Spreading the blob verbatim — which this did — handed the legacy rows straight to
      // the client with NO `profile` field at all, so every consumer reading `preset.profile.x` threw.
      // A thrown expression inside a `$derived` aborts the render rather than rendering an error, so
      // the export page showed "Loading presets…" for ever with no preset in the list and no
      // complaint anywhere: the query had succeeded and the DATA was the problem.
      //
      // Normalising here (rather than migrating the blob) is deliberate: `normaliseProfile` already
      // understands the legacy shape, it degrades any unreadable field to a safe default instead of
      // failing, and it therefore also repairs hand-edited rows. A migration rewriting JSON in place
      // would have to be equally tolerant to be safe, and would still leave any row it could not
      // parse broken — this is idempotent by construction.
      const { origin: _fromBlob, profile: nested, ...flat } = cfg;
      const raw = nested && typeof nested === "object" ? nested : flat;
      return {
        id: r.id,
        name: r.name,
        // A preset IS a profile, so what comes out is always the full profile — every field filled,
        // the quality clamped to the codec's useful band, an unencodable pair degraded. Same policy as
        // the write path, because a read must never hand out a shape the writer would not accept.
        profile: normaliseProfile(raw as Partial<ExportProfile>),
        createdAt: r.created_at,
        // The column is authoritative; anything unreadable is treated as `seeded`, which is the safe
        // direction — an undeletable preset is a nuisance, a wrongly deletable one is data loss.
        origin: r.origin === "user" ? "user" : "seeded",
      };
    });
  }

  async save(preset: ExportPreset): Promise<void> {
    const { id, name, createdAt, origin, ...cfg } = preset;
    await this.db.insert(schema.exportPresets).values({
      id,
      name,
      config_json: JSON.stringify(cfg),
      created_at: createdAt,
      origin,
    }).onConflictDoUpdate({
      target: schema.exportPresets.id,
      // `origin` is NOT updated on conflict: a preset that exists keeps the origin it was written
      // with, so re-saving over a seeded preset cannot promote it into a deletable one.
      set: { name, config_json: JSON.stringify(cfg) },
    }).run();
  }

  /**
   * The stored origin, or null when the preset does not exist.
   *
   * Uses `.all()` and reads the first row, NOT `.get()`. In this remote-callback setup `.get()`
   * returns the row's COLUMNS AS ARRAYS — `{ origin: ["user"] }` for a row whose origin is `"user"`,
   * and `{}` for no match — so a string comparison against it silently reports a user preset as
   * seeded. Every other repository in this codebase reads with `.all()`; this method follows that
   * pattern deliberately, because the difference is invisible until a value is compared.
   */
  async originOf(id: string): Promise<"seeded" | "user" | null> {
    const rows = await this.db.select({ origin: schema.exportPresets.origin })
      .from(schema.exportPresets).where(eq(schema.exportPresets.id, id)).all();
    const first = rows[0];
    if (!first || typeof first.origin !== "string") return null;
    return first.origin === "user" ? "user" : "seeded";
  }

  async delete(id: string): Promise<void> {
    await this.db.delete(schema.exportPresets).where(eq(schema.exportPresets.id, id)).run();
  }
}

// ── Export list & batch repositories ───────────────────────────

/**
 * The durable export list.
 *
 * Order is `position`, assigned from the current maximum when a clip is added, so the list reads in
 * the order the user built it rather than by insertion time or clip score.
 */
export class SqliteExportListRepository implements ExportListRepository {
  constructor(private readonly db: Db) {}

  async add(clipIds: string[]): Promise<void> {
    if (clipIds.length === 0) return;
    const rows = await this.db.select().from(schema.exportList).all();
    const maxPosition = rows.reduce((m, r) => Math.max(m, r.position), 0);
    let next = maxPosition + 1;
    const now = new Date().toISOString();
    for (const clipId of clipIds) {
      const existing = rows.find((r) => r.clip_id === clipId);
      if (existing) {
        // RE-ADDING RESTORES the original position rather than appending. The row was only
        // soft-removed, so its place is still meaningful — moving it to the end would silently
        // reorder the user's list because they toggled something off and back on.
        if (existing.removed_at !== null) {
          await this.db.update(schema.exportList)
            .set({ removed_at: null })
            .where(eq(schema.exportList.clip_id, clipId))
            .run();
        }
        continue;
      }
      await this.db.insert(schema.exportList).values({
        clip_id: clipId,
        added_at: now,
        position: next++,
        removed_at: null,
      }).run();
    }
  }

  async list(): Promise<ExportListRow[]> {
    const rows = await this.db.select().from(schema.exportList)
      .orderBy(asc(schema.exportList.position)).all();
    return rows
      .filter((r) => r.removed_at === null)
      .map((r) => ({ clipId: r.clip_id, addedAt: r.added_at, position: r.position, removedAt: r.removed_at }));
  }

  async remove(clipId: string): Promise<void> {
    await this.db.update(schema.exportList)
      .set({ removed_at: new Date().toISOString() })
      .where(eq(schema.exportList.clip_id, clipId))
      .run();
  }

  async removeMany(clipIds: string[]): Promise<void> {
    for (const clipId of clipIds) await this.remove(clipId);
  }

  async clear(): Promise<void> {
    const now = new Date().toISOString();
    await this.db.update(schema.exportList).set({ removed_at: now }).run();
  }

  async liveIds(): Promise<string[]> {
    return (await this.list()).map((r) => r.clipId);
  }
}

/**
 * The durable export batch.
 *
 * Every write here is scoped to ONE clip so a slow or failed item cannot disturb its neighbours, and
 * `setProgress` deliberately leaves `status` alone: a progress sample arriving after a cancel must
 * not put a cancelled row back into a live state.
 */
export class SqliteExportJobRepository implements ExportJobRepository {
  constructor(private readonly db: Db) {}

  async upsertQueued(row: {
    clipId: string;
    profileJson: string;
    outputDir: string | null;
    filename: string | null;
    position: number;
    /**
     * The BATCH's own stamp, supplied by the caller so every row of one enqueue shares it.
     *
     * This must not be generated here. `new Date()` per row meant a batch's rows carried stamps that
     * differed whenever they landed in different milliseconds — measured true on this machine's SSD
     * (two rows at `...16.896Z` and one at `...17.271Z` in separate enqueues), but NOT guaranteed:
     * a slower disk or Windows' coarser clock can spread a single batch across several stamps. The
     * batch scope is derived from these stamps (see `ExportQueue.view`), so per-row values make a
     * batch's own rows ambiguous with a previous batch's — with no way to tell them apart from the
     * data. One enqueue is one batch, so one enqueue passes one stamp.
     */
    requestedAt: string;
  }): Promise<void> {
    const now = row.requestedAt;
    const existing = await this.get(row.clipId);
    if (existing) {
      // ONE row per clip, so a re-enqueue REPLACES the record rather than appending a rival. Its
      // position is preserved when it was still pending, so re-enqueueing does not send an item to
      // the back of a queue it never left.
      await this.db.update(schema.exportJobs).set({
        status: "queued",
        profile_json: row.profileJson,
        output_dir: row.outputDir,
        filename: row.filename,
        position: existing.status === "queued" ? existing.position : row.position,
        phase: null,
        percent: 0,
        started_at: null,
        completed_at: null,
        error: null,
      }).where(eq(schema.exportJobs.clip_id, row.clipId)).run();
      return;
    }
    await this.db.insert(schema.exportJobs).values({
      clip_id: row.clipId,
      status: "queued",
      position: row.position,
      profile_json: row.profileJson,
      output_dir: row.outputDir,
      filename: row.filename,
      artifact_path: null,
      phase: null,
      percent: 0,
      requested_at: now,
      started_at: null,
      completed_at: null,
      error: null,
    }).run();
  }

  async list(): Promise<ExportJobRecord[]> {
    const rows = await this.db.select().from(schema.exportJobs)
      .orderBy(asc(schema.exportJobs.position)).all();
    return rows.map(rowToExportJob);
  }

  async get(clipId: string): Promise<ExportJobRecord | null> {
    const rows = await this.db.select().from(schema.exportJobs)
      .where(eq(schema.exportJobs.clip_id, clipId)).all();
    return rows[0] ? rowToExportJob(rows[0]) : null;
  }

  async nextQueued(): Promise<ExportJobRecord | null> {
    const rows = await this.db.select().from(schema.exportJobs)
      .where(eq(schema.exportJobs.status, "queued"))
      .orderBy(asc(schema.exportJobs.position)).all();
    return rows[0] ? rowToExportJob(rows[0]) : null;
  }

  async markRunning(clipId: string, startedAt: string): Promise<void> {
    await this.db.update(schema.exportJobs)
      .set({ status: "running", started_at: startedAt, percent: 0, phase: "probing", error: null })
      .where(eq(schema.exportJobs.clip_id, clipId)).run();
  }

  async setProgress(clipId: string, phase: string | null, percent: number, artifactPath: string | null): Promise<void> {
    // `status` is intentionally absent from this SET: progress is not a lifecycle event, and a
    // sample landing after a cancel would otherwise restore a cancelled row to "running".
    await this.db.update(schema.exportJobs)
      .set({ phase, percent, artifact_path: artifactPath })
      .where(eq(schema.exportJobs.clip_id, clipId)).run();
  }

  async markCompleted(clipId: string, exportPath: string, completedAt: string): Promise<void> {
    await this.db.update(schema.exportJobs)
      .set({ status: "completed", percent: 1, phase: null, completed_at: completedAt, artifact_path: exportPath, error: null })
      .where(eq(schema.exportJobs.clip_id, clipId)).run();
  }

  async markFailed(clipId: string, error: string, completedAt: string): Promise<void> {
    await this.db.update(schema.exportJobs)
      .set({ status: "failed", phase: null, completed_at: completedAt, error })
      .where(eq(schema.exportJobs.clip_id, clipId)).run();
  }

  async markCancelled(clipId: string, completedAt: string): Promise<void> {
    await this.db.update(schema.exportJobs)
      .set({ status: "cancelled", phase: null, completed_at: completedAt })
      .where(eq(schema.exportJobs.clip_id, clipId)).run();
  }

  async clearArtifactPath(clipId: string): Promise<void> {
    await this.db.update(schema.exportJobs)
      .set({ artifact_path: null })
      .where(eq(schema.exportJobs.clip_id, clipId)).run();
  }

  async dropIncomplete(): Promise<ExportJobRecord[]> {
    const all = await this.list();
    // "Incomplete" is queued OR running. A FAILED item is history and stays — dropping it would
    // erase the record of what went wrong, and the owner's rule was explicit that only incomplete
    // work is cancelled.
    const doomed = all.filter((r) => r.status === "queued" || r.status === "running");
    for (const row of doomed) {
      await this.db.delete(schema.exportJobs).where(eq(schema.exportJobs.clip_id, row.clipId)).run();
    }
    return doomed;
  }

  async counts(): Promise<Record<string, number>> {
    const all = await this.list();
    const out: Record<string, number> = { queued: 0, running: 0, completed: 0, failed: 0, cancelled: 0, total: all.length };
    for (const r of all) out[r.status] = (out[r.status] ?? 0) + 1;
    return out;
  }
}

function rowToExportJob(r: typeof schema.exportJobs.$inferSelect): ExportJobRecord {
  return {
    clipId: r.clip_id,
    status: r.status,
    position: r.position,
    profileJson: r.profile_json,
    outputDir: r.output_dir,
    filename: r.filename,
    artifactPath: r.artifact_path,
    phase: r.phase,
    percent: r.percent,
    requestedAt: r.requested_at,
    startedAt: r.started_at,
    completedAt: r.completed_at,
    error: r.error,
  };
}
