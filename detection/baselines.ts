/**
 * Multi-timescale baselines (ARCHITECTURE.md §4.1 in v2, was v1 §7.5).
 * threshold(s) = max(local rolling median over localWindowSec, global median × floor).
 * Kept as plain percentile math — no Kalman (DECISIONS.md).
 */
import type { Baselines, BaselineOptions } from "./types.ts";

export function computeBaselines(
  excitement: Float32Array,
  durationSec: number,
  opts: BaselineOptions = { localWindowSec: 1800, globalFloor: 0.5 },
): Baselines {
  const local = new Float32Array(durationSec);
  const global = median([...excitement]);

  const half = Math.floor(opts.localWindowSec / 2);
  for (let s = 0; s < durationSec; s++) {
    const from = Math.max(0, s - half);
    const to = Math.min(durationSec, s + half);
    const window = excitement.slice(from, to);
    local[s] = median(window);
  }

  return {
    local,
    global,
    threshold(s: number): number {
      return Math.max(local[s] ?? 0, global * opts.globalFloor);
    },
  };
}

function median(values: ArrayLike<number>): number {
  const n = values.length;
  if (n === 0) return 0;
  const arr = Array.from(values).sort((a, b) => a - b);
  const mid = n >> 1;
  return n % 2 === 1 ? arr[mid]! : (arr[mid! - 1]! + arr[mid]!) / 2;
}