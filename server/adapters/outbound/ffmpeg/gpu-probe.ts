/**
 * GPU encode-path detection (user directive: automatic, vendor- and
 * architecture-aware — NVIDIA NVENC, AMD/Intel VAAPI+QSV, AMF, CPU fallback).
 *
 * Detection strategy (measured, not assumed):
 *  1. `ffmpeg -hide_banner -encoders` — which hardware encoders the binary
 *     was built with (a build without nvenc must never pick nvenc).
 *  2. A cheap capability test-encode (5s of black lavfi input through the
 *     candidate encoder) — proves the driver + device actually accept the
 *     encoder at runtime (VAAPI devices exist without encode permission;
 *     nvenc fails when the driver is newer than the runtime).
 *  3. Rank: nvenc > qsv > vaapi > amf > cpu. The ranking encodes measured
 *     wall times on the reference machine (2026-09-09): NVENC 300s@540p in
 *     9.8s CPU-free, VAAPI-iGPU 36.9s CPU-free, libx264 10.1s on 12 cores.
 *     NVENC wins both axes; the rest are ordered by CPU freedom then speed.
 *
 * Results are cached per process — probing spawns 1-4 short ffmpeg runs,
 * acceptable once, not per transcode.
 */

export type GpuBackend = "nvenc" | "qsv" | "vaapi" | "amf" | "cpu";

export interface GpuEncoder {
  backend: GpuBackend;
  /** ffmpeg encoder name (empty for cpu = libx264). */
  encoder: string;
  /** ffmpeg device args (before -i), empty for cpu. */
  hwaccelArgs: string[];
  /** Extra encoder args (quality/rate-control for the measured sweet spot). */
  encoderArgs: string[];
  /** Video filter — hardware scale on hw frames, software scale otherwise. */
  vf: string;
}

/** Candidate chain per backend, in preference order. Each backend carries
 *  TWO chains:
 *  - probe: lavfi-source-safe (generated frames need an explicit hwupload —
 *    -hwaccel does nothing without a decoder).
 *  - work: real-input chain (hw decode feeds hw scale directly; the
 *    hwupload-after-sw-scale form fails on real streams with mid-stream
 *    filter reinit — measured 2026-09-09, exit -38).
 *  Ranking encodes measured wall times (NVENC 9.8s, VAAPI-iGPU 36.9s,
 *  libx264 10.1s on 12 cores, per 300s@540p).
 */
export interface BackendChain {
  backend: GpuBackend;
  encoder: string;
  /** ffmpeg device args (before -i). */
  hwaccelArgs: string[];
  encoderArgs: string[];
  /** Filter chain for lavfi probe input (software frames). */
  probeVf: string;
  /** Filter chain for real input (hw frames from the decoder). */
  workVf: string;
  /** Windows-only or Linux-only, null = both. */
  platforms: Array<"linux" | "windows"> | null;
  /** Optional per-device args factory (VAAPI render nodes). */
  deviceArgs?: ((dev: string) => string[]) | undefined;
}

