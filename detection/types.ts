/**
 * detection/ shared types — per-second feature tables and detector outputs.
 *
 * The detection package is pure TypeScript over numeric arrays. Heavy lifting
 * (decode, transcribe) happens in native runtimes (whisper.cpp) before this
 * code runs; everything here is unit-testable with no models.
 */

// ── Chat ──────────────────────────────────────────────────────

export interface ChatEvent {
  /** Offset from VOD start, seconds. */
  t: number;
  user: string;
  body: string;
  /** Message is a bare emote (single emote token) — strong signal unit. */
  isEmoteOnly: boolean;
  bitsSpent: number;
}

// ── Per-second feature table (the joint space for segmentation) ──

export interface ChatFeaturesSec {
  /** Messages this second. */
  velocity: number;
  /** Emote-weighted excitement sum this second (0..~unbounded, normalized later). */
  emoteDensity: number;
  /** Unique chatters this second. */
  uniqueUsers: number;
  /** Proportion of characters in ALL-CAPS words, 0-1. */
  capsRatio: number;
  /** Bits spent this second (donation events). */
  bits: number;
}

export interface AudioFeaturesSec {
  /** RMS energy 0-1 (per-second from ffmpeg-extracted PCM). */
  rms: number;
  /** Speech probability estimate 0-1 (from whisper segment coverage or VAD). */
  speechProb: number;
}

export interface TranscriptSegment {
  start: number;
  end: number;
  text: string;
}

export interface TranscriptFeaturesSec {
  /** Words per second from the transcript overlapping this second. */
  wordsPerSec: number;
}

/** One row per second of the VOD. Missing modalities are null arrays. */
export interface FeatureTable {
  durationSec: number;
  chat: ChatFeaturesSec[] | null;
  audio: AudioFeaturesSec[] | null;
  transcript: TranscriptSegment[] | null;
}

// ── Segmentation ──────────────────────────────────────────────

export const REGIME_TYPES = ["gameplay", "chatting", "hype", "lull", "collab", "tilt"] as const;
export type RegimeType = (typeof REGIME_TYPES)[number];

export interface Regime {
  start: number;
  end: number;
  type: RegimeType;
}

// ── Axis detection ────────────────────────────────────────────

/** Per-signal evidence for a candidate (rendered as the clip's signal bars). */
export interface ClipSignals {
  chatExcitement: number;
  emoteVelocity: number;
  /** Audio RMS energy at the peak second (0-1). */
  audioEnergy: number;
  /** Fraction of the clip window covered by speech (0-1). */
  speechCoverage: number;
}

export interface Candidate {
  axis: string;
  start: number;
  end: number;
  peak: number;
  score: number;
  signals: ClipSignals;
  justification: string | null;
}

/** One detector per axis; identical interface. */
export interface AxisDetector {
  readonly axis: string;
  detect(features: FeatureTable, baselines: Baselines, regimes: Regime[]): Candidate[];
}

// ── Baselines ─────────────────────────────────────────────────

export interface Baselines {
  /** Rolling median of the excitement signal (per second index) — the local
   *  interaction floor. Chat activity levels drift massively within one VOD
   *  (measured: +195% over 4h on a subathon), so outlier detection must be
   *  relative to this moving floor, never to absolute scales. */
  local: Float32Array;
  /** Rolling p75−median spread of the same window — how "spiky" chat locally
   *  is. A quiet stretch's small bump and a raid's spike can both be outliers
   *  under their own regime's spread. */
  spread: Float32Array;
  /** Full-VOD median. */
  global: number;
  /**
   * threshold(s) = floor + k·spread (k = outlierK, min-spread guarded).
   * Validated on a dense 4h subathon fixture: detects all hand-identified
   * organic bursts, ignores gift-train floods, marks ~8% of seconds over
   * (vs 35% under a fixed gate).
   */
  threshold(s: number): number;
}

export interface BaselineOptions {
  /** Local window seconds for floor/spread tracking. */
  localWindowSec: number;
  /** Outlier multiple: threshold = floor + k·spread. */
  outlierK: number;
  /** Lower bound on spread so a perfectly flat region still admits outliers. */
  minSpread: number;
}