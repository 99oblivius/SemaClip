/**
 * Audio signal extraction: 16 kHz mono PCM (Int16) → per-second RMS + speech
 * probability estimate. Consumes the ffmpeg-extracted audio buffer.
 */
import type { AudioFeaturesSec } from "../types.ts";

/**
 * Compute per-second RMS from 16-bit PCM mono samples.
 * @param samples Int16 PCM at sampleRate
 */
export function audioFeatures(samples: Int16Array, sampleRate: number): AudioFeaturesSec[] {
  const durationSec = Math.ceil(samples.length / sampleRate);
  const out: AudioFeaturesSec[] = Array.from({ length: durationSec }, () => ({ rms: 0, speechProb: 0 }));
  for (let s = 0; s < durationSec; s++) {
    const start = s * sampleRate;
    const end = Math.min(samples.length, start + sampleRate);
    let sumSq = 0;
    for (let i = start; i < end; i++) {
      const v = samples[i]! / 32768;
      sumSq += v * v;
    }
    const n = Math.max(1, end - start);
    out[s]!.rms = Math.sqrt(sumSq / n);
    // speechProb: v2 refines via VAD; for now energy-based placeholder is
    // NOT emitted as speech — it stays 0 and transcription segments override.
    out[s]!.speechProb = 0;
  }
  return out;
}

/** Overlay whisper transcript segments onto speechProb per second. */
export function applyTranscriptCoverage(
  audio: AudioFeaturesSec[],
  segments: Array<{ start: number; end: number }>,
): void {
  for (const seg of segments) {
    const start = Math.max(0, Math.floor(seg.start));
    const end = Math.min(audio.length - 1, Math.ceil(seg.end));
    for (let s = start; s <= end; s++) {
      if (audio[s]) audio[s]!.speechProb = 1;
    }
  }
}