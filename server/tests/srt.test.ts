import { assertEquals } from "@std/assert";
import { toSrt, srtTime } from "@/adapters/outbound/transcribe/srt.ts";

Deno.test("srtTime formats SRT timestamp", () => {
  assertEquals(srtTime(0), "00:00:00,000");
  assertEquals(srtTime(62.4), "00:01:02,400");
  assertEquals(srtTime(3661.123), "01:01:01,123");
});

Deno.test("segments → SRT with cues, skipping empty text", () => {
  const srt = toSrt([
    { start: 1.5, end: 3.0, text: "Hello world" },
    { start: 4.0, end: 5.0, text: "" },
    { start: 6.0, end: 8.5, text: "Second line" },
  ]);
  assertEquals(srt.includes("00:00:01,500 --> 00:00:03,000"), true);
  assertEquals(srt.includes("Hello world"), true);
  assertEquals(srt.includes("Second line"), true);
  // 2 cue indices: the empty segment is skipped.
  assertEquals(srt.match(/^\d+$/gm)?.length, 2);
});

Deno.test("long text wraps at maxChars", () => {
  const srt = toSrt(
    [{ start: 0, end: 4, text: "one two three four five six seven eight nine ten eleven twelve" }],
    { maxChars: 20, offsetSec: 0 },
  );
  // 63 chars / 20 → 4 cues.
  assertEquals(srt.match(/^\d+$/gm)?.length ?? 0, 4);
});