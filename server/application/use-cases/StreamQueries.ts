import type { StreamRepository, JobRepository } from "@/application/ports/outbound.ts";
import type { Stream, StreamStatus } from "shared/types";

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
