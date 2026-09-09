import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { cuesToSrt } from "@/adapters/outbound/transcribe/srt-write.ts";
import { parseSrt } from "@/adapters/outbound/transcribe/srt-parse.ts";

describe("cuesToSrt", () => {
  it("round-trips through parseSrt", () => {
    const cues = [
      { index: 1, start: 0.2, end: 5.16, text: "Anyways, I went and I kept like flinching" },
      { index: 2, start: 5.16, end: 11.62, text: "And then I had to close it" },
    ];
    const parsed = parseSrt(cuesToSrt(cues));
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0]!.start, 0.2);
    assert.equal(parsed[0]!.end, 5.16);
    assert.equal(parsed[0]!.text, cues[0]!.text);
    assert.equal(parsed[1]!.start, 5.16);
  });

  it("renumbers gap-free and flattens multi-line text", () => {
    const cues = [
      { index: 7, start: 3600.5, end: 3602, text: "one\ntwo\nthree" },
    ];
    const srt = cuesToSrt(cues);
    assert.ok(srt.startsWith("1\n"), "renumbered to 1");
    assert.ok(srt.includes("01:00:00,500 --> 01:00:02,000"), "hour-scale timestamp");
    assert.ok(!srt.includes("\ntwo\n"), "text flattened");
  });

  it("clamps negative times to zero", () => {
    const srt = cuesToSrt([{ index: 1, start: -0.5, end: 1, text: "x" }]);
    assert.ok(srt.includes("00:00:00,000 -->"), "negative start clamped");
  });
});