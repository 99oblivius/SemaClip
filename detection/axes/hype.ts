/**
 * Hype axis detector (Phase 1 — the first real axis).
 *
 * Pattern (ARCHITECTURE.md §3.1): aligned excitement across modalities —
 * sharp onset, sustained burst, recovery. v2 signals: chat velocity +
 * emote density + caps ratio, corroborated by RMS energy. Voice pitch is
 * 0 until transcription prosody exists (Phase 3) — honest absence, not fake.
 *
 * Detection: composite excitement E(t) per second; candidates are contiguous
 * regions where E(t) > threshold(t) with a minimum duration; peak = argmax;
 * score = excess over threshold, calibrated to 0-1. Overlapping candidates
 * are pruned score-first.
 */
import type { AxisDetector, Candidate, FeatureTable, Baselines, Regime } from "../types.ts";

export interface HypeOptions {
  minDurationSec: number;
  maxDurationSec: number;
  wVelocity: number;
  wEmote: number;
  wCaps: number;
  wAudio: number;
  scoreGain: number;
  prePadSec: number;
  tailSec: number;
  minScore: number;
}

const DEFAULTS: HypeOptions = {
  minDurationSec: 4,
  maxDurationSec: 45,
  wVelocity: 1.0,
  wEmote: 1.4,
  wCaps: 0.5,
  wAudio: 0.6,
  scoreGain: 2.5,
  prePadSec: 5,
  tailSec: 6,
  minScore: 0.25,
};

export class HypeDetector implements AxisDetector {
  readonly axis = "hype";
  constructor(private readonly opts: HypeOptions = DEFAULTS) {}

  detect(features: FeatureTable, baselines: Baselines, _regimes: Regime[]): Candidate[] {
    if (!features.chat && !features.audio) return [];
    const n = features.durationSec;

    // Velocity uses an ABSOLUTE scale (saturating at SATURATION_VELOCITY msg/s),
    // not max-normalization: with max-normalization, a single message in an
    // otherwise-dead stream reads as full velocity — every region qualifies.
    // Emote density is similarly capped (weighted mass per second).
    const E = new Float32Array(n);
    for (let s = 0; s < n; s++) {
      const chat = features.chat?.[s];
      const audio = features.audio?.[s];
      let e = 0;
      if (chat) {
        e += this.opts.wVelocity * saturate(chat.velocity, SATURATION_VELOCITY);
        e += this.opts.wEmote * saturate(chat.emoteDensity, SATURATION_EMOTE);
        e += this.opts.wCaps * chat.capsRatio;
      }
      if (audio) e += this.opts.wAudio * clamp01(audio.rms * 3);
      E[s] = e;
    }

    const regions = this.findRegions(E, baselines);
    const candidates: Candidate[] = [];
    for (const [start, end] of regions) {
      const c = this.buildCandidate(features, E, baselines, start, end);
      if (c) candidates.push(c);
    }

    // Score-desc, prune overlaps, keep the strongest non-overlapping set.
    candidates.sort((a, b) => b.score - a.score);
    const kept: Candidate[] = [];
    for (const c of candidates) {
      if (!kept.some((k) => c.start < k.end && c.end > k.start)) kept.push(c);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  /** Contiguous above-threshold regions closed by `tailSec` of quiet. */
  private findRegions(E: Float32Array, baselines: Baselines): Array<[number, number]> {
    const regions: Array<[number, number]> = [];
    let regionStart: number | null = null;
    let quietRun = 0;
    for (let s = 0; s < E.length; s++) {
      const over = E[s]! > baselines.threshold(s) && E[s]! > 0.15;
      if (over) {
        if (regionStart === null) regionStart = s;
        quietRun = 0;
      } else if (regionStart !== null) {
        quietRun++;
        if (quietRun >= this.opts.tailSec) {
          regions.push([regionStart, s - quietRun]);
          regionStart = null;
          quietRun = 0;
        }
      }
    }
    if (regionStart !== null) regions.push([regionStart, E.length - 1]);
    return regions;
  }

  private buildCandidate(
    features: FeatureTable,
    E: Float32Array,
    baselines: Baselines,
    start: number,
    end: number,
  ): Candidate | null {
    const dur = end - start;
    if (dur < this.opts.minDurationSec) return null;

    let peak = start;
    for (let s = start; s <= end; s++) {
      if (E[s]! > E[peak]!) peak = s;
    }
    const peakE = E[peak]!;
    const excess = peakE - baselines.threshold(peak);
    // Smooth monotone mapping excess → score. Linear gain clamped at 0.4
    // excess saturated half the candidates to 1.00 on dense chat (measured:
    // p50 score = 1.00 across 121 regions) — ties made top-N ranking
    // arbitrary. excess/(excess + 0.5) discriminates across the full range
    // while staying 0-1.
    const score = excess / (excess + 0.5);
    if (score < this.opts.minScore) return null;

    const chat = features.chat?.[peak];
    const audio = features.audio?.[peak];
    const chatE = chat
      ? saturate(chat.velocity, SATURATION_VELOCITY) * 0.7 + saturate(chat.emoteDensity, SATURATION_EMOTE) * 0.3
      : 0;
    const audioE = audio ? clamp01(audio.rms * 3) : 0;
    // Coverage: seconds in [start,end] whose E is over threshold — the burst's
    // actual footprint, not the padded window.
    let covered = 0;
    for (let s = start; s <= end; s++) {
      if (E[s]! > baselines.threshold(s) && E[s]! > 0.15) covered++;
    }
    const speechCoverage = covered / Math.max(1, end - start + 1);
    // Justification names the modalities that actually fired — never cites a
    // silent modality (honesty rule).
    const drivers = [
      chat && chatE > 0.1 ? `chat excitement ${chatE.toFixed(2)}` : null,
      audio && audioE > 0.1 ? `audio energy ${audioE.toFixed(2)}` : null,
    ].filter((x) => x !== null);
    const driverLabel = drivers.length > 0 ? drivers.join(" + ") : `excitement ${peakE.toFixed(2)}`;
    return {
      axis: this.axis,
      start: Math.max(0, start - this.opts.prePadSec),
      end: Math.min(end + this.opts.tailSec, features.durationSec - 1),
      peak,
      score,
      signals: {
        chatExcitement: clamp01(chatE),
        emoteVelocity: clamp01(chat ? saturate(chat.emoteDensity, SATURATION_EMOTE) : 0),
        audioEnergy: audioE,
        speechCoverage: clamp01(speechCoverage),
      },
      justification: `${drivers.length > 0 ? "Burst" : "Activity"} ${dur}s — ${driverLabel} vs threshold ${baselines.threshold(peak).toFixed(2)}`,
    };
  }
}

function saturate(v: number, sat: number): number {
  return clamp01(v / sat);
}
function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}

/**
 * Absolute saturation scales. Twitch chat in a hype burst reaches 10-50+
 * msgs/s on big channels; 10/s ≈ full excitement. Small channels (2 chatters)
 * still cross the threshold via the local baseline, not the scale.
 */
const SATURATION_VELOCITY = 10;
const SATURATION_EMOTE = 8;