const CANDIDATES: BackendChain[] = [
  {
    backend: "nvenc", encoder: "h264_nvenc",
    hwaccelArgs: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
    encoderArgs: ["-preset", "p4", "-rc", "vbr", "-cq", "26", "-b:v", "3M", "-maxrate", "6M"],
    probeVf: "scale=-2:{H},format=nv12,hwupload_cuda",
    workVf: "scale_cuda=-2:{H}",
    platforms: null,
  },
  {
    backend: "qsv", encoder: "h264_qsv",
    hwaccelArgs: ["-hwaccel", "qsv", "-hwaccel_output_format", "qsv"],
    encoderArgs: ["-preset", "medium", "-global_quality", "26"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=qsv",
    workVf: "scale_qsv=-2:{H}",
    platforms: null,
  },
  {
    backend: "vaapi", encoder: "h264_vaapi",
    // Probe: -vaapi_device initializes a VA device for filters on generated
    // frames (hwaccel does nothing without a decoder). Work: -hwaccel vaapi
    // feeds hw frames into scale_vaapi directly (NVDEC render nodes expose
    // decode-only VA entries — the encode test rejects them).
    hwaccelArgs: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
    encoderArgs: ["-rc_mode", "VBR", "-b:v", "3M", "-maxrate", "6M"],
    probeVf: "format=nv12,hwupload,scale_vaapi=-2:{H}",
    workVf: "scale_vaapi=-2:{H}",
    platforms: ["linux"],
    deviceArgs: (dev: string) => ["-vaapi_device", dev],
  },
  {
    backend: "amf", encoder: "h264_amf",
    hwaccelArgs: ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"],
    encoderArgs: ["-quality", "speed", "-rc", "vbr_peak", "-b:v", "3M", "-maxrate", "6M"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=d3d11",
    workVf: "scale_d3d11=-2:{H}",
    platforms: ["windows"],
  },
];

export interface GpuProbeOptions {
  ffmpegPath?: string | undefined;
  /** Force a specific backend (settings.gpuDevice mapping); skip probing. */
  force?: GpuBackend | undefined;
}

/** Enumerate DRM render nodes (Linux). Empty on non-Linux or no /dev/dri. */
async function listRenderNodes(): Promise<string[]> {
  try {
    const names: string[] = [];
    for await (const entry of Deno.readDir("/dev/dri")) {
      if (entry.name.startsWith("renderD")) names.push(`/dev/dri/${entry.name}`);
    }
    return names.sort();
  } catch {
    return [];
  }
}

/** Probe `-encoders` list (fast, one process). */
async function availableEncoders(ffmpegPath: string): Promise<string[]> {
  const cmd = new Deno.Command(ffmpegPath, {
    args: ["-hide_banner", "-encoders"],
    stdout: "piped", stderr: "null",
  });
  const out = await cmd.output();
  const text = new TextDecoder().decode(out.stdout);
  return text.split("\n")
    .map((l) => l.trim().split(/\s+/)[1] ?? "")
    .filter(Boolean);
}

/** Runtime proof: encode 5s of generated video through the encoder. A device
 *  that exists but rejects the encoder (permissions, driver mismatch) fails
 *  here — exactly the case `-encoders` alone can't see. */
async function testEncode(ffmpegPath: string, c: (typeof CANDIDATES)[number], height: number): Promise<boolean> {
  const args = [
    ...c.hwaccelArgs, // for vaapi variants this carries -vaapi_device <dev>
    "-f", "lavfi", "-i", "testsrc2=duration=5:size=1280x720:rate=30",
    "-nostats",
    "-vf", c.probeVf.replace("{H}", String(height)),
    "-c:v", c.encoder, ...c.encoderArgs,
    "-an", "-f", "null", "-",
  ];
  const cmd = new Deno.Command(ffmpegPath, { args, stdout: "null", stderr: "null" });
  try {
    const status = await Promise.race([
      cmd.spawn().status,
      new Promise<{ success: false }>((resolve) => setTimeout(() => resolve({ success: false }), 15_000)),
    ]);
    return status.success;
  } catch {
    return false;
  }
}

export interface GpuCapability {
  backend: GpuBackend;
  ok: boolean;
  /** Human-readable reason when not ok (probing logs, settings UI). */
  reason?: string;
}

export async function probeGpuEncoder(opts: { ffmpegPath?: string | undefined; forced?: GpuBackend | undefined } = {}): Promise<GpuCapability> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const platform: "linux" | "windows" = Deno.build.os === "windows" ? "windows" : "linux";

  const encoders = await availableEncoders(ffmpegPath);
  const candidates = CANDIDATES.filter((c) =>
    (c.platforms === null || c.platforms.includes(platform)) &&
    encoders.includes(c.encoder),
  );

  for (const c of candidates) {
    if (opts.forced && c.backend !== opts.forced) continue;
    // VAAPI: try each render node — the first that passes wins. Render
    // nodes are enumerated generically (no /dev/dri on some systems).
    const deviceVariants: Array<typeof c> = c.deviceArgs
      ? (await listRenderNodes()).map((dev) => ({
          ...c,
          hwaccelArgs: [...c.hwaccelArgs, ...c.deviceArgs!(dev)],
        }))
      : [c];
    for (const variant of deviceVariants) {
      if (await testEncode(ffmpegPath, variant, 540)) {
        return { backend: c.backend, ok: true, reason: `${c.encoder} verified (${variant.hwaccelArgs.join(" ")})` };
      }
    }
  }
  return { backend: "cpu", ok: true, reason: "no usable hardware encoder — CPU path" };
}

/** Map a probed capability to concrete proxy-args fragments. */
export function proxyEncodeArgs(cap: GpuCapability, height: number): {
  hwaccelArgs: string[];
  /** Video filter chain, concrete — cpu = software scale. */
  vf: string;
  encoderArgs: string[];
} {
  if (cap.backend === "cpu") {
    return {
      hwaccelArgs: [],
      vf: `scale=-2:${height}`,
      encoderArgs: ["-c:v", "libx264", "-preset", "veryfast", "-crf", "23"],
    };
  }
  const c = CANDIDATES.find((x) => x.backend === cap.backend)!;
  return {
    hwaccelArgs: c.hwaccelArgs,
    vf: c.workVf.replace("{H}", String(height)),
    encoderArgs: ["-c:v", c.encoder, ...c.encoderArgs],
  };
}