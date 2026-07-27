import type {
  StreamRepository,
  JobRepository,
  ClipRepository,
  EnginePort,
  EventBus,
  FileSystemPort,
} from "@/application/ports/outbound.ts";
import { ENGINE_EVENT_TOPIC, JOB_STATUS_TOPIC, STREAM_STATUS_TOPIC } from "@/application/ports/outbound.ts";
import type { Job, JobConfig, EngineEvent, Stream, Clip } from "shared/types";
import { createJob, start as startJob, fail as failJob, complete as completeJob, cancel as cancelJob, isTerminal } from "@/domain/mod.ts";
import { createClip } from "@/domain/mod.ts";

/**
 * Orchestrates the full ML pipeline lifecycle:
 * queue → start engine → handle events → persist clips → complete.
 */
export class StartJobUseCase {
  constructor(
    private readonly streams: StreamRepository,
    private readonly jobs: JobRepository,
    private readonly clips: ClipRepository,
    private readonly engine: EnginePort,
    private readonly bus: EventBus,
    private readonly fs: FileSystemPort,
  ) {}

  async execute(streamId: string, config?: JobConfig): Promise<Job> {
    const stream = await this.streams.findById(streamId);
    if (!stream) throw new Error(`Stream not found: ${streamId}`);
    if (stream.vodPath === "") throw new Error("Stream VOD not yet downloaded");

    const queued = await this.jobs.listQueued();
    const position = queued.length;
    const job = createJob({ streamId, config }, position);
    await this.jobs.save(job);

    // If no job is running, start this one in the background.
    const running = await this.jobs.listRunning();
    if (running.length === 0) {
      this.runJob(job, stream).catch((err) => {
        console.error(`Job ${job.id} failed:`, err);
      });
    }

    return job;
  }

  private async runJob(job: Job, stream: Stream): Promise<void> {
    const started = startJob(job);
    await this.jobs.update(started);
    this.bus.publish(JOB_STATUS_TOPIC, { jobId: job.id, status: "running", streamId: stream.id });
    await this.streams.update({ ...stream, status: "processing" });
    this.bus.publish(STREAM_STATUS_TOPIC, { streamId: stream.id, status: "processing" });

    const unsub = this.bus.subscribe<EngineEvent>(ENGINE_EVENT_TOPIC, (event) => {
      this.handleEngineEvent(event, started.id, stream).catch((err) => {
        console.error(`Engine event handler error for job ${job.id}:`, err);
      });
    });

    try {
      await this.engine.start({
        type: "start",
        jobId: job.id,
        vodPath: stream.vodPath,
        chatPath: stream.chatPath,
        config: job.config,
      });
    } catch (err) {
      await this.failJob(started.id, stream, err instanceof Error ? err.message : String(err));
    } finally {
      unsub();
    }
  }
  private async handleEngineEvent(event: EngineEvent, jobId: string, stream: Stream): Promise<void> {
    switch (event.type) {
      case "clip": {
        const clip = createClip(
          {
            jobId,
            streamId: stream.id,
            axis: event.axis,
            score: event.score,
            startTime: event.start,
            endTime: event.end,
            peakTime: event.peak,
            justification: event.justification,
          },
          null,
        );
        await this.clips.save(clip);
        this.bus.publish("clip:new", clip);
        break;
      }
      case "complete": {
        await this.completeJob(jobId, stream);
        break;
      }
      case "error": {
        await this.failJob(jobId, stream, event.message);
        break;
      }
      default:
        // progress, segment, candidate events forwarded to WS clients via the bus.
        break;
    }
  }

  private async completeJob(jobId: string, stream: Stream): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job || isTerminal(job.status)) return;
    await this.jobs.update(completeJob(job));
    await this.streams.update({ ...stream, status: "completed" });
    this.bus.publish(JOB_STATUS_TOPIC, { jobId, status: "completed", streamId: stream.id });
    this.bus.publish(STREAM_STATUS_TOPIC, { streamId: stream.id, status: "completed" });
    await this.tryStartNextJob();
  }

  private async failJob(jobId: string, stream: Stream, error: string): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job || isTerminal(job.status)) return;
    await this.jobs.update(failJob(job, error));
    await this.streams.update({ ...stream, status: "failed" });
    this.bus.publish(JOB_STATUS_TOPIC, { jobId, status: "failed", streamId: stream.id });
    this.bus.publish(STREAM_STATUS_TOPIC, { streamId: stream.id, status: "failed" });
    await this.tryStartNextJob();
  }

  /** Pull the next queued job and start it. Called when a job completes/fails. */
  async tryStartNextJob(): Promise<void> {
    const running = await this.jobs.listRunning();
    if (running.length > 0) return;
    const queued = await this.jobs.listQueued();
    if (queued.length === 0) return;
    const next = queued[0]!;
    const stream = await this.streams.findById(next.streamId);
    if (stream) await this.runJob(next, stream);
  }
}

export class CancelJobUseCase {
  constructor(
    private readonly jobs: JobRepository,
    private readonly engine: EnginePort,
    private readonly bus: EventBus,
  ) {}

  async execute(jobId: string): Promise<Job> {
    const job = await this.jobs.findById(jobId);
    if (!job) throw new Error(`Job not found: ${jobId}`);
    if (isTerminal(job.status)) throw new Error(`Job already terminal: ${job.status}`);

    if (job.status === "running") {
      await this.engine.cancel();
    }
    const cancelled = cancelJob(job);
    await this.jobs.update(cancelled);
    this.bus.publish(JOB_STATUS_TOPIC, { jobId, status: "cancelled", streamId: job.streamId });
    return cancelled;
  }
}

/** List all jobs: running first, then queued (by position), then terminal. */
export class ListJobsUseCase {
  constructor(private readonly jobs: JobRepository) {}

  async execute(): Promise<Job[]> {
    const running = await this.jobs.listRunning();
    const queued = await this.jobs.listQueued();
    return [...running, ...queued.sort((a, b) => a.position - b.position)];
  }
}
