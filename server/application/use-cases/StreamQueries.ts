/**
 * Streams: list/get/delete/update/attach-chat.
 *
 * List/Get are thin delegations — they exist as named use-cases so the HTTP
 * adapter has one dependency shape, not raw repos. The real logic lives in
 * Delete/Update/AttachChat (multi-step, guarded).
 */
import type {
  StreamRepository,
  JobRepository,
  FileSystemPort,
  StreamMetadataRepository,
  StreamStorage,
} from "@/application/ports/outbound.ts";
import type { Stream, StreamStatus } from "shared/types";
import { withChat } from "@/domain/mod.ts";
import {
  reconcileStreamRecord,
  scanArtifactNames,
  type ArtifactDirScan,
} from "@/application/use-cases/reconcile-stream.ts";
import { streamSlug } from "@/application/use-cases/artifact-naming.ts";

/**
 * Repairs a stream record against its artifact directory. The user owns that
 * folder (drag in, delete, move), so a stored path is a claim and disk is the
 * truth — this runs on every read so the DB converges without a restart.
 */
export class StreamReconciler {
  constructor(
    private readonly streams: StreamRepository,
    private readonly fs: FileSystemPort,
    private readonly cacheDir: string,
  ) {}

  /**
   * The directory that actually holds this stream's media.
   *
   * Order, and each step earns its place:
   *   1. `projectDir` — the RECORDED location. A project lives wherever its own path says:
   *      the user's VOD directory, or any drive they moved it to. It is the only source that
   *      survives a rename or a move.
   *   2. the directories of the recorded media paths — for projects created before
   *      `projectDir` existed, and for one whose folder was renamed: the files themselves
   *      still say where the media is.
   *   3. `{cacheDir}/vods/{id}` — the pre-0.5.0 layout, last because it is a guess.
   *
   * Returns null when none of them exist, which is the "this project is unreachable" case
   * the UI reports — NOT an error, and not a reason to drop the recorded path.
   */
  private async artifactDir(stream: Stream): Promise<string | null> {
    if (stream.projectDir && await this.fs.exists(stream.projectDir)) return stream.projectDir;
    for (const p of [stream.vodPath, stream.chatPath]) {
      if (!p) continue;
      const dir = p.replace(/[\\/][^\\/]+$/, "");
      if (await this.fs.exists(dir)) return dir;
    }
    const canonical = `${this.cacheDir}/vods/${stream.id}`;
    return (await this.fs.exists(canonical)) ? canonical : null;
  }

  /**
   * The recorded location to persist, or null when there is nothing to record.
   *
   * Only a directory that EXISTS is adopted. Recording a path that is currently missing
   * would turn "the drive is not mounted right now" into "this project lives here" — and
   * once recorded, a later move would look like the project was deleted rather than
   * relocated. Absence is already reported by the view; it must not overwrite the record.
   */
  private async adoptableDir(stream: Stream): Promise<string | null> {
    if (stream.projectDir) return null; // already recorded — never overwritten here
    const resolved = await this.resolvedDir(stream);
    return resolved;
  }

  /** Where this project's media is, per the recorded paths, else the pre-0.5.0 layout. */
  private async resolvedDir(stream: Stream): Promise<string | null> {
    for (const p of [stream.vodPath, stream.chatPath]) {
      if (!p) continue;
      const dir = p.replace(/[\\/][^\\/]+$/, "");
      if (await this.fs.exists(dir)) return dir;
    }
    const canonical = `${this.cacheDir}/vods/${stream.id}`;
    return (await this.fs.exists(canonical)) ? canonical : null;
  }

  /** Scan the stream's real directory for media the record does not know about. */
  private async scan(stream: Stream): Promise<ArtifactDirScan | null> {
    const dir = await this.artifactDir(stream);
    if (!dir) return null;
    let names: string[] = [];
    try {
      names = await this.fs.listFiles(dir);
    } catch {
      return null;
    }
    return scanArtifactNames(dir, names, streamSlug(stream));
  }

