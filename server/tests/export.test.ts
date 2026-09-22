/**
 * Export integration test — proves the export path really produces a playable
 * file (the v1 stub reported success without running ffmpeg).
 * Generates a 4s test video via ffmpeg lavfi, then exports a 1s sub-clip.
 */
import { assertEquals } from "@std/assert";
import type { ExportProfile } from "shared/types";
import { FFmpegAdapter } from "@/adapters/outbound/ffmpeg/FFmpegAdapter.ts";

const TEST_DIR = await Deno.makeTempDir({ prefix: "semaclip_export_test_" });

// Skip cleanly if ffmpeg is unavailable (CI machines without ffmpeg).
let ffmpegAvailable = false;
try {
  const cmd = new Deno.Command("ffmpeg", { args: ["-version"], stdout: "null", stderr: "null" });
  const out = await cmd.output();
  ffmpegAvailable = out.success;
} catch {
  ffmpegAvailable = false;
}

const profile = (over: Partial<ExportProfile> = {}): ExportProfile => ({
  container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: null,
    encoder: "auto", encoderName: null, options: { quality: 26, maxBitrateKbps: null },
    aspectRatio: "16:9",
  captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
  nameTemplate: "{date}",
  ...over,
});

Deno.test({
  name: "export produces a real, non-empty, decodable mp4",
  ignore: !ffmpegAvailable,
  fn: async () => {
    const src = `${TEST_DIR}/src.mp4`;
    const out = `${TEST_DIR}/clip.mp4`;

    // 4s test pattern: 320x180, 30fps, with audio tone.
    const gen = new Deno.Command("ffmpeg", {
      args: [
        "-y",
        "-f", "lavfi", "-i", "testsrc=duration=4:size=320x180:rate=30",
        "-f", "lavfi", "-i", "sine=frequency=440:duration=4",
        "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p",
        "-c:a", "aac", "-shortest",
        src,
      ],
      stdout: "null",
      stderr: "null",
    });
    const genOut = await gen.output();
    assertEquals(genOut.success, true, "test video generation failed");

    const adapter = new FFmpegAdapter();
    const result = await adapter.exportClip({
      vodPath: src,
      startTime: 1,
      endTime: 3,
      outputPath: out,
      profile: profile({ aspectRatio: "9:16" }),
      srtPath: null,
    });

    assertEquals(result.exportPath, out);
    const stat = await Deno.stat(out);
    assertEquals(stat.size > 10240, true, `exported file too small: ${stat.size}`);

    // Verify decodability + duration ≈ 2s via ffprobe.
    const probe = await adapter.probeDuration(out);
    assertEquals(probe !== null, true);
    assertEquals(Math.abs((probe ?? 0) - 2) < 0.5, true, `expected ~2s, got ${probe}`);
  },
});

Deno.test({
  name: "export with captions enabled but missing SRT fails loudly",
  ignore: !ffmpegAvailable,
  fn: async () => {
    const src = `${TEST_DIR}/src.mp4`;
    const out = `${TEST_DIR}/clip2.mp4`;
    const adapter = new FFmpegAdapter();
    let threw = false;
    try {
      await adapter.exportClip({
        vodPath: src,
        startTime: 0,
        endTime: 2,
        outputPath: out,
        // Captions enabled with a transcript path that does not exist on disk.
        profile: profile({ captions: { enabled: true, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 } }),
        srtPath: `${TEST_DIR}/nonexistent.srt`,
      });
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "missing SRT must fail, not export silently without captions");
  },
});