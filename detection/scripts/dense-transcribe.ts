import { TranscribeAdapter } from "../../server/adapters/outbound/transcribe/TranscribeAdapter.ts";
const adapter = new TranscribeAdapter({
  binDir: "/home/livia/Projects/SemaClip/native/whisper/linux-x64",
  modelsDir: "/home/livia/Projects/SemaClip/native/whisper/models",
  modelFile: "ggml-base.en-q5_1.bin",
  vadModelFile: "ggml-silero-v5.1.2.bin",
}, "ffmpeg");
const t0 = performance.now();
const { segments } = await adapter.transcribe("/tmp/dense_slice.wav", { workers: 16 });
const wall = (performance.now() - t0) / 1000;
console.log(`segments=${segments.length} wall=${wall.toFixed(1)}s for 900s (${(900 / wall).toFixed(0)}x realtime)`);
// Show transcript around the welp-om burst (slice starts at 2700; burst at 2796 → slice-relative 96s)
for (const s of segments.filter((x) => x.end > 60 && x.start < 150)) {
  console.log(`[+${s.start.toFixed(0)}s] ${s.text.slice(0, 90)}`);
}