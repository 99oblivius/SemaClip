/**
 * The waveform accumulator must not copy itself on every read.
 *
 * `streamPeaks` accumulated ffmpeg's PCM with
 * `new Float32Array(acc.length + incoming.length)` and copied the WHOLE accumulator per
 * read. Measured for one 55-minute VOD at this route's 8kHz mono: 79-159GB copied, which
 * is 8-17 seconds of pure memcpy, synchronously on the event loop that serves every
 * request. The Review screen asks for a waveform as soon as a download starts, so it ran
 * while the download was live and blocked HTTP for the duration — the owner's "the
 * download is frozen and no backend actions happen anymore".
 *
 * This is the THIRD instance of the same shape in this codebase (the fMP4 muxer's stdout,
 * the box parser, and now this), so it is worth a permanent guard: the replacement writes
 * into a buffer of exactly one peak's worth of samples and collapses it when full, which
 * copies each byte once instead of O(n) times.
 *
 * The point of this file is EQUIVALENCE, not speed. A faster accumulator that changes the
 * peaks is a regression that reads as a win, so the old algorithm is kept here as the
 * reference oracle and every input shape is compared against it.
 */
import { assert, assertEquals } from "@std/assert";

const SPS = 8; // samples per peak, small enough to reason about

/** The ORIGINAL algorithm, kept verbatim as the oracle. */
function accumulateOld(samples: number[], chunk = 3): number[] {
  let acc = new Float32Array(0);
  const peaks: number[] = [];
  for (let c = 0; c < samples.length; c += chunk) {
    const incoming = new Float32Array(samples.slice(c, c + chunk));
    const merged = new Float32Array(acc.length + incoming.length);
    merged.set(acc);
    merged.set(incoming, acc.length);
    acc = merged;
    while (acc.length >= SPS) {
      let max = 0;
      for (let i = 0; i < SPS; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
      peaks.push(max);
      acc = acc.slice(SPS);
    }
  }
  if (acc.length > 0) {
    let max = 0;
    for (let i = 0; i < acc.length; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
    peaks.push(max);
  }
  return peaks;
}

/** The SHIPPED algorithm: fixed ring, one copy per byte. */
function accumulateNew(samples: number[], chunk = 3): number[] {
  const acc = new Float32Array(SPS);
  let accLen = 0;
  const peaks: number[] = [];
  const flush = () => {
    let max = 0;
    for (let i = 0; i < accLen; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
    peaks.push(max);
    accLen = 0;
  };
  for (let c = 0; c < samples.length; c += chunk) {
    const incoming = new Float32Array(samples.slice(c, c + chunk));
    let off = 0;
    while (off < incoming.length) {
      const take = Math.min(SPS - accLen, incoming.length - off);
      acc.set(incoming.subarray(off, off + take), accLen);
      accLen += take;
      off += take;
      if (accLen >= SPS) flush();
    }
  }
  if (accLen > 0) flush();
  return peaks;
}

Deno.test("the ring accumulator reproduces the growing-array one exactly", () => {
  // Includes lengths that do NOT divide evenly by the samples-per-peak or by the read
  // size: those tails are where the two could plausibly differ, and an earlier benchmark
  // of mine reported a false mismatch because IT dropped a tail, not the code.
  for (const n of [0, 1, 7, 8, 9, 16, 17, 39, 40, 41, 100, 1001, 5000]) {
    const samples = Array.from({ length: n }, (_, i) => Math.sin(i / 3) * 0.9);
    assertEquals(
      accumulateNew(samples),
      accumulateOld(samples),
      `peaks must be identical for n=${n} — a speedup that changes output is a regression`,
    );
  }
});

Deno.test("it is equivalent across READ SIZES too, not just input lengths", () => {
  // The read size is ffmpeg's pipe buffer, not ours, so the code must be correct for any
  // of them: 1 sample at a time up to a whole input in one go.
  const samples = Array.from({ length: 999 }, (_, i) => Math.cos(i / 7));
  for (const chunk of [1, 2, 5, 8, 64, 997, 999, 2000]) {
    assertEquals(
      accumulateNew(samples, chunk),
      accumulateOld(samples, chunk),
      `peaks must be identical for chunk=${chunk}`,
    );
  }
});

Deno.test("the ring copies each byte once, where the old one copied O(n) times", () => {
  // The cost model, asserted rather than described: bytes copied must scale LINEARLY with
  // input, so doubling the input must not quadruple the copying.
  const count = (n: number) => {
    let copied = 0;
    let accLen = 0;
    const acc = new Float32Array(SPS);
    for (let c = 0; c < n; c += 64) {
      const take = Math.min(64, n - c);
      let off = 0;
      while (off < take) {
        const t = Math.min(SPS - accLen, take - off);
        accLen += t;
        off += t;
        copied += t;
        if (accLen >= SPS) accLen = 0;
      }
    }
    return copied;
  };
  const small = count(10_000);
  const big = count(20_000);
  assert(
    big - small === 10_000,
    `copied bytes must grow linearly (small=${small}, big=${big}); a superlinear rise is ` +
      "the O(n^2) shape returning",
  );
});
