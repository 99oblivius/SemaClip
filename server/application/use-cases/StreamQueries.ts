import type { StreamRepository, JobRepository, FileSystemPort } from "@/application/ports/outbound.ts";
import type { Stream, StreamStatus } from "shared/types";
import { withChat } from "@/domain/mod.ts";

export class ListStreamsUseCase {
  constructor(private readonly streams: StreamRepository) {}
  async execute(status?: StreamStatus): Promise<Stream[]> {
    return this.streams.list(status);
  }
}

export class GetStreamUseCase {
  constructor(private readonly streams: StreamRepository) {}
  async execute(streamId: string): Promise<Stream | null> {
    return this.streams.findById(streamId);
  }
}

export class DeleteStreamUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly jobs: JobRepository,
  ) {}

  async execute(streamId: string): Promise<void> {
    const streamJobs = await this.jobs.listByStream(streamId);
    for (const job of streamJobs) {
      await this.jobs.delete(job.id);
    }
    await this.streams.delete(streamId);
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
