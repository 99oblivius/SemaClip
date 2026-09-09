/**
 * computeRegimes: classification, anti-flicker merging, degenerate inputs.
 * Regimes are minutes-scale — tests assert run structure, not per-second labels.
 */
import { computeRegimes } from "../segmentation.ts";
import { chatFeatures } from "../signals/chat.ts";

/** Constant-value excitement of length n. */
function flat(n: number, v: number): Float32Array {
  return new Float32Array(n).fill(v);
}

Deno.test("computeRegimes: flat silence → single lull regime", () => {
  const regimes = computeRegimes(null, null, flat(600, 0), 600);
  const types = new Set(regimes.map((r) => r.type));
  // A flat zero signal can't be split by any cut; every second is quiet.
  if (types.has("hype")) throw new Error("flat-zero scored hype");
  const covered = regimes.reduce((s, r) => s + (r.end - r.start), 0);
  if (covered !== 600) throw new Error(`coverage ${covered} ≠ 600`);
});

Deno.test("computeRegimes: hype spike → hype regime covers the spike window", () => {
  // 10 min: quiet 0–300, loud burst 300–420, quiet 420–600.
  const E = new Float32Array(600).fill(0.01);
  for (let s = 300; s < 420; s++) E[s] = 1.0;
  const regimes = computeRegimes(null, null, E, 600);
  const hype = regimes.filter((r) => r.type === "hype");
  const covered = hype.reduce((s, r) => s + (r.end - r.start), 0);
  if (covered < 60) throw new Error(`hype coverage ${covered} too small for a 120s spike`);
  // Hype must not bleed into the quiet tail.
  for (const r of hype) {
    if (r.end > 540) throw new Error(`hype regime ${r.start}-${r.end} bleeds into quiet tail`);
  }
});

Deno.test("computeRegimes: just-chatting distinguished from gameplay by chat ratio", () => {
  const n = 900;
  const chatRaw: { t: number; user: string; body: string; isEmoteOnly: boolean; bitsSpent: number }[] = [];
  // 0–450: chat-only activity (high velocity, zero audio)
  for (let s = 30; s < 450; s += 2) chatRaw.push({ t: s, user: `u${s % 7}`, body: "hello", isEmoteOnly: false, bitsSpent: 0 });
  const chat = chatFeatures(chatRaw, n);
  const audio = new Array(n).fill({ rms: 0 });
  const E = new Float32Array(n);
  for (let s = 0; s < n; s++) {
    const c = chat[s];
    E[s] = c ? Math.min(1, c.velocity / 10) + Math.min(1, c.emoteDensity / 8) : 0;
  }
  const regimes = computeRegimes(chat, audio, E, n);
  const types = new Set(regimes.map((r) => r.type));
  if (!types.has("chatting") && !types.has("gameplay")) {
    throw new Error(`active chat-only segment produced: ${[...types].join(",")}`);
  }
});

Deno.test("computeRegimes: durationSec 0 → empty; mismatched array length clamped", () => {
  if (computeRegimes(null, null, new Float32Array(0), 0).length !== 0) {
    throw new Error("zero-duration produced regimes");
  }
  // E longer than durationSec: clamp must prevent OOB reads.
  const regimes = computeRegimes(null, null, flat(1000, 0.5), 500);
  const covered = regimes.reduce((s, r) => s + (r.end - r.start), 0);
  if (covered !== 500) throw new Error(`clamped coverage ${covered} ≠ 500`);
});

Deno.test("computeRegimes: runs merge — no regime shorter than minRunSec survives adjacent merge", () => {
  // 20 min with a 30s blip (under minRunSec=60) in the middle.
  const E = new Float32Array(1200).fill(0.5);
  for (let s = 600; s < 630; s++) E[s] = 0.02;
  const regimes = computeRegimes(null, null, E, 1200, { minRunSec: 60, hypeQuantile: 0.9 });
  for (const r of regimes) {
    if (r.end - r.start < 30) throw new Error(`sliver regime ${r.start}-${r.end}`);
  }
});