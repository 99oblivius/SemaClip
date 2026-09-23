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
 * The longest a hand-made clip may be, in seconds.
 *
 * A manual clip is created from ONE click at the playhead: the end is inferred, not
 * chosen. Unbounded inference produced clips that ran to the end of the video (hours),
 * which is not a clip — it is the rest of the stream, and it made export and review
 * unusable. 60s is the owner's ceiling; the user can still trim shorter, and an
 * explicit `endTime` is still honoured up to this cap.
 */
export const MAX_MANUAL_CLIP_SECONDS = 60;

/**
 * Where a hand-made clip should end.
 *
 * Bounded by THREE things, and the tightest wins: the cap above, the next clip's
 * start (a manual clip must not swallow a neighbour), and the end of the video. When
 * there is no room for even a minimum-length clip the fallback still returns something
 * usable, because refusing to create a clip at the playhead is worse than one the user
 * has to trim.
 *
 * KNOWN GAP: nothing re-checks the floor downstream — `createClip` accepts any range it
 * is handed, and the manual path does not go through `UpdateClipUseCase`, which is where
 * the 0.5s rule lives. So the last branch can return an end barely past `startTime`. It
 * is reachable only when an existing clip starts within 0.5s of the playhead (see the
 * test of that name), and the trim UI is the remedy.
 */
export function clipEndFrom(input: {
  startTime: number;
  duration: number | null;
  existingStartTimes: number[];
  fallbackLength?: number;
  maxLength?: number;
}): number {
  const maxLength = input.maxLength ?? MAX_MANUAL_CLIP_SECONDS;
  /** The shortest clip worth creating; the same floor UpdateClipUseCase enforces. */
  const FLOOR = 0.5;
  const later = input.existingStartTimes
    .filter((t) => t > input.startTime)
    .sort((a, b) => a - b);

  // Every candidate end is collected, then the SMALLEST is taken. Written as a minimum
  // rather than as an if/else chain because the chain let a later clip's start win over
  // the cap (and vice versa) depending on the order of the branches.
  const candidates: number[] = [input.startTime + maxLength];

  // A later clip's start bounds the new clip, so it cannot overlap a neighbour. A start
  // closer than the floor cannot bound anything usable, so it is skipped rather than
  // producing a clip too short to keep.
  const next = later[0];
  if (next !== undefined && next - input.startTime >= FLOOR) candidates.push(next);

  if (input.duration !== null) {
    // The playhead is at (or within the floor of) the end of the video. The CAP is not a
    // source of video that does not exist, so it must not be used here: `min(cap, …)`
    // would happily return a 60s clip running past the end of a stream with 0.2s left.
    // There is no honest boundary, so a usable default length keeps the button working
    // and the trim UI is how the user fixes it.
    if (input.duration - input.startTime < FLOOR) {
      return input.startTime + (input.fallbackLength ?? 30);
    }
    candidates.push(input.duration);
  }

  return Math.min(...candidates);
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
