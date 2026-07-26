import type { Job, JobConfig, JobStatus } from "shared/types";
import { generateUuid } from "@/infrastructure/uuid.ts";

export interface NewJobInput {
  streamId: string;
  config?: JobConfig | undefined;
}

export function createJob(input: NewJobInput, position: number): Job {
  return {
    id: generateUuid(),
    streamId: input.streamId,
    status: "queued",
    position,
    startedAt: null,
    completedAt: null,
    error: null,
    config: input.config ?? {},
  };
}

/** Lifecycle transitions — stable domain concepts, multiple call sites. */
export function start(job: Job): Job {
  return { ...job, status: "running", startedAt: new Date().toISOString() };
}

export function complete(job: Job): Job {
  return { ...job, status: "completed", completedAt: new Date().toISOString() };
}

export function fail(job: Job, error: string): Job {
  return { ...job, status: "failed", completedAt: new Date().toISOString(), error };
}

export function cancel(job: Job): Job {
  return { ...job, status: "cancelled", completedAt: new Date().toISOString() };
}

const TERMINAL: Record<JobStatus, boolean> = {
  queued: false,
  running: false,
  completed: true,
  failed: true,
  cancelled: true,
};
export function isTerminal(status: JobStatus): boolean {
  return TERMINAL[status] ?? false;
}
