import { TranscribeAdapter } from "../../server/adapters/outbound/transcribe/TranscribeAdapter.ts";
// transcribe 3 slices: around known burst (2700s), a quiet stretch, and a gift-train stretch
const adapter = new TranscribeAdapter({
  binDir: "/home/livia/Projects/SemaClip/native/whisper/linux-x64",
  modelsDir: "/home/livia/Projects/SemaClip/native/whisper/models",
  modelFile: "ggml-base.en-q5_1.bin",
  vadModelFile: "ggml-silero-v5.1.2.bin",
}, "ffmpeg");
for (const [name, start] of [["burst", 2700], ["quiet", 7200], ["gift", 11100]] as const) {
  const p = new Deno.Command("ffmpeg", { args: ["-y", "-ss", String(start), "-t", "300", "-i",
    "/home/livia/Projects/SemaClip/data/testing/ironmouse_4h/video.mp4", "-vn", "-ac", "1", "-ar", "16000",
    "-c:a", "pcm_s16le", `/tmp/iron_${name}.wav`], stdout: "null", stderr: "null" });
  const st = await (await p.spawn()).status;
  if (!st.success) throw new Error(`extract ${name} failed`);
  const { segments } = await adapter.transcribe(`/tmp/iron_${name}.wav`, { workers: 8 });
  await Deno.writeTextFile(`/tmp/iron_${name}_seg.json`, JSON.stringify(segments));
  console.log(`${name}: ${segments.length} segments`);
}
