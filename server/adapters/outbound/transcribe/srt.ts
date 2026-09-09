/**
 * SRT generation from transcript segments (Phase 1 — the honest caption path).
 * The transcript comes from whisper segments; captions burn from this file.
 * Stored in stream_metadata under 'transcript_srt' (ExportClipUseCase reads it).
 */
import type { TranscriptSegment } from "../../../../detection/types.ts";

export interface SrtOptions {
  /** Max chars per cue before wrapping/splitting. */
  maxChars: number;
  /** Offset all times by this many seconds (chunk-relative transcripts). */
  offsetSec: number;
}

const DEFAULTS: SrtOptions = { maxChars: 84, offsetSec: 0 };

/** Segments → SRT string (VOD-absolute timestamps, 00:02:00,400 line format). */
export function toSrt(segments: TranscriptSegment[], opts: SrtOptions = DEFAULTS): string {
  const blocks: string[] = [];
  let idx = 1;
  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;
    for (const chunk of splitCue(text, opts.maxChars)) {
      const start = seg.start + opts.offsetSec;
      const end = Math.max(start + 0.4, seg.end + opts.offsetSec);
      blocks.push(`${idx}\n${srtTime(start)} --> ${srtTime(end)}\n${chunk}\n`);
      idx++;
    }
  }
  return blocks.join("\n");
}

/** Split long text across cues at word boundaries. */
function splitCue(text: string, maxChars: number): string[] {
  if (text.length <= maxChars) return [text];
  const words = text.split(/\s+/);
  const cues: string[] = [];
  let cur = "";
  for (const w of words) {
    if ((cur + " " + w).length > maxChars && cur) {
      cues.push(cur);
      cur = w;
    } else {
      cur = cur ? `${cur} ${w}` : w;
    }
  }
  if (cur) cues.push(cur);
  return cues;
}

/** 00:01:02,400 (SRT comma-millis). */
export function srtTime(sec: number): string {
  const s = Math.max(0, sec);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const whole = Math.floor(s % 60);
  const ms = Math.round((s - Math.floor(s)) * 1000);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(whole).padStart(2, "0")},${String(ms).padStart(3, "0")}`;
}