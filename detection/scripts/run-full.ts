/**
 * Full-signal fixture harness: chat + audio (+ transcript when available)
 * on data/training/*, with per-stage timings.
 *
 * Usage: deno run --allow-read --allow-write --allow-run --allow-env scripts/run-full.ts [vodPath] [chatPath] [sliceSec]
 * sliceSec: only process the first N seconds (default: 600 = 10 min).
 */
import { parseTwitchChatJson } from "../chat.ts";
import { chatFeatures } from "../signals/chat.ts";
import { audioFeatures, applyTranscriptCoverage } from "../signals/audio.ts";
import { computeBaselines } from "../baselines.ts";
import { HypeDetector } from "../axes/hype.ts";
import { runDetection } from "../pipeline.ts";
import type { FeatureTable } from "../types.ts";

const vodPath = Deno.args[0] || new URL("../../data/training/video.mp4", import.meta.url).pathname;
const chatPath = Deno.args[1] || new URL("../../data/training/chat.json", import.meta.url).pathname;
const sliceSec = parseInt(Deno.args[2] ?? "600", 10);

// ── Chat ──
const t0 = performance.now();
const parsed = parseTwitchChatJson(await Deno.readTextFile(chatPath));
const chatAll = chatFeatures(parsed.events, parsed.durationSec ?? 21600);
const t1 = performance.now();
console.log(`[chat] ${parsed.events.length} events → table in ${((t1 - t0) / 1000).toFixed(2)}s`);

// ── Audio: extract slice → PCM → per-second features ──
const t1b = performance.now();
const wavTmp = await Deno.makeTempFile({ prefix: "semaclip-slice-", suffix: ".wav" });
const ff = new Deno.Command("ffmpeg", {
  args: ["-y", "-t", String(sliceSec), "-i", vodPath, "-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le", wavTmp],
  stdout: "null", stderr: "null",
});
const st = await (async () => { const c = ff.spawn(); return await c.status; })();
if (!st.success) throw new Error(`ffmpeg extract failed (${st.code})`);
const t2 = performance.now();
console.log(`[audio-extract] ${sliceSec}s slice in ${((t2 - t1b) / 1000).toFixed(1)}s`);

const raw = await Deno.readFile(wavTmp);
// Locate the 'data' chunk (robust against LIST/JUNK chunks in the header).
const dec = new TextDecoder();
let dataOff = 44;
for (let i = 12; i < Math.min(200, raw.byteLength - 8); i++) {
  if (dec.decode(raw.slice(i, i + 4)) === "data") {
    dataOff = i + 8;
    break;
  }
}
const samples = new Int16Array(raw.buffer, dataOff, Math.floor((raw.byteLength - dataOff) / 2));
const t2b = performance.now();
const audio = audioFeatures(samples, 16000);
const t3 = performance.now();
console.log(`[audio-features] ${samples.length} samples → ${audio.length}s in ${((t3 - t2b) / 1000).toFixed(2)}s (file read ${((t2b - t2) / 1000).toFixed(2)}s)`);

const maxRms = Math.max(...audio.map((a) => a.rms));
const silentSecs = audio.filter((a) => a.rms < 0.001).length;
console.log(`[audio-features] maxRms=${maxRms.toFixed(3)}, silent secs=${silentSecs}/${audio.length}`);

// ── Joint features + baselines ──
const duration = Math.min(sliceSec, audio.length);
const features: FeatureTable = { durationSec: duration, chat: chatAll.slice(0, duration), audio: audio.slice(0, duration), transcript: null };

const t4 = performance.now();
const E = new Float32Array(duration);
for (let s = 0; s < duration; s++) {
  const c = features.chat?.[s];
  const a = features.audio?.[s];
  E[s] = (c ? Math.min(1, c.velocity / 10) + 1.4 * Math.min(1, c.emoteDensity / 8) + 0.5 * c.capsRatio : 0)
    + 0.6 * Math.min(1, (a?.rms ?? 0) * 3);
}
const baselines = computeBaselines(E, duration, { localWindowSec: 1800, globalFloor: 0.5 });
const t5 = performance.now();
console.log(`[baselines] global=${baselines.global.toFixed(3)} in ${((t5 - t4) / 1000).toFixed(2)}s`);

const t6 = performance.now();
const candidates = runDetection(features, baselines, [], [new HypeDetector()], { maxClips: 50, minSlotsPerAxis: 1 });
const t7 = performance.now();
console.log(`[hype] ${candidates.length} candidates in ${((t7 - t6) / 1000).toFixed(2)}s`);

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
console.log("\nCandidates:");
for (const [i, c] of candidates.slice(0, 15).entries()) {
  console.log(`${String(i + 1).padStart(2, "0")}. ${fmt(c.start)}–${fmt(c.end)} peak ${fmt(c.peak)} score=${c.score.toFixed(2)} audio=${c.signals ? "?" : "-"} — ${c.justification}`);
}

const total = (t7 - t0) / 1000;
console.log(`\nTotal wall: ${total.toFixed(2)}s for ${duration}s of VOD → ${duration / Math.max(0.01, total) < 60 ? "" : ""}${(duration / total).toFixed(0)}× realtime (chat+audio only)`);

await Deno.remove(wavTmp).catch(() => {});