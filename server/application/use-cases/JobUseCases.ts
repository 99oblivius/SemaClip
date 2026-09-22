import type {
  StreamRepository,
  JobRepository,
  ClipRepository,
  EnginePort,
  EventBus,
  FileSystemPort,
  StreamMetadataRepository,
  StreamStorage,
} from "@/application/ports/outbound.ts";
import { ENGINE_EVENT_TOPIC, JOB_STATUS_TOPIC, STREAM_STATUS_TOPIC } from "@/application/ports/outbound.ts";
import type { Job, JobConfig, EngineEvent, Stream, ClipSignals } from "shared/types";
import { createJob, start as startJob, fail as failJob, complete as completeJob, cancel as cancelJob, isTerminal } from "@/domain/mod.ts";
import { createClip } from "@/domain/mod.ts";
import { PythonEngineAdapter } from "@/adapters/outbound/engine/PythonEngineAdapter.ts";

/**
 * Orchestrates the detection pipeline lifecycle:
 * queue → start engine → handle events → persist clips → complete.
 *
 * Lifecycle invariants (v2, ARCHITECTURE.md §5.4):
 * - Exactly one writer transitions a job into a terminal state. All terminal
 *   transitions funnel through settleJob(), which is idempotent per job.
 * - A watchdog fails jobs that emit no event within eventWatchdogMs — an
 *   engine that wedges must fail loudly, not hang the queue.
 * - Engine exit without a `complete` event → failed, never a silent running.
 * - Cancel resets the stream status (v1 leaked 'processing' forever).
 */
export class StartJobUseCase {
  /** Max silence from the engine before the job fails. Generous — cold model
   *  loads can take minutes — but bounded. */
  // 5 min of event silence = dead engine. Stages that can legitimately run
  // longer emit heartbeats (e.g. proxy_generation); the watchdog is the
  // backstop, not a stage timeout.
  private static readonly EVENT_WATCHDOG_MS = 5 * 60 * 1000;

