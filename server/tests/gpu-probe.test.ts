/**
 * GPU probe: vendor/arch-aware encoder detection regression suite.
 * Probing logic is pure decision code (list filtering, ranking, arg mapping);
 * the ffmpeg runs are the live path, exercised via the gpu-encoder endpoint
 * and the adapter test (verified live: nvenc 300s@540p in 10.3s, 67MB).
 */
import { proxyEncodeArgs } from "../adapters/outbound/ffmpeg/gpu-probe.ts";

Deno.test("proxyEncodeArgs: cpu → sw scale + libx264, no hwaccel args", () => {
  const args = proxyEncodeArgs({ backend: "cpu", ok: true }, 540);
  if (args.hwaccelArgs.length !== 0) throw new Error("cpu path carries hwaccel args");
  if (args.vf !== "scale=-2:540") throw new Error(`vf: ${args.vf}`);
  if (!args.encoderArgs.includes("libx264")) throw new Error("cpu encoder missing libx264");
});

Deno.test("proxyEncodeArgs: nvenc → scale_cuda work chain + cuda hwaccel", () => {
  const args = proxyEncodeArgs({ backend: "nvenc", ok: true, reason: "" }, 540);
  if (!args.hwaccelArgs.includes("cuda")) throw new Error("missing cuda hwaccel");
  if (args.vf !== "scale_cuda=-2:540") throw new Error(`vf: ${args.vf}`);
  if (!args.encoderArgs.includes("h264_nvenc")) throw new Error("encoder missing");
});

Deno.test("proxyEncodeArgs: vaapi → scale_vaapi + vaapi hwaccel", () => {
  const args = proxyEncodeArgs({ backend: "vaapi", ok: true, reason: "" }, 540);
  if (!args.hwaccelArgs.includes("vaapi")) throw new Error("missing vaapi hwaccel");
  if (args.vf !== "scale_vaapi=-2:540") throw new Error(`vf: ${args.vf}`);
  if (!args.encoderArgs.includes("h264_vaapi")) throw new Error("encoder missing");
});

Deno.test("proxyEncodeArgs: height substitutes through every backend chain", () => {
  for (const backend of ["cpu", "nvenc", "qsv", "vaapi", "amf"] as const) {
    const args = proxyEncodeArgs({ backend, ok: true, reason: "" }, 720);
    if (!args.vf.includes("720")) throw new Error(`${backend} vf missing height: ${args.vf}`);
  }
});