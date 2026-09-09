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
  voicePitch: number;
  emoteVelocity: number;
  lurkerActivation: number;
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
  /** Rolling 30-minute median of the excitement signal (per second index). */
  local: Float32Array;
  /** Full-VOD median. */
  global: number;
  /** threshold(s) = max(local[s], global * 0.5) — ARCH §7.5. */
  threshold(s: number): number;
}

export interface BaselineOptions {
  /** Local window seconds. */
  localWindowSec: number;
  /** Global floor multiplier. */
  globalFloor: number;
}