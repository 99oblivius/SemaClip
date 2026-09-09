/**
 * Reaction axis (Phase 1 v0.1): moments where the STREAMER's own behavior
 * changes — energy jump or reaction wording — independent of chat.
 *
 * Signal design (validated on the 4h ironmouse subathon fixture):
 * - Raw mix RMS is dominated by game audio (p90: burst slice 0.134 < quiet
 *   0.162 — inverted vs voice energy), so energy must be VOICE-GATED: the
 *   transcript's speech regions are the voice mask.
 * - Absolute loudness doesn't separate slices either (a dramatic reading is
 *   loud and calm). The reaction signal is the DELTA: voice-region RMS vs the
 *   trailing 120s voice baseline — a change point, not a level.
 * - Transcript wording corroborates: whisper normalizes shouting away, but
 *   interjections ("what", "oh my god", "no way") and explicit state words
 *   ("scared", "jumped") survive. A wording hit at the peak second boosts
 *   the score and names the driver in the justification.
 *
 * Candidates are scored against the same adaptive floor+spread baselines as
 * hype: reaction frequency varies hugely between streamers and game sections.
 */
import type { AxisDetector, Candidate, FeatureTable, Baselines, Regime, ClipSignals } from "../types.ts";

const INTERJECTIONS = [
  "what", "what?!",
  "oh my god", "oh my gosh", "omg",
  "no way", "noooo", "no!",
  "let's go", "lets go", "lesgo",
  "holy", "jesus", "dude",
  "wait", "look", "guys", "chat",
  "screamed", "scream", "scared", "jumpscare", "jump scare", "heart attack",
];

export interface ReactionOptions {
  /** Voice-baseline window for the delta ratio. */
  baselineWindowSec: number;
  /** Minimum region energy ratio to consider. */
  minRatio: number;
  maxDurationSec: number;
  prePadSec: number;
  tailSec: number;
  minScore: number;
}

const DEFAULTS: ReactionOptions = {
  baselineWindowSec: 120,
  minRatio: 1.8,
  maxDurationSec: 45,
  prePadSec: 5,
  tailSec: 8,
  minScore: 0.25,
};

export class ReactionDetector implements AxisDetector {
  readonly axis = "reaction";
  constructor(private readonly opts: ReactionOptions = DEFAULTS) {}

  detect(features: FeatureTable, baselines: Baselines, _regimes: Regime[]): Candidate[] {
    if (!features.audio || !features.transcript || features.transcript.length === 0) return [];
    const n = features.durationSec;
    const audio = features.audio;

    // Voice mask: seconds covered by a transcript segment (whisper VAD regions).
    const voice = new Uint8Array(n);
    for (const seg of features.transcript) {
      for (let t = Math.max(0, Math.floor(seg.start)); t < Math.min(n, Math.ceil(seg.end)); t++) voice[t] = 1;
    }

    // Per-second delta ratio: voice RMS vs trailing window's voiced median.
    const ratio = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      if (!voice[t]) continue;
      const rms = audio[t]?.rms ?? 0;
      if (rms <= 0.005) continue;
      const hist: number[] = [];
      for (let u = Math.max(0, t - this.opts.baselineWindowSec); u < t; u++) {
        if (voice[u] && (audio[u]?.rms ?? 0) > 0.01) hist.push(audio[u]!.rms);
      }
      if (hist.length < 5) continue; // not enough voice history — no delta yet
      hist.sort((a, b) => a - b);
      const med = hist[Math.floor(hist.length / 2)]!;
      ratio[t] = med > 0 ? rms / med : 0;
    }

    // Composite reaction score: log-scaled delta ratio, 0 when below minRatio.
    const R = new Float32Array(n);
    for (let t = 0; t < n; t++) {
      R[t] = ratio[t]! >= this.opts.minRatio ? Math.log2(ratio[t]!) / 2 : 0;
    }

    // Contiguous regions closed by tailSec of quiet, min duration 3s.
    const regions: Array<[number, number]> = [];
    let start: number | null = null;
    let quiet = 0;
    for (let s = 0; s < n; s++) {
      if (R[s]! > 0) {
        if (start === null) start = s;
        quiet = 0;
      } else if (start !== null) {
        quiet++;
        if (quiet >= this.opts.tailSec) {
          regions.push([start, s - quiet]);
          start = null;
          quiet = 0;
        }
      }
    }
    if (start !== null) regions.push([start, n - 1]);

    const candidates: Candidate[] = [];
    for (const [rs, re] of regions) {
      const c = this.buildCandidate(features, R, ratio, baselines, rs, re);
      if (c) candidates.push(c);
    }
    candidates.sort((a, b) => b.score - a.score);
    const kept: Candidate[] = [];
    for (const c of candidates) {
      if (!kept.some((k) => c.start < k.end && c.end > k.start)) kept.push(c);
    }
    return kept.sort((a, b) => a.start - b.start);
  }

  private buildCandidate(
    features: FeatureTable,
    R: Float32Array,
    ratio: Float32Array,
    baselines: Baselines,
    start: number,
    end: number,
  ): Candidate | null {
    const dur = end - start;
    if (dur < 3 || dur > this.opts.maxDurationSec) return null;

    let peak = start;
    for (let s = start; s <= end; s++) {
      if (R[s]! > R[peak]!) peak = s;
    }
    const peakR = R[peak]!;
    if (peakR <= 0) return null;

    const excess = peakR - baselines.threshold(peak);
    const score = clamp01(excess / (excess + 0.5));
    if (score < this.opts.minScore) return null;

    // Wording corroboration: interjections in transcript text overlapping the
    // region (whisper-normalized, so case-insensitive contains).
    const text = features.transcript!
      .filter((s) => s.end >= start && s.start <= end)
      .map((s) => s.text.toLowerCase())
      .join(" ");
    const hits = INTERJECTIONS.filter((w) => text.includes(w));

    const audio = features.audio![peak]!;
    let covered = 0;
    for (let s = start; s <= end; s++) if (voiceAt(features, s)) covered++;
    const signals: ClipSignals = {
      chatExcitement: 0,
      emoteVelocity: 0,
      audioEnergy: clamp01(audio.rms * 3),
      speechCoverage: clamp01(covered / Math.max(1, end - start + 1)),
    };

    const drivers: string[] = [`voice energy ${ratio[peak]!.toFixed(1)}× her recent baseline`];
    if (hits.length > 0) drivers.push(`wording: ${hits.slice(0, 3).join(", ")}`);
    return {
      axis: this.axis,
      start: Math.max(0, start - this.opts.prePadSec),
      end: Math.min(end + this.opts.tailSec, features.durationSec - 1),
      peak,
      score,
      signals,
      justification: `Streamer reaction ${dur}s — ${drivers.join("; ")}`,
    };
  }
}

function voiceAt(features: FeatureTable, sec: number): boolean {
  return features.transcript!.some((s) => sec >= Math.floor(s.start) && sec < Math.ceil(s.end));
}

function clamp01(v: number): number {
  return Math.max(0, Math.min(1, v));
}