  constructor(
    private readonly streams: StreamRepository,
    private readonly jobs: JobRepository,
    private readonly clips: ClipRepository,
    private readonly engine: EnginePort,
    private readonly bus: EventBus,
    private readonly fs: FileSystemPort,
    private readonly eventWatchdogMs: number = StartJobUseCase.EVENT_WATCHDOG_MS,
    /** Set when the engine is the in-process v2 engine: enables SRT registration. */
    private readonly metadata?: StreamMetadataRepository | undefined,
    private readonly storage?: StreamStorage | undefined,
    /** CPU-usage tier worker budget, resolved from settings at construction. */
    private readonly workersBudget?: number | undefined,
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

    // Watchdog: any event for this job resets the timer; expiry fails the job.
    let watchdogTimer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      void this.onWatchdogTimeout(started.id, stream);
    }, this.eventWatchdogMs);
    const resetWatchdog = () => {
      if (watchdogTimer !== null) clearTimeout(watchdogTimer);
      watchdogTimer = setTimeout(() => {
        void this.onWatchdogTimeout(started.id, stream);
      }, this.eventWatchdogMs);
    };
    const unsubWatchdog = this.bus.subscribe<EngineEvent>(ENGINE_EVENT_TOPIC, (event) => {
      if (event.jobId === job.id) resetWatchdog();
    });

    try {
      // Resolve the per-stream artifact dir before the engine runs, so derived
      // artifacts (SRT) land in the stream's own directory, not a temp path.
      let artifactDir: string | undefined;
      if (this.storage) {
        await this.storage.ensureStreamDirs(stream.id);
        artifactDir = this.storage.streamDir(stream.id);
      }
      await this.engine.start({
        type: "start",
        jobId: job.id,
        vodPath: stream.vodPath,
        chatPath: stream.chatPath,
        config: job.config,
        artifactDir,
        workers: this.workersBudget,
      });
      // Engine exited cleanly with no `complete` event → the job would wedge
      // 'running' forever (the v1 queue deadlock). Fail it.
      await this.settleIfRunning(started.id, stream, { type: "fail", error: "Engine exited without a completion event" });
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      const stderr = (this.engine as PythonEngineAdapter).lastStderrLines?.() ?? [];
      const message = stderr.length > 0 ? `${detail} — stderr: …${stderr.slice(-3).join(" | ")}` : detail;
      await this.settleIfRunning(started.id, stream, { type: "fail", error: message });
    } finally {
      // Register the transcript SRT if the engine wrote one (both success and
      // failure paths — a partial transcript still enables captioning).
      if (this.metadata && this.storage) {
        const srtPath = `${this.storage.streamDir(stream.id)}/transcript.srt`;
        try {
          if (await this.fs.exists(srtPath)) {
            await this.metadata.set(stream.id, "transcript_srt", JSON.stringify({ path: srtPath }));
          }
        } catch (err) {
          console.error(`Job ${job.id}: SRT registration failed:`, err);
        }
      }
      if (watchdogTimer !== null) clearTimeout(watchdogTimer);
      unsub();
      unsubWatchdog();
    }
  }

  private async onWatchdogTimeout(jobId: string, stream: Stream): Promise<void> {
    console.error(`Job ${jobId}: no engine event for ${this.eventWatchdogMs}ms — failing job`);
    await this.settleIfRunning(jobId, stream, {
      type: "fail",
      error: `Watchdog: no engine output within ${Math.round(this.eventWatchdogMs / 1000)}s`,
    });
  }

  /** Terminal-state single writer: first settle wins; later calls are no-ops. */
  private async settleJob(
    jobId: string,
    stream: Stream,
    outcome: { type: "complete" } | { type: "fail"; error: string },
  ): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job) return;
    if (isTerminal(job.status)) return;

    if (outcome.type === "complete") {
      await this.jobs.update(completeJob(job));
      await this.streams.update({ ...stream, status: "completed" });
      this.bus.publish(JOB_STATUS_TOPIC, { jobId, status: "completed", streamId: stream.id });
      this.bus.publish(STREAM_STATUS_TOPIC, { streamId: stream.id, status: "completed" });
    } else {
      await this.jobs.update(failJob(job, outcome.error));
      await this.streams.update({ ...stream, status: "failed" });
      this.bus.publish(JOB_STATUS_TOPIC, { jobId, status: "failed", streamId: stream.id });
      this.bus.publish(STREAM_STATUS_TOPIC, { streamId: stream.id, status: "failed" });
    }
    await this.tryStartNextJob();
  }

  private async settleIfRunning(
    jobId: string,
    stream: Stream,
    outcome: { type: "complete" } | { type: "fail"; error: string },
  ): Promise<void> {
    const job = await this.jobs.findById(jobId);
    if (!job || job.status !== "running") return;
    await this.settleJob(jobId, stream, outcome);
  }

  private async handleEngineEvent(event: EngineEvent, jobId: string, stream: Stream): Promise<void> {
    if (event.jobId !== jobId) return; // strays from a previous engine run
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
            signals: hasRealSignals(event.signals) ? event.signals : null,
            // The matched axis IS this clip's name, from the moment it is created.
            //
            // The engine knows why it kept this moment and a human reading the library does not, so
            // the axis is the honest name for a detected clip — and it is what `{name}` renders into
            // a filename. Written here rather than left as null because nothing later can recover the
            // fact: `clips.title` is the only column a user can rename, and it must start out saying
            // what the clip was detected AS. A hand-made clip has no axis and so keeps a null title,
            // which is the distinction the whole manual-clip design rests on.
            title: event.axis,
          },
          null,
        );
        await this.clips.save(clip);
        break;
      }
      case "complete": {
        await this.settleJob(jobId, stream, { type: "complete" });
        break;
      }
      case "error": {
        await this.settleJob(jobId, stream, { type: "fail", error: event.message });
        break;
      }
      case "segment": {
        // Regimes accumulate in metadata as they arrive; the timeline reads
        // the persisted list rather than replaying WS events after reload.
        if (!this.metadata) break;
        const raw = await this.metadata.get(stream.id, "regimes_json");
        const list = raw ? (JSON.parse(raw) as { start: number; end: number; type: string }[]) : [];
        list.push({ start: event.start, end: event.end, type: event.regime });
        await this.metadata.set(stream.id, "regimes_json", JSON.stringify(list));
        break;
      }
      default:
        // progress, candidate events forwarded to WS clients via the bus.
        break;
    }
  }

  /** Pull the next queued job and start it. Called when a job settles. */
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

function hasRealSignals(s: ClipSignals | undefined): s is ClipSignals {
  if (!s) return false;
  // All-zero signals are the validator's "absent" marker — don't persist as real.
  return Object.values(s).some((v) => v > 0);
}

export class CancelJobUseCase {
  constructor(
    private readonly jobs: JobRepository,
    private readonly streams: StreamRepository,
    private readonly engine: EnginePort,
    private readonly bus: EventBus,
    /** Reuses the same lifecycle runner so queue-advance after cancel shares
     *  one implementation. The clips/fs deps are unused on the cancel path. */
    private readonly startJobs: StartJobUseCase,
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

    // v1 leak: cancelled running jobs left stream.status='processing' forever.
    if (job.status === "running") {
      const stream = await this.streams.findById(job.streamId);
      if (stream && stream.status === "processing") {
        await this.streams.update({ ...stream, status: "pending" });
        this.bus.publish(STREAM_STATUS_TOPIC, { streamId: stream.id, status: "pending" });
      }
      // The running slot is free — advance the queue.
      await this.startJobs.tryStartNextJob();
    }
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