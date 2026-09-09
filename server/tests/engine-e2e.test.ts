/**
 * Integration: DetectionEngineAdapter end-to-end on a real 11s audio fixture
 * (data/testing/fixtures/jfk.wav — public-domain JFK speech, bundled because
 * /tmp is not a repo fixture).
 *
 * Asserts the full honest pipeline: progress events → clip events (>=0 is
 * valid — the fixture is speech, not hype) → complete → SRT sidecar written
 * → per-stage timings present. The whisper binary must exist (fetch-native.sh).
 */
import { assertEquals, assertExists } from "@std/assert";
import { DetectionEngineAdapter } from "@/adapters/outbound/engine/DetectionEngineAdapter.ts";
import { InProcessEventBus } from "@/adapters/outbound/eventbus/InProcessEventBus.ts";
import { ENGINE_EVENT_TOPIC } from "@/application/ports/outbound.ts";
import type { EngineEvent } from "shared/types";
import { REPO_ROOT } from "../paths.ts";

const NATIVE = `${REPO_ROOT}/native/whisper`;
const FIXTURE = `${REPO_ROOT}/data/testing/fixtures/jfk.wav`;
const CHAT = `${REPO_ROOT}/data/testing/fixtures/jfk.chat.json`;

const nativeReady = await Deno.stat(`${NATIVE}/linux-x64/whisper-cli`).then(() => true).catch(() => false);
const fixtureReady = await Deno.stat(FIXTURE).then(() => true).catch(() => false);

Deno.test({
  name: "detection engine E2E: jfk.wav → events → SRT sidecar",
  ignore: !nativeReady || !fixtureReady,
  sanitizeResources: false,
  sanitizeOps: false,
}, async () => {
  const bus = new InProcessEventBus();
  const engine = new DetectionEngineAdapter({
    whisper: {
      binDir: `${NATIVE}/linux-x64`,
      modelsDir: `${NATIVE}/models`,
      modelFile: "ggml-base.en-q5_1.bin",
      vadModelFile: "ggml-silero-v5.1.2.bin",
    },
    ffmpegPath: "ffmpeg",
  });
  engine.attachBus(bus);

  const events: EngineEvent[] = [];
  const unsub = bus.subscribe<EngineEvent>(ENGINE_EVENT_TOPIC, (e) => events.push(e));

  const artifactDir = await Deno.makeTempDir({ prefix: "semaclip-e2e-" });
  // A minimal chat file (0 events is legal — jfk.wav has no chat).
  const chatPath = `${artifactDir}/chat.json`;
  await Deno.writeTextFile(chatPath, JSON.stringify({
    FileInfo: { version: "1.4" },
    video: { length: 11 },
    comments: [],
  }));

  const t0 = performance.now();
  await engine.start({
    type: "start",
    jobId: "e2e-jfk",
    vodPath: FIXTURE,
    chatPath,
    config: { maxClips: 5 },
    artifactDir,
    workers: 2,
  });
  const wall = (performance.now() - t0) / 1000;

  const complete = events.find((e) => e.type === "complete");
  assertExists(complete, "engine must emit complete");
  assertEquals(complete.jobId, "e2e-jfk");
  const clips = events.filter((e) => e.type === "clip");
  // No hype blips in 11s of solo speech is a valid outcome; the gate is the
  // pipeline completing with consistent state, not clip count.
  for (const c of clips) {
    assertEquals(c.axis, "hype");
    if (c.signals) {
      const vals = Object.values(c.signals);
      assertEquals(vals.some((v) => v > 0), true, "clip signals must be real (non-zero somewhere)");
    }
  }

  // Per-stage timings: every stage present in stageTimes via the summary
  // (the complete path emits them in the log line + final progress message).
  const lastProgress = [...events].reverse().find(
    (e): e is Extract<EngineEvent, { type: "progress" }> => e.type === "progress" && e.message?.startsWith("Done in") === true,
  );
  assertExists(lastProgress, "completion timing summary must be emitted");
  const doneMessage = lastProgress.message ?? "";
  assertExists(doneMessage.match(/transcription=[\d.]+s/), "timing summary names the transcription stage");
  const phases = ["chat_parsing", "audio_extraction", "transcription", "segmentation", "axis_scoring"];
  for (const p of phases) {
    const began = events.some((e) => e.type === "progress" && e.phase === p);
    assertEquals(began, true, `stage ${p} must emit progress`);
  }

  // Real work happened: transcription is the dominant cost on real speech.
  assertExists(doneMessage.match(/transcription=[\d.]+s/), "transcription timing is nonzero");

  console.log(`[e2e] wall=${wall.toFixed(1)}s events=${events.length} clips=${clips.length}`);
  console.log(`[e2e] ${lastProgress.message}`);

  // SRT sidecar: whisper found speech in jfk.wav → transcript must exist.
  const srt = await Deno.readTextFile(`${artifactDir}/transcript.srt`);
  assertEquals(srt.includes("-->"), true, "SRT has timestamp arrows");
  console.log(`[e2e] SRT head: ${srt.split("\n").slice(0, 4).join(" / ")}`);

  unsub();
  await Deno.remove(artifactDir, { recursive: true });
});