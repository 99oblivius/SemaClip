import { TranscribeAdapter } from "../../server/adapters/outbound/transcribe/TranscribeAdapter.ts";
// transcribe 3 slices: around a known burst (2700s), a quiet stretch, and a gift-train stretch.
// The fixture path comes from the caller — the slice is a real channel's VOD and is
// gitignored, so nothing here may hardcode it.
// Usage: deno run -A scripts/dense-slices.ts <path/to/video.mp4>
const videoPath = Deno.args[0];
if (!videoPath) {
  console.error("usage: dense-slices.ts <path/to/video.mp4>");
  Deno.exit(2);
}
const adapter = new TranscribeAdapter({
  binDir: "/home/livia/Projects/SemaClip/native/whisper/linux-x64",
  modelsDir: "/home/livia/Projects/SemaClip/native/whisper/models",
  modelFile: "ggml-base.en-q5_1.bin",
  vadModelFile: "ggml-silero-v5.1.2.bin",
}, "ffmpeg");
for (const [name, start] of [["burst", 2700], ["quiet", 7200], ["gift", 11100]] as const) {
  const p = new Deno.Command("ffmpeg", { args: ["-y", "-ss", String(start), "-t", "300", "-i",
    videoPath, "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", `/tmp/dense_${name}.wav`], stdout: "null", stderr: "null" });
  const st = await (await p.spawn()).status;
  if (!st.success) throw new Error(`extract ${name} failed`);
  const { segments } = await adapter.transcribe(`/tmp/dense_${name}.wav`, { workers: 8 });
  await Deno.writeTextFile(`/tmp/dense_${name}_seg.json`, JSON.stringify(segments));
  console.log(`${name}: ${segments.length} segments`);
}
