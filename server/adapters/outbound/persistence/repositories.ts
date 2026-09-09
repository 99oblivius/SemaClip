import { eq, and, asc } from "drizzle-orm";
import type { Db } from "./db.ts";
import { schema } from "./db.ts";
import type {
  StreamRepository,
  JobRepository,
  ClipRepository,
  PersonaRepository,
  StreamMetadataRepository,
} from "@/application/ports/outbound.ts";
import type { Stream, Job, Clip, Persona, StreamStatus, Axis } from "shared/types";

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
    jobId: r.job_id,
    streamId: r.stream_id,
    axis: r.axis as Axis,
    score: r.score,
    startTime: r.start_time,
    endTime: r.end_time,
    peakTime: r.peak_time,
    justification: r.justification,
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
    }).run();
  }

  async findById(id: string): Promise<Stream | null> {
    const rows = await this.db.select().from(schema.streams).where(eq(schema.streams.id, id)).limit(1).all();
    return rows[0] ? rowToStream(rows[0]) : null;
  }

  async list(status?: StreamStatus): Promise<Stream[]> {
    const q = status
      ? this.db.select().from(schema.streams).where(eq(schema.streams.status, status)).orderBy(asc(schema.streams.created_at))
      : this.db.select().from(schema.streams).orderBy(asc(schema.streams.created_at));
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

  async update(clip: Clip): Promise<void> {
    await this.db.update(schema.clips).set({
      score: clip.score,
      start_time: clip.startTime,
      end_time: clip.endTime,
      peak_time: clip.peakTime,
      justification: clip.justification,
      rank: clip.rank,
      exported: clip.exported ? 1 : 0,
      export_path: clip.exportPath,
      rejected: clip.rejected ? 1 : 0,
      signals_json: clip.signals ? JSON.stringify(clip.signals) : null,
    }).where(eq(schema.clips.id, clip.id)).run();
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
