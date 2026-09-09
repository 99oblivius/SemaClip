import { assertEquals } from "@std/assert";
import { parseEngineEvent } from "@/adapters/outbound/engine/validate.ts";

Deno.test("accepts a well-formed clip event with signals", () => {
  const line = JSON.stringify({
    type: "clip", jobId: "j1", id: "c1", axis: "hype", start: 1, end: 2, peak: 1.5,
    score: 0.9, justification: "why", signals: { chatExcitement: 0.8, voicePitch: 0.5, emoteVelocity: 0.7, lurkerActivation: 0.2 },
  });
  const r = parseEngineEvent(line);
  assertEquals(r.ok, true);
  if (r.ok) assertEquals(r.event.type, "clip");
});

Deno.test("rejects invalid JSON", () => {
  assertEquals(parseEngineEvent("{not json").ok, false);
});

Deno.test("rejects missing jobId", () => {
  const r = parseEngineEvent(JSON.stringify({ type: "complete", clipsFound: 3 }));
  assertEquals(r.ok, false);
});

Deno.test("rejects unknown event type", () => {
  const r = parseEngineEvent(JSON.stringify({ type: "bogus", jobId: "j" }));
  assertEquals(r.ok, false);
});

Deno.test("rejects out-of-range score", () => {
  const r = parseEngineEvent(JSON.stringify({ type: "candidate", jobId: "j", axis: "hype", start: 0, end: 1, score: 1.5 }));
  assertEquals(r.ok, false);
});

Deno.test("rejects invalid axis", () => {
  const r = parseEngineEvent(JSON.stringify({ type: "candidate", jobId: "j", axis: "chaos", start: 0, end: 1, score: 0.5 }));
  assertEquals(r.ok, false);
});

Deno.test("rejects invalid signals (out of [0,1])", () => {
  const r = parseEngineEvent(JSON.stringify({
    type: "clip", jobId: "j", axis: "hype", start: 0, end: 1, peak: 0.5, score: 0.5,
    signals: { chatExcitement: 2, voicePitch: 0, emoteVelocity: 0, lurkerActivation: 0 },
  }));
  assertEquals(r.ok, false);
});

Deno.test("rejects percent out of [0,1]", () => {
  const r = parseEngineEvent(JSON.stringify({ type: "progress", jobId: "j", phase: "transcription", percent: 45 }));
  assertEquals(r.ok, false);
});

Deno.test("error event with fabricated phase is normalized, not rejected", () => {
  const r = parseEngineEvent(JSON.stringify({ type: "error", jobId: "j", phase: "cancelled", message: "cancelled by user" }));
  assertEquals(r.ok, true);
});

Deno.test("complete requires numeric clipsFound", () => {
  assertEquals(parseEngineEvent(JSON.stringify({ type: "complete", jobId: "j" })).ok, false);
  assertEquals(parseEngineEvent(JSON.stringify({ type: "complete", jobId: "j", clipsFound: 12 })).ok, true);
});