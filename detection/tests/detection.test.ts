/**
 * Detection package tests: chat parsing (TwitchDownloader fixture shape),
 * per-second features, baselines, hype detection on a synthetic burst,
 * pipeline ranking.
 */
import { assertEquals, assertAlmostEquals } from "@std/assert";
import { parseTwitchChatJson } from "../chat.ts";
import { chatFeatures, messageEmoteScore, capsStats } from "../signals/chat.ts";
import { audioFeatures } from "../signals/audio.ts";
import { computeBaselines } from "../baselines.ts";
import { HypeDetector } from "../axes/hype.ts";
import { runDetection } from "../pipeline.ts";
import type { FeatureTable, Baselines } from "../types.ts";

const FIXTURE = JSON.stringify({
  FileInfo: { Version: { Major: 1, Minor: 4, Patch: 0 } },
  streamer: { name: "SoulCamera", login: "soulcamera", id: 67698098 },
  video: {
    title: "Test VOD", id: "2827417958", length: 20852, game: "Overwatch",
    chapters: [{ startMilliseconds: 0, lengthMilliseconds: 12717000, description: "Overwatch" }],
  },
  comments: [
    { content_offset_seconds: 19, commenter: { display_name: "A" }, message: { body: "hello" } },
    { content_offset_seconds: 19.5, commenter: { display_name: "B" }, message: { body: "KEKW" } },
    { content_offset_seconds: 20, commenter: { display_name: "A" }, message: { body: "POGGERS" } },
    { content_offset_seconds: 20, commenter: { display_name: "C" }, message: { body: "LETS GOOO" } },
    { content_offset_seconds: 21, commenter: { display_name: "B" }, message: { body: "W H A T", bits_spent: 100 } },
    { content_offset_seconds: 99999, commenter: { display_name: "X" } }, // malformed → skipped
  ],
});

Deno.test("chat parser: TwitchDownloader fixture → sorted events, metadata, skip counting", () => {
  const p = parseTwitchChatJson(FIXTURE);
  assertEquals(p.events.length, 5);
  assertEquals(p.skipped, 1);
  assertEquals(p.streamer, "soulcamera");
  assertEquals(p.durationSec, 20852);
  assertEquals(p.chapters.length, 1);
  assertEquals(p.events[0]!.t <= p.events[4]!.t, true);
});

Deno.test("chat parser: rejects non-TwitchDownloader input loudly", () => {
  let threw = false;
  try { parseTwitchChatJson("{}"); } catch { threw = true; }
  assertEquals(threw, true);
});

Deno.test("emote scoring: whole-token match + purity bonus", () => {
  assertAlmostEquals(messageEmoteScore("KEKW"), 1.08, 0.01);
  assertAlmostEquals(messageEmoteScore("lol KEKW funny"), 0.9, 0.001);
  assertEquals(messageEmoteScore("nothing here"), 0);
});

Deno.test("caps stats", () => {
  assertEquals(capsStats("WHAT IS THIS").ratio, 1);
  // Letters = "WhatIsThis" (10), caps = W, I, T → 0.3.
  assertAlmostEquals(capsStats("What Is This").ratio, 0.3, 0.01);
  assertEquals(capsStats("...").totalChars, 0);
});

Deno.test("chatFeatures: velocity, emote density, caps, bits per second", () => {
  const p = parseTwitchChatJson(FIXTURE);
  const feats = chatFeatures(p.events, 30);
  assertEquals(feats[19]!.velocity, 2);
  assertEquals(feats[20]!.velocity, 2);
  assertEquals(feats[21]!.bits, 100);
  assertEquals(feats[19]!.uniqueUsers, 2);
  assertEquals(feats[20]!.emoteDensity > 0, true);
});

Deno.test("audio features: RMS of silence ≈ 0, of tone > 0", () => {
  const sr = 100;
  const silence = new Int16Array(2 * sr);
  const loud = new Int16Array(2 * sr);
  for (let i = 0; i < loud.length; i++) loud[i] = 16000 * Math.sin((i / sr) * Math.PI * 2);
  const s1 = audioFeatures(silence, sr);
  const s2 = audioFeatures(loud, sr);
  assertAlmostEquals(s1[0]!.rms, 0, 0.001);
  // Sine RMS = 0.707 × 0.488 ≈ 0.345.
  assertEquals(s2[0]!.rms > 0.3, true);
});

