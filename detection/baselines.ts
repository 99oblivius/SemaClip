/**
 * Adaptive-floor baselines (ARCHITECTURE.md §4.1 v2).
 *
 * threshold(s) = floor(s) + k·spread(s), both tracked over a trailing window:
 * - floor = rolling median of E — the local interaction level. Chat activity
 *   drifts massively within one VOD (measured +195% over 4h on a subathon);
 *   fixed thresholds flag the whole stream or nothing.
 * - spread = rolling (p75 − median) — local spikiness. A small bump in a dead
 *   chat and a spike mid-raid are both outliers under their own regime.
 *
 * Validated against hand-identified organic bursts on a dense 4h subathon
 * chat: 6/6 detected, gift-train floods not flagged, 8% of seconds over
 * threshold (vs 35% under the old fixed median×floor gate).
 *
 * O(n·window) in the worst case; window is 300s and n is per-second — bounded
 * and fast in practice (4h VOD computes in well under a second).
 */
import type { Baselines, BaselineOptions } from "./types.ts";

const DEFAULTS: BaselineOptions = {
  localWindowSec: 300,
  outlierK: 3,
  minSpread: 0.02,
};

export function computeBaselines(
  excitement: Float32Array,
  durationSec: number,
  opts: BaselineOptions = DEFAULTS,
): Baselines {
  const o = { ...DEFAULTS, ...opts };
  const n = Math.min(durationSec, excitement.length);
  const floor = new Float32Array(n);
  const spread = new Float32Array(n);

  for (let s = 0; s < n; s++) {
    const from = Math.max(0, s - o.localWindowSec);
    const window = excitement.subarray(from, s + 1);
    const med = median(window);
    floor[s] = med;
    spread[s] = Math.max(percentile(window, 75) - med, o.minSpread);
  }

  const global = median(excitement.subarray(0, n));

  return {
    local: floor,
    spread,
    global,
    threshold(s: number): number {
      return floor[s]! + o.outlierK * spread[s]!;
    },
  };
}

function median(values: ArrayLike<number>): number {
  return percentile(values, 50);
}

function percentile(values: ArrayLike<number>, p: number): number {
  const n = values.length;
  if (n === 0) return 0;
  const arr = Array.from(values).sort((a, b) => a - b);
  const idx = (p / 100) * (n - 1);
  const lo = Math.floor(idx);
  const hi = Math.ceil(idx);
  if (lo === hi) return arr[lo]!;
  return arr[lo]! + (arr[hi]! - arr[lo]!) * (idx - lo);
}