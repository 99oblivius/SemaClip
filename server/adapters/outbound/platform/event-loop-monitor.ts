/**
 * Report when the event loop is BLOCKED, and for how long.
 *
 * This app's freezes have been diagnosed three times by inference, because the log showed a
 * last line and then silence, and silence is consistent with several different faults:
 *
 *   - the event loop is blocked (a synchronous copy, a sync read)  -> nothing can log
 *   - a promise never settles (an unbounded await)                 -> the loop is idle
 *   - the process died                                              -> nothing can log either
 *
 * Those need different fixes, and "the log stops" does not distinguish them. A timer that
 * measures its own lateness does: a blocked loop delays or drops the timer, while an
 * unbounded await leaves it running on time.
 *
 * Deliberately cheap and quiet: one timer, one comparison per second, and a line only when
 * something is actually wrong. It never trims, it is not analytics, and it must not be
 * switched off — the next freeze is exactly when the number matters.
 */

/** Lag above this is reported. A healthy Deno process stays in the low milliseconds. */
const REPORT_MS = 2_000;
const TICK_MS = 1_000;

let worstMs = 0;
let reported = 0;

/**
 * Start the monitor. Call once, as early as possible so it is already watching when the
 * first request arrives.
 */
export function installEventLoopMonitor(): () => void {
  let expected = Date.now() + TICK_MS;

  const timer = setInterval(() => {
    const now = Date.now();
    const late = now - expected;
    expected = now + TICK_MS;

    if (late > REPORT_MS) {
      worstMs = Math.max(worstMs, late);
      reported++;
      console.warn(
        `[loop] BLOCKED for ${late}ms — the event loop could not run its timer. ` +
          `That means synchronous work (a copy, a sync read) held it; a pending await ` +
          `would NOT do this. (worst so far: ${worstMs}ms, ${reported} report(s))`,
      );
    }
  }, TICK_MS);

  // Keep it from holding the process open on shutdown.
  try {
    (timer as unknown as { unref?: () => void }).unref?.();
  } catch { /* not all runtimes expose unref */ }

  return () => {
    clearInterval(timer);
    if (reported > 0) {
      console.warn(`[loop] monitor stopping: worst block ${worstMs}ms (${reported} reports)`);
    }
  };
}

/**
 * Run `fn` and report it if it holds the loop longer than `warnMs`.
 *
 * Used for the synchronous stretches that have already frozen this app — parsing and
 * accumulating buffers — so a regression names itself and the duration instead of
 * reappearing as an unexplained freeze.
 */
export async function measureSync<T>(label: string, fn: () => T, warnMs = 250): Promise<T> {
  const t0 = performance.now();
  const result = fn();
  const ms = performance.now() - t0;
  if (ms > warnMs) {
    console.warn(`[loop] ${label} held the loop for ${Math.round(ms)}ms (sync)`);
  }
  return result;
}