Deno.test("baselines: threshold = max(local median, global × floor)", () => {
  const E = new Float32Array(100);
  for (let s = 0; s < 100; s++) E[s] = s / 100; // ramp 0..0.99
  const b = computeBaselines(E, 100, { localWindowSec: 10, outlierK: 3, minSpread: 0.02 });
  // Global median of a uniform ramp ≈ 0.495 → floor ≈ 0.2475.
  assertEquals(b.global > 0.4 && b.global < 0.6, true);
  assertEquals(b.threshold(50) >= b.local[50]!, true);
  assertEquals(b.threshold(50) >= b.global * 0.5 - 1e-6, true);
});

Deno.test("hype detector fires on a synthetic chat burst above baseline", () => {
  const DUR = 120;
  const events: Array<{ t: number; user: string; body: string; isEmoteOnly: boolean; bitsSpent: number }> = [];
  for (let t = 0; t < DUR; t += 3) {
    events.push({ t, user: `u${t % 5}`, body: "hi", isEmoteOnly: false, bitsSpent: 0 });
  }
  for (let t = 60; t < 72; t += 0.2) {
    events.push({ t, user: `burst${Math.floor(t) % 8}`, body: "POGGERS", isEmoteOnly: true, bitsSpent: 0 });
  }
  events.sort((a, b) => a.t - b.t);

  const chat = chatFeatures(events, DUR);
  const features: FeatureTable = { durationSec: DUR, chat, audio: null, transcript: null };
  // Threshold fixed low: the burst's emote mass towers over baseline chatter.
  const baselines: Baselines = {
    local: new Float32Array(DUR), spread: new Float32Array(DUR), global: 0.05, threshold: () => 0.08,
  };
  const candidates = new HypeDetector().detect(features, baselines, []);

  assertEquals(candidates.length >= 1, true, `expected ≥1 candidate, got ${candidates.length}`);
  const top = candidates[0]!;
  assertEquals(top.axis, "hype");
  assertEquals(top.start <= 60, true);
  assertEquals(top.end >= 72, true);
  assertEquals(top.score > 0.25, true);
  assertEquals(top.signals.emoteVelocity > 0, true);
});

Deno.test("hype detector: quiet stream produces zero candidates", () => {
  const DUR = 100;
  const events = Array.from({ length: 30 }, (_, i) => ({
    t: i * 3, user: `u${i % 4}`, body: "gg", isEmoteOnly: false, bitsSpent: 0,
  }));
  const chat = chatFeatures(events, DUR);
  const features: FeatureTable = { durationSec: DUR, chat, audio: null, transcript: null };
  const baselines: Baselines = {
    local: new Float32Array(DUR), spread: new Float32Array(DUR), global: 1.0, threshold: () => 0.5,
  };
  assertEquals(new HypeDetector().detect(features, baselines, []).length, 0);
});

Deno.test("pipeline: runs detectors, ranks, respects maxClips", () => {
  const DUR = 300;
  const cands = Array.from({ length: 80 }, (_, i) => ({
    axis: i % 2 === 0 ? "hype" : "humor",
    start: i * 3, end: i * 3 + 2, peak: i * 3 + 1,
    score: 0.3 + (i % 7) / 10,
    signals: { chatExcitement: 0.5, emoteVelocity: 0.4, audioEnergy: 0, speechCoverage: 0 },
    justification: null,
  }));
  const ranked = runDetection(
    { durationSec: DUR, chat: null, audio: null, transcript: null },
    { local: new Float32Array(DUR), spread: new Float32Array(DUR), global: 0, threshold: () => 0 },
    [],
    [
      { axis: "hype", detect: () => cands },
      { axis: "humor", detect: () => [] },
    ],
  );
  assertEquals(ranked.length <= 50, true);
  assertEquals(ranked.every((c) => c.score > 0), true);
});