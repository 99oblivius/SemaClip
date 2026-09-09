/**
 * Finds the loudest N-minute window in the full VOD (for short-sample
 * precision testing). Prints start seconds. Chat+audio RMS scan only.
 *
 * Usage: deno run --allow-read --allow-write --allow-run scripts/find-loudest.ts [windowSec]
 */
import { parseTwitchChatJson } from "../chat.ts";
import { chatFeatures } from "../signals/chat.ts";
import { audioFeatures } from "../signals/audio.ts";

// scripts/ is one level deep; resolve the repo root relative to this file.
const REPO_ROOT = new URL("../", import.meta.url).pathname;
const vodPath = Deno.args[0] || `${REPO_ROOT}/data/training/video.mp4`;
const chatPath = Deno.args[1] || `${REPO_ROOT}/data/training/chat.json`;
const windowSec = parseInt(Deno.args[2] || "900", 10);

// Full audio scan (measured ~10s for 5.8h VOD).
const wav = "/tmp/semaclip-scan.wav";
const ff = new Deno.Command("ffmpeg", {
  args: ["-y", "-t", String(windowSec + 60), "-i", vodPath, "-vn", "-ac", "1", "-ar", "8000", "-c:a", "pcm_s16le", wav],
  stdout: "null", stderr: "piped",
});
const proc = ff.spawn();
const stderrReader = proc.stderr.getReader();
const stderrTailPromise = (async () => {
  const dec = new TextDecoder();
  let tail = "";
  for (;;) {
    const { done, value } = await readerRead(stderrReader);
    if (done) break;
    tail += dec.decode(value).slice(-300);
  }
  return tail;
})();
async function readerRead(r: ReadableStreamDefaultReader<Uint8Array>) { return r.read(); }
const scanStatus = await proc.status;
if (!scanStatus.success) {
  const tail = (await stderrTailPromise).slice(-300);
  throw new Error(`audio scan extract failed (${scanStatus.code}): ${tail}`);
}
const raw = await Deno.readFile(wav);
// 'data' chunk may be misaligned by 1 byte in the slice search — scan on
// 2-byte-aligned boundaries and require a plausible chunk size.
const dec = new TextDecoder();
let dataOff = 44;
for (let i = 12; i + 8 <= 200; i += 1) {
  if (dec.decode(raw.slice(i, i + 4)) === "data") {
    dataOff = i + 8;
    break;
  }
}
// Int16Array requires byteOffset to be even.
if (dataOff % 2 !== 0) dataOff += 1;
const avail = raw.byteLength - dataOff;
const samples = new Int16Array(raw.buffer, dataOff, Math.floor(avail / 2));
const audio = audioFeatures(samples, 8000);
const n = audio.length;

// Sliding window sum of RMS.
const prefix = new Float64Array(n + 1);
for (let s = 0; s < n; s++) prefix[s + 1]! = prefix[s]! + audio[s]!.rms;
let best = 0, bestStart = 0;
for (let s = 0; s + windowSec <= n; s++) {
  const sum = prefix[s + windowSec]! - prefix[s]!;
  if (sum > best) { best = sum; bestStart = s; }
}

// Chat activity in that window (from the fixture chat).
const parsed = parseTwitchChatJson(await Deno.readTextFile(chatPath));
const chatInWindow = parsed.events.filter((e) => e.t >= bestStart && e.t < bestStart + windowSec).length;

function fmt(sec: number): string {
  const h = Math.floor(sec / 3600), m = Math.floor((sec % 3600) / 60), s = Math.floor(sec % 60);
  return `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`;
}
console.log(`Loudest ${windowSec}s window: ${fmt(bestStart)}–${fmt(bestStart + windowSec)} (mean RMS ${(best / windowSec).toFixed(4)})`);
console.log(`Chat messages in window: ${chatInWindow}`);
console.log(`start=${bestStart}`);
await Deno.remove(wav).catch(() => {});