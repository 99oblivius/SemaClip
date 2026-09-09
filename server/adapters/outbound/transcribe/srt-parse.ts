/** SRT parsing for the transcript endpoint (B2). Inverse of srt.ts (write side). */

export interface SrtCue {
  index: number;
  /** Start time in seconds (VOD-relative). */
  start: number;
  /** End time in seconds. */
  end: number;
  text: string;
}

/** 00:01:02,400 → 62.4. Anchored at the start; trailing content (e.g. SRT
 *  position coordinates "X1:… " after the end timestamp) is ignored.
 *  Returns NaN on malformed input (caller skips). */
export function srtTimestampToSeconds(ts: string): number {
  const m = ts.match(/^(\d{2}):(\d{2}):(\d{2})[,.](\d{3})/);
  if (!m) return NaN;
  const h = m[1]!, min = m[2]!, s = m[3]!, ms = m[4]!;
  return Number(h) * 3600 + Number(min) * 60 + Number(s) + Number(ms) / 1000;
}

/**
 * Parses SRT into cues. Tolerates: blank-line variations, multi-line cue text
 * (joined with a space), BOM, CRLF, and coordinate/position lines after the
 * timestamp (dropped). Cues with unparseable timestamps are skipped — the
 * caption editor renders what exists rather than failing the whole track.
 */
export function parseSrt(content: string): SrtCue[] {
  const body = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  const blocks = body.split(/\n\n+/);
  const cues: SrtCue[] = [];
  let autoIndex = 1;

  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trimEnd()).filter((l) => l !== "");
    if (lines.length === 0) continue;

    // Find the timestamp line — normally lines[1], but index numbers can be
    // missing after hand edits, so scan for the --> pattern instead.
    const tsIdx = lines.findIndex((l) => l.includes("-->"));
    if (tsIdx === -1) continue;
    const tsLine = lines[tsIdx]!;
    const parts = tsLine.split("-->");
    const startRaw = parts[0]!.trim();
    const endRaw = parts[1]!.trim();
    const start = srtTimestampToSeconds(startRaw);
    const end = srtTimestampToSeconds(endRaw);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;

    const text = lines
      .slice(tsIdx + 1)
      .filter((l) => !l.startsWith("X1:") && !/^\d+:\d+:\d+[.,]\d+$/.test(l))
      .join(" ")
      .trim();
    if (!text) continue;

    cues.push({ index: autoIndex++, start, end, text });
  }
  return cues;
}