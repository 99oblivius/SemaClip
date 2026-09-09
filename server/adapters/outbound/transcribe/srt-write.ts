/** SRT regeneration from parsed cues (B2 write-back). Inverse of srt-parse.ts. */

import type { SrtCue } from "./srt-parse.ts";

/** 62.4 → 00:01:02,400 (comma-millis, SRT standard). */
function secondsToSrtTimestamp(sec: number): string {
  const clamped = Math.max(0, sec);
  const h = Math.floor(clamped / 3600);
  const m = Math.floor((clamped % 3600) / 60);
  const s = Math.floor(clamped % 60);
  const ms = Math.round((clamped - Math.floor(clamped)) * 1000);
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(ms, 3)}`;
}

/**
 * Serializes cues back to SRT. Cue indexes are renumbered 1..n (gap-free) —
 * edits may come from a filtered view, so original numbering is not preserved.
 * Multi-line text is re-joined as a single line (SRT renders either way).
 */
export function cuesToSrt(cues: SrtCue[]): string {
  return cues
    .map((cue, i) => {
      const ts = `${secondsToSrtTimestamp(cue.start)} --> ${secondsToSrtTimestamp(cue.end)}`;
      return `${i + 1}\n${ts}\n${cue.text.replace(/\n+/g, " ").trim()}`;
    })
    .join("\n\n") + "\n";
}