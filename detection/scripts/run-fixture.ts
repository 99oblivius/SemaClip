/**
 * Phase 1 harness: run the detection package on the REAL training fixture
 * (data/training/chat.json, 5.8h VOD). Prints per-stage timings and the top
 * candidates for the manual precision@10 check (ROADMAP Phase 1 exit gate).
 *
 * Usage: deno run --allow-read --allow-write scripts/run-fixture.ts [chatPath]
 */
import { parseTwitchChatJson } from "../chat.ts";
import { chatFeatures } from "../signals/chat.ts";
import { audioFeatures, applyTranscriptCoverage } from "../signals/audio.ts";
import { computeBaselines } from "../baselines.ts";
import { HypeDetector } from "../axes/hype.ts";
import { runDetection } from "../pipeline.ts";
import type { FeatureTable } from "../types.ts";

const chatPath = Deno.args[0] ?? new URL("../../data/training/chat.json", import.meta.url).pathname;
const raw = await Deno.readTextFile(chatPath);

const t0 = performance.now();
const parsed = parseTwitchChatJson(raw);
const t1 = performance.now();
console.log(`[parse] ${parsed.events.length} events in ${((t1 - t0) / 1000).toFixed(2)}s — streamer=${parsed.streamer} duration=${parsed.durationSec}`);
for (const w of parsed.warnings) console.log(`  warn: ${w}`);

const durationSec = parsed.durationSec ?? Math.ceil(parsed.events.at(-1)?.t ?? 0);
const t2 = performance.now();
const chat = chatFeatures(parsed.events, durationSec);
const t3 = performance.now();
console.log(`[chat-features] ${durationSec}s table in ${((t3 - t2) / 1000).toFixed(2)}s`);

// Non-zero stats — sanity for a sparse fixture.
const nonzeroVel = chat.filter((c) => c.velocity > 0).length;
const maxVel = Math.max(...chat.map((c) => c.velocity));
console.log(`[chat-features] seconds with chat: ${nonzeroVel}/${durationSec}, max velocity/s: ${maxVel}`);

const features: FeatureTable = { durationSec, chat, audio: null, transcript: null };

const t4 = performance.now();
const E = new Float32Array(durationSec);
for (let s = 0; s < durationSec; s++) {
  const c = chat[s]!;
  E[s] = 1.0 * Math.min(1, c.velocity / 10) + 1.4 * Math.min(1, c.emoteDensity / 8) + 0.5 * c.capsRatio;
}
const baselines = computeBaselines(E, durationSec, { localWindowSec: 300, outlierK: 3, minSpread: 0.02 });
const t5 = performance.now();
console.log(`[baselines] global=${baselines.global.toFixed(3)} in ${((t5 - t4) / 1000).toFixed(2)}s`);

const t6 = performance.now();
const candidates = runDetection(features, baselines, [], [new HypeDetector()], { maxClips: 50, minSlotsPerAxis: 1 });
const t7 = performance.now();
console.log(`[hype] ${candidates.length} candidates in ${((t7 - t6) / 1000).toFixed(2)}s`);

console.log("\nTop 10 (for manual precision@10 check):");
function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
for (const [i, c] of candidates.slice(0, 10).entries()) {
  console.log(`${String(i + 1).padStart(2, "0")}. ${fmt(c.start)}–${fmt(c.end)} peak ${fmt(c.peak)} score=${c.score.toFixed(2)} — ${c.justification}`);
}

const total = (t7 - t0) / 1000;
console.log(`\nTotal CPU time (no audio/transcript yet): ${total.toFixed(2)}s`);