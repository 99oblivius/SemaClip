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
import { pickVideo, type ArtifactDirScan } from "@/application/use-cases/reconcile-stream.ts";

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
   * A URL import downloads into `{cacheDir}/vods/{id}`; a FOLDER import
   * references the user's own folder (which may be anywhere). Scanning the
   * canonical layout for a folder import looks in the wrong place and would
   * drop perfectly valid paths, so the recorded paths come first and the
   * cache layout is only the fallback.
   */
  private async artifactDir(stream: Stream): Promise<string | null> {
    for (const p of [stream.vodPath, stream.chatPath]) {
      if (!p) continue;
      const dir = p.replace(/\/[^/]+$/, "");
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
    const chosen = pickVideo(names);
    return {
      videos: chosen ? [`${dir}/${chosen}`] : [],
      chat: names.includes("chat.json") ? `${dir}/chat.json` : null,
    };
  }

  /**
   * Repair the record against disk. Returns the (possibly updated) stream —
   * a dropped or adopted path is persisted so the next read is already clean.
   */
  async reconcile(stream: Stream): Promise<Stream> {
    const scan = await this.scan(stream);
    const exists = async (p: string) => {
      try {
        return await this.fs.exists(p);
      } catch {
        return false;
      }
    };
    let vodPath = stream.vodPath ?? "";
    let chatPath = stream.chatPath ?? null;
    let changed = false;

    // Drop claims whose files are gone.
    if (vodPath && !(await exists(vodPath))) {
      vodPath = "";
      changed = true;
    }
    if (chatPath && !(await exists(chatPath))) {
      chatPath = null;
      changed = true;
    }
    // Adopt files the user added to the folder.
    if (!vodPath && scan?.videos[0]) {
      vodPath = scan.videos[0];
      changed = true;
    }
    if (!chatPath && scan?.chat) {
      chatPath = scan.chat;
      changed = true;
    }
    if (!changed) return stream;
    const updated = await this.streams.update({ ...stream, vodPath, chatPath });
    return updated ?? { ...stream, vodPath, chatPath };
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