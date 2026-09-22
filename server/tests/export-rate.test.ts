/**
 * The export ETA's rate, measured over a RECENT WINDOW.
 *
 * WHY THE WINDOW MATTERS: the first version divided total elapsed by total encoded seconds, which is a
 * CUMULATIVE mean. That number carries the whole history of the run, so a phase that gets slower never
 * shows up — the estimate keeps reporting the average of everything that came before, and on a real
 * encode the opening seconds (process spawn, decoder init, the first keyframe) permanently drag it
 * down. The window is what makes the estimate answer "how fast is this going NOW", which is the only
 * question an ETA answers usefully.
 *
 * The rate is WALL seconds per MEDIA second (`out_time_us` from ffmpeg's `-progress`), so a rate of
 * 2.0 means twice as long as the clip's duration. It is deliberately NOT a "x realtime" figure: that
 * is a property of one machine and the export page no longer shows any speed multiple at all.
 */
import { rateOverWindow } from "@/application/use-cases/ExportQueue.ts";
import { assert, assertEquals } from 'jsr:@std/assert@1';

/** A sample list, oldest first, from (ms, mediaSec) pairs. */
const samples = (...pairs: [number, number][]) =>
  pairs.map(([atMs, encodedSec]) => ({ atMs, encodedSec }));

Deno.test("rateOverWindow returns null rather than guessing", () => {
  // Nothing measured yet. A fabricated number here is worse than no number: it is the value the UI
  // would print as an ETA.
  assertEquals(rateOverWindow(undefined), null, "no live entry means no rate");
  assertEquals(rateOverWindow({ samples: [] }), null, "no samples means no rate");
  assertEquals(rateOverWindow({ samples: samples([0, 0]) }), null, "one sample has no span");

  // Two samples inside the minimum span: adjacent, noisy, no honest rate.
  assertEquals(
    rateOverWindow({ samples: samples([0, 0], [900, 0.5]) }),
    null,
    "a sub-minimum span must not produce a rate",
  );
  // Just under the boundary, asserting the boundary itself rather than a value well past it.
  assertEquals(rateOverWindow({ samples: samples([0, 0], [2_499, 5]) }), null);
  // At the boundary a rate IS reported — otherwise the boundary would be off by one and the ETA
  // would simply never appear on a short run.
  assert(rateOverWindow({ samples: samples([0, 0], [2_500, 5]) }) !== null);
});

Deno.test("rateOverWindow reports a stalled encode as NOT MEASURED, never as infinite", () => {
  // Media time has not advanced: dividing by it is a division by zero, and the honest answer is that
  // there is no rate. This is a real state — a decode that has not emitted its first frame yet.
  assertEquals(rateOverWindow({ samples: samples([0, 0], [5_000, 0]) }), null, "zero media delta");
  // Media time going BACKWARDS (a restarted ffmpeg, a sample from a previous attempt) must not read
  // as a negative rate.
  assertEquals(rateOverWindow({ samples: samples([0, 10], [5_000, 4]) }), null, "negative media delta");
});

Deno.test("rateOverWindow is wall-seconds per media-second", () => {
  // 10s of wall clock to encode 5s of media = 2.0 s/s (a clip takes twice its duration to encode).
  assertEquals(rateOverWindow({ samples: samples([0, 0], [10_000, 5]) }), 2.0);
  // Twice as fast.
  assertEquals(rateOverWindow({ samples: samples([0, 0], [10_000, 10]) }), 1.0);
  // Faster than realtime, so below 1 — the case a "x realtime" label would have expressed as 3x.
  // 3s of wall for 9s of media is 1/3 s per media second, NOT 0.5.
  assertEquals(rateOverWindow({ samples: samples([0, 0], [3_000, 9]) }), 1 / 3);
});