  /**
   * Repair the record against disk. Returns the (possibly updated) stream —
   * a dropped or adopted path is persisted so the next read is already clean.
   */
  async reconcile(stream: Stream): Promise<Stream> {
    const scan = await this.scan(stream);
    // `exists` is async here and sync in the rule: pre-resolve the two paths the rule asks
    // about so one pure implementation serves both this and the unit tests.
    const cache = new Map<string, boolean>();
    for (const p of [stream.vodPath, stream.chatPath]) {
      if (!p) continue;
      cache.set(p, await this.fs.exists(p).catch(() => false));
    }
    const result = reconcileStreamRecord(stream, scan, (p) => cache.get(p) ?? false);
    // The project's OWN folder is adopted on first read (a project created before the field
    // existed, or a first read of a fresh one) and persisted, so the location becomes a
    // recorded fact instead of something re-derived on every request. Only a directory that
    // actually exists is adopted — see adoptableDir.
    const adoptedDir = await this.adoptableDir(stream);
    const patch: Partial<Stream> = {};
    if (result.stream) {
      // The rule is deliberately narrower than the row (it only ever repairs these two
      // fields), so narrow the patch back to what it can actually contain.
      patch.vodPath = result.stream.vodPath;
      if (result.stream.chatPath !== undefined) patch.chatPath = result.stream.chatPath;
    }
    if (adoptedDir) patch.projectDir = adoptedDir;
    if (Object.keys(patch).length === 0) return stream;
    const updated = await this.streams.update({ ...stream, ...patch });
    return updated ?? { ...stream, ...patch };
  }

}

export class ListStreamsUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly reconciler?: StreamReconciler,
  ) {}
  async execute(status?: StreamStatus): Promise<Stream[]> {
    const all = await this.streams.list(status);
    if (!this.reconciler) return all;
    return await Promise.all(all.map((s) => this.reconciler!.reconcile(s)));
  }
}

export class GetStreamUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly reconciler?: StreamReconciler,
  ) {}
  async execute(streamId: string): Promise<Stream | null> {
    const stream = await this.streams.findById(streamId);
    if (!stream) return null;
    return this.reconciler ? await this.reconciler.reconcile(stream) : stream;
  }
}

export class DeleteStreamUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly jobs: JobRepository,
    private readonly metadata: StreamMetadataRepository,
    private readonly storage: StreamStorage,
  ) {}

  async execute(streamId: string): Promise<void> {
    const streamJobs = await this.jobs.listByStream(streamId);
    for (const job of streamJobs) {
      await this.jobs.delete(job.id);
    }
    await this.metadata.deleteAll(streamId);
    await this.storage.deleteStream(streamId);
    await this.streams.delete(streamId);
  }
}

/** Update a stream's editable metadata (title, streamer, game, vodPath, chatPath). */
export class UpdateStreamUseCase {
  constructor(private readonly streams: StreamRepository) {}
  async execute(streamId: string, patch: Partial<Pick<Stream, 'title' | 'streamer' | 'game' | 'vodPath' | 'chatPath' | 'sourceUrl'>>): Promise<Stream> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);
    const updated: Stream = {
      ...stream,
      ...(patch.title !== undefined ? { title: patch.title } : {}),
      ...(patch.streamer !== undefined ? { streamer: patch.streamer } : {}),
      ...(patch.game !== undefined ? { game: patch.game } : {}),
      ...(patch.vodPath !== undefined ? { vodPath: patch.vodPath } : {}),
      ...(patch.chatPath !== undefined ? { chatPath: patch.chatPath } : {}),
      ...(patch.sourceUrl !== undefined ? { sourceUrl: patch.sourceUrl } : {}),
    };
    await this.streams.update(updated);
    return updated;
  }
}

/** Attach a chat file to an existing stream — independent of VOD import. */
export class AttachChatUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly fs: FileSystemPort,
  ) {}

  async execute(streamId: string, chatPath: string): Promise<Stream> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);
    if (!(await this.fs.exists(chatPath))) {
      throw new Error(`Chat file not found: ${chatPath}`);
    }
    const updated = withChat(stream, chatPath);
    await this.streams.update(updated);
    return updated;
  }
}