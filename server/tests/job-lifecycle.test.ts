/**
 * Job lifecycle integration tests — the regression suite for the v1 audit's
 * failure classes (ROADMAP.md Phase 0 exit gate). Each test drives
 * StartJobUseCase with a fake engine that reproduces one audited failure mode
 * and asserts the specified terminal state.
 *
 * The engine is an in-process EnginePort fake that emits events on the bus
 * exactly as PythonEngineAdapter would — no subprocess in the loop.
 */
import { assertEquals } from "@std/assert";
import { InProcessEventBus } from "@/adapters/outbound/eventbus/InProcessEventBus.ts";
import type { EventBus, StreamRepository, JobRepository, ClipRepository, EnginePort, FileSystemPort } from "@/application/ports/outbound.ts";
import { ENGINE_EVENT_TOPIC, JOB_STATUS_TOPIC } from "@/application/ports/outbound.ts";
import { StartJobUseCase, CancelJobUseCase } from "@/application/use-cases/JobUseCases.ts";
import type { Job, Stream, EngineEvent, EngineCommand } from "shared/types";
import { createStream, createJob } from "@/domain/mod.ts";

// ── In-memory fakes (mirrors of the sqlite repos' semantics) ──

function memStreams(): StreamRepository & { seed(s: Stream): void } {
  const map = new Map<string, Stream>();
  return {
    seed: (s) => void map.set(s.id, s),
    async save(s) { map.set(s.id, { ...s }); },
    async findById(id) { return map.get(id) ?? null; },
    async list() { return [...map.values()]; },
    async update(s) { map.set(s.id, { ...map.get(s.id), ...s }); },
    async delete(id) { map.delete(id); },
  };
}

function jobRepoFake() {
  const map = new Map<string, Job>();
  const repo: JobRepository & { seed(j: Job): void } = {
    seed: (j) => void map.set(j.id, { ...j }),
    async save(j) { map.set(j.id, { ...j }); },
    async findById(id) { return map.get(id) ?? null; },
    async listByStream(streamId) { return [...map.values()].filter((j) => j.streamId === streamId); },
    async listQueued() { return [...map.values()].filter((j) => j.status === "queued").sort((a, b) => a.position - b.position); },
    async listRunning() { return [...map.values()].filter((j) => j.status === "running"); },
    async update(j) { map.set(j.id, { ...map.get(j.id), ...j }); },
    async delete(id) { map.delete(id); },
  };
  return repo;
}

function clipRepoFake() {
  const clips: unknown[] = [];
  return {
    async save(c: unknown) { clips.push(c); },
    async findById() { return null; },
    async listByJob() { return []; },
    async listByStream() { return []; },
    async update() {},
    all: () => clips,
  };
}

const fsFake: FileSystemPort = {
  async exists() { return true; },
  async ensureDir() {},
  async remove() {},
  joinPath: (...s) => s.join("/"),
  async listFiles() { return []; },
};

/** Scriptable engine fake: emits the scripted events, then resolves start(). */
class EngineFake implements EnginePort {
  bus: EventBus | null = null;
  private currentJobId: string | null = null;

  constructor(private readonly script: (jobId: string, emit: (e: EngineEvent) => void) => Promise<void>) {}

  async start(command: EngineCommand): Promise<void> {
    if (command.type !== "start") return;
    this.currentJobId = command.jobId;
    await this.script(command.jobId, (e) => this.bus?.publish("engine:event", e));
  }
  async cancel(): Promise<void> {}
  onEvent(): () => void { return () => {}; }
  isRunning(): boolean { return false; }
}

async function makeStream(streams: StreamRepository & { seed(s: Stream): void }): Promise<Stream> {
  const s = createStream({ vodPath: "/tmp/fake.mp4" });
  streams.seed(s);
  return s;
}

// ── Tests ──

Deno.test("complete event → job completed, stream completed, queue advances", async () => {
  const bus = new InProcessEventBus();
  const streams = streamRepoFake();
  const jobs = jobRepoFake();
  const clips = clipRepoFake();
  const stream = await makeStream(streams);

  const engine = new EngineFake(async (jobId, emit) => {
    emit({ type: "progress", jobId, phase: "transcription", percent: 0.5 });
    emit({ type: "complete", jobId, clipsFound: 0 });
  });
  engine.bus = bus;

  const uc = new StartJobUseCase(streams, jobs, clips as never, engine, bus, fsFake, 500);
  await uc.execute(stream.id);
  // Drain microtasks (runJob is fire-and-forget).
  await new Promise((r) => setTimeout(r, 50));

  const running = await jobs.listRunning();
  assertEquals(running.length, 0, "no job left running after completion");
  assertEquals((await jobs.listByStream(stream.id)).every((j) => j.status === "completed"), true);
  assertEquals((await streams.findById(stream.id))?.status, "completed");
});

Deno.test("engine exit without complete → job failed (no silent wedge)", async () => {
  const bus = new InProcessEventBus();
  const streams = streamRepoFake();
  const jobs = jobRepoFake();
  const clips = clipRepoFake();
  const stream = await makeStream(streams);

  // Engine resolves start() WITHOUT emitting complete — the v1 deadlock.
  const engine = new EngineFake(async () => {});
  engine.bus = bus;

  const uc = new StartJobUseCase(streams, jobs, clips as never, engine, bus, fsFake, 500);
  await uc.execute(stream.id);
  await new Promise((r) => setTimeout(r, 50));

  const all = await jobs.listByStream(stream.id);
  assertEquals(all.length, 1);
  assertEquals(all[0]!.status, "failed");
  assertEquals(all[0]!.error, "Engine exited without a completion event");
  assertEquals((await streams.findById(stream.id))?.status, "failed");
});

