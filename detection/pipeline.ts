/**
 * Pipeline orchestrator: FeatureTable → candidates → ranked clips.
 * Runs each axis detector, merges candidates, applies axis-relative ranking
 * with a diversity constraint, resolves endpoints (Phase 1: fixed-width cap
 * + tail; Phase 3: recovery/topic-boundary refinement), emits EngineEvents.
 */
import type { AxisDetector, Candidate, FeatureTable, Baselines, Regime, ClipSignals } from "./types.ts";
import type { EngineEvent } from "../shared/types.ts";

export interface PipelineOptions {
  maxClips: number;
  /** Diversity: min slots guaranteed per represented axis before global fill. */
  minSlotsPerAxis: number;
}

const DEFAULT_OPTS: PipelineOptions = { maxClips: 50, minSlotsPerAxis: 1 };

export function runDetection(
  features: FeatureTable,
  baselines: Baselines,
  regimes: Regime[],
  detectors: AxisDetector[],
  opts: PipelineOptions = DEFAULT_OPTS,
): Candidate[] {
  const all: Candidate[] = [];
  for (const d of detectors) {
    all.push(...d.detect(features, baselines, regimes));
  }
  return rank(all, opts);
}

/**
 * Axis-relative ranking (v1 ARCH §9 kept): percentile within own axis +
 * outlier boost, then diversity-constrained final ordering.
 */
export function rank(candidates: Candidate[], opts: PipelineOptions = DEFAULT_OPTS): Candidate[] {
  return rankInternal(candidates, opts);
}

function rankInternal(candidates: Candidate[], opts: PipelineOptions): Candidate[] {
  const byAxis = new Map<string, Candidate[]>();
  for (const c of candidates) {
    const list = byAxis.get(c.axis) ?? [];
    list.push(c);
    byAxis.set(c.axis, list);
  }

  // Percentile + z-boost within axis, blended with the absolute excess score.
  // Percentile alone saturates: with 100+ candidates per axis (dense chat),
  // the top quintile all reads 1.00 and rank order within it is lost. The
  // absolute score (excess × gain, already 0-1) preserves magnitude; the
  // percentile preserves "best of this stream" context. 50/50 keeps a
  // moderate burst in a quiet stream competitive with a huge burst in a
  // wild one — which is the point of axis-relative ranking.
  for (const [, list] of byAxis) {
    const scores = list.map((c) => c.score);
    const mean = scores.reduce((a, b) => a + b, 0) / Math.max(1, list.length);
    const std = Math.sqrt(scores.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, list.length));
    for (const c of list) {
      const pct = list.filter((o) => o.score <= c.score).length / list.length;
      const z = std > 0 ? (c.score - mean) / std : 0;
      const relative = Math.min(1, pct * (1 + Math.max(0, z) * 0.1));
      c.score = clamp01(0.5 * relative + 0.5 * c.score);
    }
  }

  // Diversity: guarantee min slots per axis, then fill by global rank.
  const sorted = [...candidates].sort((a, b) => b.score - a.score);
  const result: Candidate[] = [];
  const perAxisCount = new Map<string, number>();
  const seen = new Set<string>();
  for (const c of sorted) {
    const axisCount = perAxisCount.get(c.axis) ?? 0;
    if (axisCount < opts.minSlotsPerAxis) {
      result.push(c);
      seen.add(c.axis);
      perAxisCount.set(c.axis, axisCount + 1);
    }
  }
  for (const c of sorted) {
    if (result.length >= opts.maxClips) break;
    if (result.includes(c)) continue;
    result.push(c);
    perAxisCount.set(c.axis, (perAxisCount.get(c.axis) ?? 0) + 1);
  }
  return result.slice(0, opts.maxClips);
}

/** Candidate → EngineEvent['clip'] payload shape for the job pipeline. */
export function candidateToClipEvent(jobId: string, c: Candidate, id: string): EngineEvent {
  return {
    type: "clip",
    jobId,
    id,
    axis: c.axis as "hype" | "humor" | "skill" | "awkward" | "emotional" | "tension",
    start: c.start,
    end: c.end,
    peak: c.peak,
    score: c.score,
    justification: c.justification,
    signals: c.signals,
  };
}

export type { ClipSignals };

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}