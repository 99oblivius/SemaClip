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
  /** Null for a manual clip — no engine job exists for a hand-made segment. */
  jobId: string | null;
  streamId: string;
  /** Null for a manual clip — there is no engine axis. */
  axis: Axis | null;
  /** Null for a manual clip — it is not ranked. */
  score: number | null;
  startTime: number;
  endTime: number;
  peakTime: number;
  justification: string | null;
  /** The user's own name for the clip. Null = unnamed. Never written into `axis`, which is an
   *  engine enum that validation, filtering and feedback all depend on. */
  title?: string | null;
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
    title: input.title ?? null,
    rank,
    exported: false,
    exportPath: null,
    rejected: false,
    signals: input.signals ?? null,
  };
}

/**
 * A clip made BY HAND: no job, no axis, no score, no signals, no rank.
 *
 * Every one of those is `null` rather than a default, and that is the point. There is no
 * engine evidence behind a hand-cut segment, so anything filled in would be fabricated —
 * and a `score: 0` would render as "0.00" in the inspector, presenting a deliberate edit as
 * a badly-ranked detection. The absence is the honest record that a human drew this.
 *
 * `peakTime` is the start: a manual clip has no detected peak, and the start is the only
 * endpoint the user actually chose (the end is computed from what follows).
 */
export function createManualClip(input: { streamId: string; startTime: number; endTime: number }): Clip {
  return createClip(
    {
      jobId: null,
      streamId: input.streamId,
      axis: null,
      score: null,
      startTime: input.startTime,
      endTime: input.endTime,
      peakTime: input.startTime,
      justification: null,
      signals: null,
    },
    null,
  );
}

/**
 * Where a clip created at `startTime` should end, given the clips that already exist.
 *
 * The rule the owner asked for: it ends at the NEXT CLIP'S START, or the end of the video.
 * "Next" is the first clip that starts strictly after the new clip's start — a clip starting
 * exactly at `startTime` is where we already are, not what follows, and using it would
 * produce a zero-length clip.
 *
 * Pure and exported so the boundary cases (no later clip, a later clip that starts before
 * the end of the VOD, a clip exactly at the playhead) are testable without a server.
 */
export function clipEndFrom(input: {
  startTime: number;
  duration: number | null;
  existingStartTimes: number[];
  fallbackLength?: number;
}): number {
  const later = input.existingStartTimes
    .filter((t) => t > input.startTime)
    .sort((a, b) => a - b);

  // A later clip's start bounds the new clip. Take the earliest one, but never a start that
  // would make the clip degenerate — 0.5s is the same floor UpdateClipUseCase enforces.
  if (later.length > 0 && later[0]! - input.startTime >= 0.5) {
    return later[0]!;
  }

  // Nothing later: run to the end of the video.
  if (input.duration !== null && input.duration - input.startTime >= 0.5) {
    return input.duration;
  }

  // Neither a later clip nor enough video left (the playhead is at/near the end). There is no
  // honest "next boundary" here, so give the clip a usable default length rather than
  // refusing — and let the UI's trim fix it.
  return input.startTime + (input.fallbackLength ?? 30);
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

/**
 * Drop the `exported` mark.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * `exported` + `exportPath` record that a FILE was produced, and the owner needs that mark to stop
 * claiming something that is no longer true:
 *
 *  - removing a clip from the export list meant the user had not sent it, so a `✓ exported` badge
 *    next to it stated the opposite of the user's own action;
 *  - re-sending a clip for export means the file is being REPLACED, and leaving the old mark up while
 *    the new encode runs shows a finished state for work that has not happened yet.
 *
 * Both cases are the same rule: the mark belongs to the LAST ATTEMPT, and a new attempt (or a
 * withdrawal of the request) invalidates it. Deliberately does NOT delete the file — the file is the
 * user's, and deleting it on a list edit would destroy an export they still have.
 */
export function markNotExported(clip: Clip): Clip {
  return { ...clip, exported: false, exportPath: null };
}

export function duration(clip: Clip): number {
  return clip.endTime - clip.startTime;
}