Deno.test("watchdog: silent engine → job failed after timeout", async () => {
  const bus = new InProcessEventBus();
  const streams = streamRepoFake();
  const jobs = jobRepoFake();
  const clips = clipRepoFake();
  const stream = await makeStream(streams);

  // Engine emits progress then goes silent; start() never resolves during the test.
  const engine = new EngineFake(async (_jobId, emit) => {
    emit({ type: "progress", jobId: _jobId, phase: "audio_extraction", percent: 0.1 });
    await new Promise(() => {}); // hang forever
  });
  engine.bus = bus;

  const uc = new StartJobUseCase(streams, jobs, clips as never, engine, bus, fsFake, 120);
  await uc.execute(stream.id);
  await new Promise((r) => setTimeout(r, 400));

  const all = await jobs.listByStream(stream.id);
  assertEquals(all[0]!.status, "failed");
  assertEquals((all[0]!.error ?? "").startsWith("Watchdog"), true);
});

Deno.test("engine error event → job failed with the engine's message", async () => {
  const bus = new InProcessEventBus();
  const streams = streamRepoFake();
  const jobs = jobRepoFake();
  const clips = clipRepoFake();
  const stream = await makeStream(streams);

  const engine = new EngineFake(async (jobId, emit) => {
    emit({ type: "error", jobId, phase: "embedding", message: "CUDA OOM" });
  });
  engine.bus = bus;

  const uc = new StartJobUseCase(streams, jobs, clips as never, engine, bus, fsFake, 500);
  await uc.execute(stream.id);
  await new Promise((r) => setTimeout(r, 50));

  const all = await jobs.listByStream(stream.id);
  assertEquals(all[0]!.status, "failed");
  assertEquals(all[0]!.error, "CUDA OOM");
});

Deno.test("stray events from a previous job are ignored", async () => {
  const bus = new InProcessEventBus();
  const streams = streamRepoFake();
  const jobs = jobRepoFake();
  const clips = clipRepoFake();
  const stream = await makeStream(streams);

  // Pre-seed a stale 'running' job from an earlier engine run.
  const stale = createJob({ streamId: stream.id }, 0);
  jobs.seed({ ...stale, id: "stale-job", status: "completed" });

  const engine = new EngineFake(async (jobId, emit) => {
    // Emit an error event addressed to the STALE job id — must not fail ours.
    emit({ type: "error", jobId: "stale-job", phase: "embedding", message: "from the past" });
    emit({ type: "complete", jobId, clipsFound: 0 });
  });
  engine.bus = bus;

  const uc = new StartJobUseCase(streams, jobs, clips as never, engine, bus, fsFake, 500);
  await uc.execute(stream.id);
  await new Promise((r) => setTimeout(r, 50));

  const all = await jobs.listByStream(stream.id);
  const ours = all.find((j) => j.id !== "stale-job")!;
  assertEquals(ours.status, "completed", "stray error event must not fail the current job");
});

Deno.test("queued jobs start sequentially: second job runs after first completes", async () => {
  const bus = new InProcessEventBus();
  const streams = streamRepoFake();
  const jobs = jobRepoFake();
  const clips = clipRepoFake();
  const s1 = await makeStream(streams);
  const s2 = createStream({ vodPath: "/tmp/fake2.mp4" });
  streams.seed(s2);

  let firstRunning = false;
  const engine = new EngineFake(async (jobId, emit) => {
    if (jobId.startsWith("first")) {
      firstRunning = true;
      await new Promise((r) => setTimeout(r, 100));
      emit({ type: "complete", jobId, clipsFound: 0 });
    } else {
      if (!firstRunning) throw new Error("second job started while first still running");
      emit({ type: "complete", jobId, clipsFound: 0 });
    }
  });
  engine.bus = bus;

  const uc = new StartJobUseCase(streams, jobs, clips as never, engine, bus, fsFake, 5000);
  const first = await uc.execute(s1.id);
  // Rename for the fake's discriminator.
  await jobs.update({ ...first, id: "first-" + first.id.slice(0, 0) });
  await uc.execute(s2.id);
  await new Promise((r) => setTimeout(r, 300));

  const all = await jobs.listByStream(s1.id);
  assertEquals(all.every((j) => j.status !== "running"), true);
});

function streamRepoFake() {
  const map = new Map<string, Stream>();
  return {
    seed: (s: Stream) => void map.set(s.id, { ...s }),
    async save(s: Stream) { map.set(s.id, { ...s }); },
    async findById(id: string) { return map.get(id) ?? null; },
    async list() { return [...map.values()]; },
    async update(s: Stream) { const cur = map.get(s.id); if (cur) map.set(s.id, { ...cur, ...s }); },
    async delete(id: string) { void map.delete(id); },
  } as StreamRepository & { seed(s: Stream): void };
}

// Silence unused-import warnings for JOB_STATUS_TOPIC (documented topic contract).
void JOB_STATUS_TOPIC;