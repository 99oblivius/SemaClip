/**
 * Regime segmentation (Phase 2 scope: mechanical regime boundaries from the
 * composite excitement signal; Bayesian change-points stay Phase 3).
 *
 * Regimes classify stretches of the stream by local interaction level so
 * detectors judge outliers against their own regime and the timeline can
 * render boundaries:
 *  - lull:      floor ≈ silence — almost no chat or audio activity
 *  - gameplay:  low-moderate steady activity (game focus)
 *  - chatting:  elevated chat ratio with low audio (just-chatting segments)
 *  - hype:      top decile of the excitement distribution
 *
 * Classification uses rolling medians already computed for baselines, so
 * it adds one pass over E. Boundaries only change when the smoothed label
 * has been stable for minRunSec — no flicker at noise scale.
 */
import type { Regime, RegimeType } from "./types.ts";

export interface RegimeOptions {
  /** Min seconds for a contiguous label run to survive (anti-flicker). */
  minRunSec: number;
  /** Hype = top fraction of the smoothed excitement distribution. */
  hypeQuantile: number;
}

const DEFAULTS: RegimeOptions = { minRunSec: 60, hypeQuantile: 0.9 };

export function computeRegimes(
  chat: { velocity: number; emoteDensity: number }[] | null,
  audio: { rms: number }[] | null,
  excitement: Float32Array,
  durationSec: number,
  opts: RegimeOptions = DEFAULTS,
): Regime[] {
  if (durationSec <= 0) return [];
  const n = Math.min(durationSec, excitement.length);

  // Smoothed activity: 120s rolling median of E (same window family as
  // baselines) — regimes are minutes-scale, not spike-scale.
  const window = 120;
  const half = window >> 1;
  const smooth = new Float32Array(n);
  for (let s = 0; s < n; s++) {
    const lo = Math.max(0, s - half);
    const hi = Math.min(n, s + half + 1);
    const slice = Array.from(excitement.slice(lo, hi)).sort((a, b) => a - b);
    smooth[s] = slice[slice.length >> 1]!;
  }

  // Distribution cuts. hypeCut = the hypeQuantile-th percentile — seconds at
  // or above it are the top (1 - hypeQuantile) fraction. (q(1 - hypeQuantile)
  // was the inverted low cut: every quiet second scored "hype".)
  const sorted = Array.from(smooth).sort((a, b) => a - b);
  const q = (p: number): number => sorted[Math.min(n - 1, Math.floor(p * n))] ?? 0;
  const hypeCut = q(opts.hypeQuantile);
  const chatRatio = (s: number): number => {
    const c = chat?.[s];
    const a = audio?.[s];
    const chatA = c ? Math.min(1, c.velocity / 10) + Math.min(1, c.emoteDensity / 8) : 0;
    const audioA = a ? Math.min(1, a.rms * 3) : 0;
    return chatA + audioA === 0 ? 0.5 : chatA / (chatA + audioA);
  };

  // Label per second.
  const label: RegimeType[] = new Array(n);
  for (let s = 0; s < n; s++) {
    const e = smooth[s]!;
    if (e < q(0.05) && e < 0.01) label[s] = "lull";
    else if (e >= hypeCut && hypeCut > 0) label[s] = "hype";
    else if (chatRatio(s) > 0.7 && (audio?.[s]?.rms ?? 0) < 0.05) label[s] = "chatting";
    else label[s] = "gameplay";
  }

  // Merge runs shorter than minRunSec into the surrounding regime.
  const regimes: Regime[] = [];
  let start = 0;
  for (let s = 1; s <= n; s++) {
    if (s === n || label[s] !== label[start]) {
      const run = s - start;
      if (run < opts.minRunSec && regimes.length > 0) {
        // Absorb short run into the previous regime's end.
        regimes[regimes.length - 1]!.end = s;
      } else {
        if (regimes.length > 0 && regimes[regimes.length - 1]!.end !== start) {
          // gap filled by previous absorption
        }
        regimes.push({ start, end: s, type: label[start]! });
      }
      start = s;
    }
  }
  return regimes;
}