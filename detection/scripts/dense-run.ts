import { parseTwitchChatJson } from "/home/livia/Projects/SemaClip/detection/chat.ts";
import { chatFeatures } from "/home/livia/Projects/SemaClip/detection/signals/chat.ts";
import { computeBaselines } from "/home/livia/Projects/SemaClip/detection/baselines.ts";
import { HypeDetector } from "/home/livia/Projects/SemaClip/detection/axes/hype.ts";
import { runDetection } from "/home/livia/Projects/SemaClip/detection/pipeline.ts";

// The fixture path is supplied by the caller: the dense-chat slice is a real
// channel's data and is gitignored, so no script may hardcode where it lives (or
// whose it is). Usage: deno run -A scripts/dense-run.ts <path/to/chat.json>
const chatPath = Deno.args[0];
if (!chatPath) {
  console.error("usage: dense-run.ts <path/to/chat.json>");
  Deno.exit(2);
}
const raw = await Deno.readTextFile(chatPath);
const t0 = performance.now();
const parsed = parseTwitchChatJson(raw);
console.log(`parsed ${parsed.events.length} events in ${((performance.now()-t0)/1000).toFixed(2)}s, duration=${parsed.durationSec}s`);

const chat = chatFeatures(parsed.events, parsed.durationSec);
const E = new Float32Array(parsed.durationSec);
for (let s = 0; s < parsed.durationSec; s++) {
  const c = chat[s];
  E[s] = c ? Math.min(1, c.velocity/10) + 1.4*Math.min(1, c.emoteDensity/8) + 0.5*c.capsRatio : 0;
}
const baselines = computeBaselines(E, parsed.durationSec, { localWindowSec: 300, outlierK: 3, minSpread: 0.02 });
const features = { durationSec: parsed.durationSec, chat, audio: [], transcript: [] };
const t1 = performance.now();
const candidates = runDetection(features, baselines, [], [new HypeDetector()], { maxClips: 20, minSlotsPerAxis: 1 });
console.log(`${candidates.length} candidates in ${((performance.now()-t1)/1000).toFixed(2)}s`);
for (const c of candidates.slice(0, 12)) {
  const off = 152451;
  const f = (s: number) => { const x = s; return `${Math.floor(x/3600)}:${String(Math.floor((x%3600)/60)).padStart(2,"0")}:${String(Math.floor(x%60)).padStart(2,"0")}`; };
  console.log(`  ${f(c.start-off)}–${f(c.end-off)} score=${c.score.toFixed(2)} signals=${JSON.stringify(c.signals)}`);
  console.log(`    ${c.justification}`);
}
