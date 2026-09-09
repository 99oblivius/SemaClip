/**
 * Short-sample precision check (Phase 1 exit gate): detection on the loudest
 * 15-min slice WITH transcript. Top candidates printed for manual review.
 * Usage: deno run --allow-read --allow-write --allow-run scripts/precision-check.ts
 */
import { parseTwitchChatJson } from "../chat.ts";
import { chatFeatures } from "../signals/chat.ts";
import { audioFeatures, applyTranscriptCoverage } from "../signals/audio.ts";
import { computeBaselines } from "../baselines.ts";
import { HypeDetector } from "../axes/hype.ts";
import { runDetection } from "../pipeline.ts";
import type { FeatureTable, TranscriptSegment } from "../types.ts";

const REPO = new URL("../../", import.meta.url).pathname;
const SLICE_START = 60;
const SLICE_SEC = 900;

const parsed = parseTwitchChatJson(await Deno.readTextFile(`${REPO}/data/training/chat.json`));
const transcript = JSON.parse(await Deno.readTextFile("/tmp/slice60_transcript.json")) as TranscriptSegment[];
const wav = "/tmp/slice60.wav";
const raw = await Deno.readFile(wav);
const dec = new TextDecoder();
let dataOff = 44;
for (let i = 12; i + 8 <= 200; i++) {
  if (dec.decode(raw.slice(i, i + 4)) === "data") { dataOff = i + 8; break; }
}
if (dataOff % 2 !== 0) dataOff += 1;
const samples = new Int16Array(raw.buffer, dataOff, Math.floor((raw.byteLength - dataOff) / 2));
const audio = audioFeatures(samples, 16000);
applyTranscriptCoverage(audio, transcript);

const duration = Math.min(SLICE_SEC, audio.length);
const chat = chatFeatures(parsed.events.filter((e) => e.t >= SLICE_START && e.t < SLICE_START + duration), duration);
const features: FeatureTable = { durationSec: duration, chat, audio, transcript };

const E = new Float32Array(duration);
for (let s = 0; s < duration; s++) {
  const c = chat[s];
  const a = audio[s];
  E[s] = (c ? Math.min(1, c.velocity / 10) + 1.4 * Math.min(1, c.emoteDensity / 8) + 0.5 * c.capsRatio : 0)
    + 0.6 * Math.min(1, (a?.rms ?? 0) * 3);
}
const baselines = computeBaselines(E, duration, { localWindowSec: 1800, globalFloor: 0.5 });
const candidates = runDetection(features, baselines, [], [new HypeDetector()], { maxClips: 50, minSlotsPerAxis: 1 });

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
console.log(`${candidates.length} candidates in the 15-min slice (VOD offset +${SLICE_START}s):`);
for (const [i, c] of candidates.slice(0, 12).entries()) {
  const t = transcript.filter((s) => s.end + SLICE_START >= c.start && s.start + SLICE_START <= c.end).map((s) => s.text).join(" ");
  console.log(`\n${String(i + 1).padStart(2, "0")}. VOD ${fmt(SLICE_START + c.start)}–${fmt(SLICE_START + c.end)} score=${c.score.toFixed(2)}`);
  console.log(`   signals: chat=${c.signals.chatExcitement.toFixed(2)} emote=${c.signals.emoteVelocity.toFixed(2)}`);
  if (t) console.log(`   transcript: ${t.slice(0, 150)}`);
}