import type { Clip, Axis, ClipSignals } from "shared/types";
import { generateUuid } from "@/infrastructure/uuid.ts";

/** Candidate emitted by the engine before endpoint resolution + ranking. */
export interface ClipCandidate {
  jobId: string;
  axis: Axis;
  start: number;
  end: number;
  score: number;
  signals: ClipSignals;
}

export interface NewClipInput {
  jobId: string;
  streamId: string;
  axis: Axis;
  score: number;
  startTime: number;
  endTime: number;
  peakTime: number;
  justification: string | null;
  signals?: ClipSignals | null;
}

export function createClip(input: NewClipInput, rank: number | null): Clip {
  return {
    id: generateUuid(),
    jobId: input.jobId,
    streamId: input.streamId,
    axis: input.axis,
    score: input.score,
    startTime: input.startTime,
    endTime: input.endTime,
    peakTime: input.peakTime,
    justification: input.justification,
    rank,
    exported: false,
    exportPath: null,
    rejected: false,
    signals: input.signals ?? null,
  };
}

export function rank(clip: Clip, rankValue: number): Clip {
  return { ...clip, rank: rankValue };
}

export function reject(clip: Clip): Clip {
  return { ...clip, rejected: true };
}

export function markExported(clip: Clip, exportPath: string): Clip {
  return { ...clip, exported: true, exportPath };
}

export function duration(clip: Clip): number {
  return clip.endTime - clip.startTime;
}
