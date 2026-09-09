import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parseSrt, srtTimestampToSeconds } from "@/adapters/outbound/transcribe/srt-parse.ts";

describe("srtTimestampToSeconds", () => {
  it("converts comma-millis timestamps", () => {
    assert.equal(srtTimestampToSeconds("00:01:02,400"), 62.4);
  });

  it("converts dot-millis timestamps", () => {
    assert.equal(srtTimestampToSeconds("01:00:00.000"), 3600);
  });

  it("returns NaN on malformed input", () => {
    assert.ok(Number.isNaN(srtTimestampToSeconds("not a time")));
    assert.ok(Number.isNaN(srtTimestampToSeconds("00:01:02")));
  });
});

describe("parseSrt", () => {
  it("parses well-formed SRT with multi-line cues", () => {
    const srt = "1\n00:00:00,200 --> 00:00:05,160\nAnyways, I went and I kept\nlike flinching\n\n2\n00:00:05,160 --> 00:00:11,620\nAnd then I had to close it\n";
    const cues = parseSrt(srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0]!.start, 0.2);
    assert.equal(cues[0]!.end, 5.16);
    assert.equal(cues[0]!.text, "Anyways, I went and I kept like flinching");
    assert.equal(cues[1]!.index, 2);
    assert.equal(cues[1]!.text, "And then I had to close it");
  });

  it("tolerates CRLF, BOM, missing index numbers, and position lines", () => {
    const srt = "\uFEFF00:00:01,000 --> 00:00:02,000 X1:40 X2:600\r\nHello there\r\n\r\n00:00:03,000 --> 00:00:04,000\r\nSecond cue\r\n";
    const cues = parseSrt(srt);
    assert.equal(cues.length, 2);
    assert.equal(cues[0]!.start, 1);
    assert.equal(cues[0]!.text, "Hello there");
  });

  it("skips cues with malformed timestamps instead of failing", () => {
    const srt = "1\nbad timestamps\nskipped entirely\n\n2\n00:00:10,000 --> 00:00:12,000\nkept\n";
    const cues = parseSrt(srt);
    assert.equal(cues.length, 1);
    assert.equal(cues[0]!.text, "kept");
    assert.equal(cues[0]!.index, 1); // renumbered, gap-free
  });

  it("returns empty for empty input", () => {
    assert.deepEqual(parseSrt(""), []);
    assert.deepEqual(parseSrt("\n\n\n"), []);
  });
});