Deno.test("rateOverWindow uses the RECENT samples, not the whole run (the fix itself)", () => {
  // This is the load-bearing case. The run opened SLOWLY (10s of wall per 1s of media) and is now
  // running fast (2s of wall per 4s of media). A cumulative mean over all four samples would be:
  //     (0->4s, 12s wall) ... total wall 22s / total media 5s = 4.4 s/s
  // which is wildly pessimistic and describes a phase that ENDED. The window must report the recent
  // rate: from the 10s sample to the 14s sample, 4s wall / 4s media = 1.0 s/s.
  const recent = samples(
    [0, 0], [10_000, 1], [12_000, 2], [14_000, 5],
  );
  const rate = rateOverWindow({ samples: recent });
  assertEquals(rate, 1.0, `expected the recent rate, got ${rate}`);

  // FALSIFICATION, run inline so the difference is visible in the output: compute the cumulative mean
  // the OLD code produced across the same samples and show it disagrees. If this ever equals the
  // windowed rate the test above has stopped discriminating.
  const cumulative = (14_000 / 1000) / 5;      // elapsed / encoded, the old formula
  assert(
    cumulative !== rate,
    "the cumulative mean must disagree with the windowed rate, or this test proves nothing",
  );
  assertEquals(cumulative, 2.8, "the old formula's pessimistic answer, for the record");
});

Deno.test("rateOverWindow tracks a SLOWDOWN, which a cumulative mean cannot", () => {
  // Fast first half, then a 4x slowdown. The window follows; the cumulative mean lags behind it.
  const slowing = samples([0, 0], [4_000, 8], [8_000, 10], [12_000, 11]);
  const rate = rateOverWindow({ samples: slowing })!;
  // The window reaches back 10s from the newest sample, so its oldest sample is the 4s one: 8s of
  // wall over 3 media seconds = 8/3 s/s. Well above the opening phase's rate.
  assertEquals(rate, 8 / 3, `the window must follow the slowdown, got ${rate}`);
  const cumulative = 12_000 / 1000 / 11;
  assert(cumulative < rate, "the cumulative mean understates the current rate after a slowdown");
});

Deno.test("rateOverWindow tolerates samples that share a timestamp", () => {
  // Zero span between the first two samples but a valid span across all three: the delta is taken
  // from the ends, so this measures fine.
  assertEquals(rateOverWindow({ samples: samples([5_000, 1], [5_000, 1], [10_000, 6]) }), 1.0);
  // EVERY sample at one timestamp gives a zero span, which must not divide by zero.
  assertEquals(rateOverWindow({ samples: samples([5_000, 1], [5_000, 2]) }), null);
});

Deno.test("the WINDOW is bounded — old samples are dropped, not averaged in for ever", async () => {
  // Drives the real trim rule against the source, because the windowing lives in the progress handler
  // as well as in this function and both halves must agree on the size of the window.
  const src = await Deno.readTextFile(
    new URL("../application/use-cases/ExportQueue.ts", import.meta.url),
  );
  assert(/const RATE_WINDOW_MS = 10_000;/.test(src), "the window size must be a named constant");
  assert(/RATE_MIN_SPAN_MS = 2_500;/.test(src), "the minimum span must be a named constant");
  // The producer must actually trim, or `samples` grows for the whole run and the "window" is really
  // a cumulative mean with extra steps — the exact bug this replaces.
  assert(
    /l\.samples\.shift\(\)/.test(src),
    "the progress handler must DROP samples older than the window",
  );
  assert(
    /const cutoff = nowMs - RATE_WINDOW_MS;/.test(src),
    "the trim must use the window constant",
  );
});

Deno.test("the cumulative mean is GONE from the running-item view", async () => {
  const src = await Deno.readTextFile(
    new URL("../application/use-cases/ExportQueue.ts", import.meta.url),
  );
  // The old formula lived at the view's build site. Asserting its ABSENCE is the point: leaving it
  // there behind a new function would ship two rates and the wrong one would win.
  assert(
    !/elapsedSec \/ live\.encodedSec/.test(src),
    "the cumulative `elapsed / encoded` mean must not survive anywhere",
  );
  assert(
    /secondsPerMediaSecond: rateOverWindow\(live\)/.test(src),
    "the view must take its rate from the windowed function",
  );
});
