/**
 * Reaction axis unit tests — synthetic feature tables, no models.
 */
import { assertEquals } from "@std/assert";
import { ReactionDetector } from "../axes/reaction.ts";
import { computeBaselines } from "../baselines.ts";
import type { FeatureTable, AudioFeaturesSec, TranscriptSegment } from "../types.ts";

const DUR = 300;

function featureTable(segments: TranscriptSegment[], rmsAt: (t: number) => number): FeatureTable {
  const audio: AudioFeaturesSec[] = Array.from({ length: DUR }, (_, t) => ({
    rms: rmsAt(t),
    speechProb: 0,
  }));
  return { durationSec: DUR, chat: null, audio, transcript: segments };
}

/** Flat voice 0-100s, energy jump 100-106s, flat after. */
function jumpTable(): FeatureTable {
  const segments: TranscriptSegment[] = [
    { start: 0, end: 100, text: "just playing the game talking normally over" },
    { start: 100, end: 106, text: "what?! oh my god no way that scared me" },
    { start: 110, end: 140, text: "okay okay back to normal talking again" },
    { start: 145, end: 200, text: "more normal gameplay talk continues here" },
  ];
  const rmsAt = (t: number) => (t >= 100 && t <= 106 ? 0.25 : t < 200 ? 0.06 : 0);
  return featureTable(segments, rmsAt);
}

Deno.test("reaction: detects an energy jump during voice", () => {
  const features = jumpTable();
  const E = new Float32Array(DUR);
  const baselines = computeBaselines(E, DUR);
  const cands = new ReactionDetector().detect(features, baselines, []);
  assertEquals(cands.length >= 1, true, `expected ≥1 reaction, got ${cands.length}`);
  const top = cands[0]!;
  assertEquals(top.axis, "reaction");
  assertEquals(top.start <= 100, true, "candidate must cover the jump onset");
  assertEquals(top.end >= 106, true);
  assertEquals(top.signals.chatExcitement, 0, "no chat — chatExcitement stays 0");
  assertEquals(top.justification!.includes("voice energy"), true);
});

Deno.test("reaction: wording driver named when interjections present", () => {
  const features = jumpTable();
  const baselines = computeBaselines(new Float32Array(DUR), DUR);
  const cands = new ReactionDetector().detect(features, baselines, []);
  const top = cands[0]!;
  assertEquals(top.justification!.includes("wording"), true, `got: ${top.justification}`);
});

Deno.test("reaction: silent stream produces nothing", () => {
  const segments: TranscriptSegment[] = [];
  const audio: AudioFeaturesSec[] = Array.from({ length: DUR }, () => ({ rms: 0, speechProb: 0 }));
  const baselines = computeBaselines(new Float32Array(DUR), DUR);
  const cands = new ReactionDetector().detect(
    { durationSec: DUR, chat: null, audio, transcript: segments },
    baselines,
    [],
  );
  assertEquals(cands.length, 0);
});

Deno.test("reaction: steady loud voice (no delta) produces nothing", () => {
  const segments: TranscriptSegment[] = [
    { start: 0, end: 200, text: "constant loud talking the whole time here" },
  ];
  const audio: AudioFeaturesSec[] = Array.from({ length: DUR }, () => ({ rms: 0.2, speechProb: 0 }));
  const baselines = computeBaselines(new Float32Array(DUR), DUR);
  const cands = new ReactionDetector().detect(
    { durationSec: DUR, chat: null, audio, transcript: segments },
    baselines,
    [],
  );
  assertEquals(cands.length, 0);
});