/**
 * Range-header + servable-clamp tests.
 *
 * Both behaviours guarded here caused real, observed playback failures:
 * a suffix range parsed as `0..N` and a response clamped mid-fragment both
 * kill Chromium's decoder with PIPELINE_ERROR_DECODE.
 */
import { assertEquals } from "@std/assert";
import { clampToServable, parseRangeHeader } from "@/adapters/inbound/http/range.ts";

Deno.test("parseRangeHeader: plain start-end", () => {
  assertEquals(parseRangeHeader("bytes=0-1023", 10000), { start: 0, end: 1023 });
  assertEquals(parseRangeHeader("bytes=500-999", 10000), { start: 500, end: 999 });
});

Deno.test("parseRangeHeader: open-ended range runs to the end", () => {
  assertEquals(parseRangeHeader("bytes=9000-", 10000), { start: 9000, end: 9999 });
});

Deno.test("parseRangeHeader: end past EOF is clamped, not rejected", () => {
  assertEquals(parseRangeHeader("bytes=9000-999999", 10000), { start: 9000, end: 9999 });
});

Deno.test("parseRangeHeader: SUFFIX range means the LAST N bytes", () => {
  // The regression: parsing this as start=0/end=N serves the WRONG bytes
  // and Chromium dies decoding them.
  assertEquals(parseRangeHeader("bytes=-500", 10000), { start: 9500, end: 9999 });
  assertEquals(parseRangeHeader("bytes=-1", 10000), { start: 9999, end: 9999 });
  // Suffix longer than the file = the whole file.
  assertEquals(parseRangeHeader("bytes=-99999", 10000), { start: 0, end: 9999 });
  // And it must never be mistaken for the broken 0..N interpretation.
  const r = parseRangeHeader("bytes=-5000", 10000);
  assertEquals(r, { start: 5000, end: 9999 });
});

Deno.test("parseRangeHeader: unsatisfiable and malformed", () => {
  assertEquals(parseRangeHeader("bytes=10000-10100", 10000), "unsatisfiable");
  assertEquals(parseRangeHeader("bytes=-0", 10000), "unsatisfiable");
  assertEquals(parseRangeHeader("bytes=500-100", 10000), "unsatisfiable");
  assertEquals(parseRangeHeader(null, 10000), null);
  assertEquals(parseRangeHeader("items=0-10", 10000), null);
});

Deno.test("parseRangeHeader: multi-range takes the first range", () => {
  assertEquals(parseRangeHeader("bytes=0-99,200-299", 10000), { start: 0, end: 99 });
});

Deno.test("clampToServable: never past the download frontier or EOF", () => {
  // Complete file: the request is honoured.
  assertEquals(clampToServable(9999, 10000, 10000), 9999);
  // Growing file: clamped to the safe frontier (exclusive → -1).
  assertEquals(clampToServable(9999, 4000, 10000), 3999);
  // Frontier ahead of the on-disk size (a racing write) → EOF wins.
  assertEquals(clampToServable(9999, 9000, 5000), 4999);
});
