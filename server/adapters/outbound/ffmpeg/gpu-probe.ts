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

import { run, runStatus } from "@/adapters/outbound/process/spawn.ts";
import type { VideoCodec } from "shared/types";

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
  /**
   * The codec this candidate encodes.
   *
   * Required, because the probe used to expose a single `h264_*` encoder regardless: a caller asking
   * "may I use hardware for AV1?" got `h264_nvenc` back, which is not an AV1 encoder, so the check
   * in `shouldUseHardware` correctly refused it and the AV1 export quietly ran on the CPU. The probe
   * has to be asked per codec.
   */
  codec: VideoCodec;
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
  // ── NVENC (NVIDIA) ──
  // AV1 first for an AV1 export: the measured default for AV1 is hardware, and NVENC AV1 encodes at
  // ~6x realtime against SVT-AV1's ~2x, at comparable quality (measured; see
  // references/codec-quality-profiles.md).
  {
    backend: "nvenc", encoder: "av1_nvenc", codec: "av1",
    hwaccelArgs: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
    // `-cq 40` matches libx264 crf 23's measured quality (the +16 offset minus the scale difference).
    encoderArgs: ["-preset", "p4", "-rc", "vbr", "-cq", "40", "-b:v", "0"],
    probeVf: "scale=-2:{H},format=nv12,hwupload_cuda",
    workVf: "scale_cuda=-2:{H}",
    platforms: null,
    deviceArgs: undefined,
  },
  {
    backend: "nvenc", encoder: "h264_nvenc", codec: "h264",
    hwaccelArgs: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
    encoderArgs: ["-preset", "p4", "-rc", "vbr", "-cq", "26", "-b:v", "3M", "-maxrate", "6M"],
    probeVf: "scale=-2:{H},format=nv12,hwupload_cuda",
    workVf: "scale_cuda=-2:{H}",
    platforms: null,
  },
  {
    backend: "nvenc", encoder: "hevc_nvenc", codec: "h265",
    hwaccelArgs: ["-hwaccel", "cuda", "-hwaccel_output_format", "cuda"],
    encoderArgs: ["-preset", "p4", "-rc", "vbr", "-cq", "28", "-b:v", "3M", "-maxrate", "6M", "-tag:v", "hvc1"],
    probeVf: "scale=-2:{H},format=nv12,hwupload_cuda",
    workVf: "scale_cuda=-2:{H}",
    platforms: null,
  },
  // ── VAAPI (the Linux hardware API: AMD and Intel iGPUs/discrete) ──
  // MEASURED: the AMD Raphael iGPU (renderD128) genuinely encodes h264 and hevc through VAAPI,
  // while the NVIDIA render nodes expose ONLY decode entrypoints and reject every encode profile
  // ("No usable encoding entrypoint found"). So VAAPI is enumerated per render node and each node is
  // VERIFIED by an encode — a node that exists is not a node that encodes.
  {
    backend: "vaapi", encoder: "h264_vaapi", codec: "h264",
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
    backend: "vaapi", encoder: "hevc_vaapi", codec: "h265",
    hwaccelArgs: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
    encoderArgs: ["-rc_mode", "VBR", "-b:v", "3M", "-maxrate", "6M", "-tag:v", "hvc1"],
    probeVf: "format=nv12,hwupload,scale_vaapi=-2:{H}",
    workVf: "scale_vaapi=-2:{H}",
    platforms: ["linux"],
    deviceArgs: (dev: string) => ["-vaapi_device", dev],
  },
  {
    backend: "vaapi", encoder: "av1_vaapi", codec: "av1",
    hwaccelArgs: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
    encoderArgs: ["-rc_mode", "VBR", "-b:v", "0"],
    probeVf: "format=nv12,hwupload,scale_vaapi=-2:{H}",
    workVf: "scale_vaapi=-2:{H}",
    platforms: ["linux"],
    deviceArgs: (dev: string) => ["-vaapi_device", dev],
  },
  {
    backend: "vaapi", encoder: "vp9_vaapi", codec: "vp9",
    hwaccelArgs: ["-hwaccel", "vaapi", "-hwaccel_output_format", "vaapi"],
    encoderArgs: ["-rc_mode", "VBR", "-b:v", "0"],
    probeVf: "format=nv12,hwupload,scale_vaapi=-2:{H}",
    workVf: "scale_vaapi=-2:{H}",
    platforms: ["linux"],
    deviceArgs: (dev: string) => ["-vaapi_device", dev],
  },
  // ── QSV (Intel) ──
  // Needs an explicit device: without `-init_hw_device qsv=hw` the encoder is listed by ffmpeg and
  // still fails with "Device creation failed", which is why a presence check is not enough.
  {
    backend: "qsv", encoder: "h264_qsv", codec: "h264",
    hwaccelArgs: [
      "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
      "-hwaccel", "qsv", "-hwaccel_output_format", "qsv",
    ],
    encoderArgs: ["-preset", "medium", "-global_quality", "26"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=extra_hw_frames=64",
    workVf: "scale_qsv=-2:{H}",
    platforms: null,
  },
  {
    backend: "qsv", encoder: "hevc_qsv", codec: "h265",
    hwaccelArgs: [
      "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
      "-hwaccel", "qsv", "-hwaccel_output_format", "qsv",
    ],
    encoderArgs: ["-preset", "medium", "-global_quality", "28", "-tag:v", "hvc1"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=extra_hw_frames=64",
    workVf: "scale_qsv=-2:{H}",
    platforms: null,
  },
  {
    backend: "qsv", encoder: "av1_qsv", codec: "av1",
    hwaccelArgs: [
      "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
      "-hwaccel", "qsv", "-hwaccel_output_format", "qsv",
    ],
    encoderArgs: ["-preset", "medium", "-global_quality", "35"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=extra_hw_frames=64",
    workVf: "scale_qsv=-2:{H}",
    platforms: null,
  },
  {
    backend: "qsv", encoder: "vp9_qsv", codec: "vp9",
    hwaccelArgs: [
      "-init_hw_device", "qsv=hw", "-filter_hw_device", "hw",
      "-hwaccel", "qsv", "-hwaccel_output_format", "qsv",
    ],
    encoderArgs: ["-preset", "medium", "-global_quality", "31"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=extra_hw_frames=64",
    workVf: "scale_qsv=-2:{H}",
    platforms: null,
  },
  // ── AMF (AMD, Windows-only API) ──
  {
    backend: "amf", encoder: "h264_amf", codec: "h264",
    hwaccelArgs: ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"],
    encoderArgs: ["-quality", "speed", "-rc", "vbr_peak", "-b:v", "3M", "-maxrate", "6M"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=d3d11",
    workVf: "scale_d3d11=-2:{H}",
    platforms: ["windows"],
  },
  {
    backend: "amf", encoder: "hevc_amf", codec: "h265",
    hwaccelArgs: ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"],
    encoderArgs: ["-quality", "speed", "-rc", "vbr_peak", "-b:v", "3M", "-maxrate", "6M", "-tag:v", "hvc1"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=d3d11",
    workVf: "scale_d3d11=-2:{H}",
    platforms: ["windows"],
  },
  {
    backend: "amf", encoder: "av1_amf", codec: "av1",
    hwaccelArgs: ["-hwaccel", "d3d11va", "-hwaccel_output_format", "d3d11"],
    encoderArgs: ["-quality", "speed", "-rc", "vbr_peak", "-b:v", "0"],
    probeVf: "scale=-2:{H},format=nv12,hwupload=d3d11",
    workVf: "scale_d3d11=-2:{H}",
    platforms: ["windows"],
  },
];

/**
 * The SOFTWARE encoder per codec, and the label a user recognises.
 *
 * Part of the same list the UI is offered rather than a separate concept: OBS presents "x264" next to
 * "NVIDIA NVENC H.264" as peers, and a user choosing between them is choosing quality, speed and
 * compatibility on one axis. The software entry is always available, so it is the floor under every
 * codec and the reason "no hardware here" is never a dead end.
 */
export const SOFTWARE_ENCODERS: Record<VideoCodec, { encoder: string; label: string }> = {
  h264: { encoder: "libx264", label: "x264 (CPU)" },
  h265: { encoder: "libx265", label: "x265 (CPU)" },
  vp9: { encoder: "libvpx-vp9", label: "libvpx VP9 (CPU)" },
  av1: { encoder: "libsvtav1", label: "SVT-AV1 (CPU)" },
};

/**
 * The vendor-facing name of each backend, for the label the encoder list shows.
 *
 * OBS's model: a user picks "NVIDIA NVENC H.264", "AMD HW H.264 (AVC)", "Intel QuickSync H.264" or
 * "x264" — vendor + API + codec, filtered to what the machine actually supports. A raw ffmpeg
 * encoder name (`h264_vaapi`) names the API instead of the hardware, which is the part a user is
 * actually choosing between.
 */
const BACKEND_LABEL: Record<string, string> = {
  nvenc: "NVIDIA NVENC",
  vaapi: "AMD/Intel VAAPI",
  qsv: "Intel QuickSync",
  amf: "AMD AMF",
};

/** The codec's display name, for a label. */
const CODEC_LABEL: Record<VideoCodec, string> = {
  h264: "H.264",
  h265: "H.265",
  vp9: "VP9",
  av1: "AV1",
};

/**
 * One selectable encoder, as the UI needs it.
 *
 * `backend` is `"cpu"` for the software entry so the existing encoder-choice plumbing (which already
 * distinguishes cpu from hardware) does not need a second concept.
 */
export interface EncoderOption {
  /** The ffmpeg encoder name — what actually reaches `-c:v`. */
  encoder: string;
  /** "NVIDIA NVENC H.264" — vendor + API + codec, never a bare ffmpeg identifier. */
  label: string;
  backend: GpuBackend;
  codec: VideoCodec;
  /** Device args the choice implies, so the work chain reuses the VERIFIED device. */
  deviceArgs?: string[] | undefined;
  /** True for the always-available software entry. */
  software: boolean;
}

/**
 * The ffmpeg interactions discovery needs, injectable so the FILTER LOGIC can be tested without
 * hardware — and without monkey-patching a module namespace, which ES modules forbid.
 *
 * Production passes nothing and gets the real process runner. A test supplies its own and can
 * therefore pin "a listed encoder that cannot encode is dropped" on any machine, including one where
 * qsv genuinely works.
 */
export interface EncoderProbeRunner {
  /** The names in `ffmpeg -encoders`, video encoders only. */
  listed(): Promise<string[]>;
  /** Whether a real encode through this chain succeeds. */
  encodes(chain: BackendChain, height: number): Promise<boolean>;
  /** DRM render nodes, for the per-node VAAPI enumeration. */
  renderNodes(): Promise<string[]>;
}

/** The real runner: spawns ffmpeg. */
export function realEncoderProbeRunner(ffmpegPath: string): EncoderProbeRunner {
  return {
    listed: () => availableEncoders(ffmpegPath),
    encodes: (chain, height) => testEncode(ffmpegPath, chain, height),
    renderNodes: () => listRenderNodes(),
  };
}

/**
 * Every encoder a user could pick for a codec on THIS machine, verified by encoding.
 *
 * ── WHY THIS IS A SEPARATE ROUTINE FROM `probeGpuEncoder` ────────────────────────────────────
 * `probeGpuEncoder` answers "which hardware encoder should we use?", and stops at the first that
 * works. The export page has to answer "which encoders exist at all?", which needs EVERY family
 * tried, not the first — reporting only the winner is exactly how the page came to say "no hardware
 * encoder on this machine" for H.264 while the machine had two of them.
 *
 * Verification is a real encode per candidate. Presence in `ffmpeg -encoders` means nothing here:
 * on the reference host qsv, amf, v4l2m2m and vulkan encoders are ALL listed and NONE encode, and
 * two of the three VAAPI render nodes reject every encode profile.
 */
export async function listEncodersFor(opts: {
  codec: VideoCodec;
  ffmpegPath?: string | undefined;
  /** Injected in tests; the real ffmpeg runner otherwise. */
  runner?: EncoderProbeRunner | undefined;
}): Promise<EncoderOption[]> {
  const platform: "linux" | "windows" = Deno.build.os === "windows" ? "windows" : "linux";
  const codec = opts.codec;
  const runner = opts.runner ?? realEncoderProbeRunner(opts.ffmpegPath ?? "ffmpeg");

  const out: EncoderOption[] = [];
  const sw = SOFTWARE_ENCODERS[codec];
  const listed = await runner.listed();
  // The software encoder is reported only if it is really there (a build without libsvtav1 would
  // otherwise offer an encoder that cannot run).
  if (listed.includes(sw.encoder)) {
    out.push({ encoder: sw.encoder, label: sw.label, backend: "cpu", codec, software: true });
  }

  const candidates = CANDIDATES.filter((c) =>
    c.codec === codec &&
    (c.platforms === null || c.platforms.includes(platform)) &&
    listed.includes(c.encoder),
  );

  // Enumerated once, not per candidate: the render-node list is a directory read.
  const nodes = candidates.some((c) => c.deviceArgs) ? await runner.renderNodes() : [];

  for (const c of candidates) {
    // VAAPI is enumerated per render node: the node is part of the choice, and only some nodes
    // encode. The label carries the node so two working nodes are distinguishable.
    const variants: Array<{ chain: BackendChain; dev?: string }> = c.deviceArgs
      ? nodes.map((dev) => ({
          chain: { ...c, hwaccelArgs: [...c.hwaccelArgs, ...c.deviceArgs!(dev)] },
          dev,
        }))
      : [{ chain: c }];

    for (const { chain: variant, dev } of variants) {
      if (!(await runner.encodes(variant, 360))) continue;
      const deviceArgs = c.deviceArgs && dev ? c.deviceArgs(dev) : undefined;
      out.push({
        encoder: c.encoder,
        label: `${BACKEND_LABEL[c.backend] ?? c.backend} ${CODEC_LABEL[codec]}` +
          // The VAAPI node is named because the same API can appear twice on a hybrid machine and
          // only one of them may encode.
          (dev ? ` (${dev.replace("/dev/dri/", "")})` : ""),
        backend: c.backend,
        codec,
        deviceArgs,
        software: false,
      });
    }
  }
  return out;
}

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
  const out = await run(ffmpegPath, { args: ["-hide_banner", "-encoders"] });
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
  try {
    // Output is discarded: this only asks whether the encoder accepts the work.
    const status = await Promise.race([
      runStatus(ffmpegPath, { args }),
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
  /**
   * The verified encoder binary for this backend (e.g. `h264_nvenc`).
   *
   * Absent on the CPU arm. Carried here because the export path needs to name the encoder it will
   * use, and re-deriving it by looking the backend up in CANDIDATES is a second mapping that can
   * disagree with what the probe actually verified.
   */
  encoder?: string | undefined;
  /** Verified device args (e.g. -vaapi_device /dev/dri/renderD128) — the
   *  work chain must reuse the probed device, not ffmpeg's default pick
   *  (which on multi-GPU machines can be a decode-only node). */
  deviceArgs?: string[] | undefined;
}

let cache: GpuCapability | null = null;
/** The codec `cache` was probed for — the probe is now per-codec, so the cache must be too. */
let cacheCodec: VideoCodec | null = null;
/** Backends that failed on real input this process — probe skips them. */
const blacklisted = new Set<GpuBackend>();
/** Probe once per process; Settings visits and proxy runs share the result. */
export async function probeGpuEncoderCached(codec: VideoCodec = "h264"): Promise<GpuCapability> {
  if (!cache || cacheCodec !== codec) {
    cacheCodec = codec;
    let cap = await probeGpuEncoder({ codec });
    if (cap.backend !== "cpu" && blacklisted.has(cap.backend)) {
      cap = await probeGpuEncoder({ skip: blacklisted });
    }
    cache = cap;
  }
  return cache;
}

/** Blacklist a backend that verified at probe time but failed on real
 *  input; the next proxy run re-probes with it excluded. */
export function blacklistGpuBackend(backend: GpuBackend): void {
  blacklisted.add(backend);
  cache = null;
}

export async function probeGpuEncoder(opts: { ffmpegPath?: string | undefined; forced?: GpuBackend | undefined; skip?: Set<GpuBackend> | undefined; codec?: VideoCodec | undefined } = {}): Promise<GpuCapability> {
  const ffmpegPath = opts.ffmpegPath ?? "ffmpeg";
  const platform: "linux" | "windows" = Deno.build.os === "windows" ? "windows" : "linux";

  const encoders = await availableEncoders(ffmpegPath);
  // Only candidates that encode the REQUESTED codec. Filtering here rather than at the call site is
  // what stops the probe from answering "h264_nvenc" to a question about AV1 — the mismatch that made
  // an AV1 export fall back to the CPU while claiming hardware was available.
  const codec = opts.codec ?? "h264";
  const candidates = CANDIDATES.filter((c) =>
    c.codec === codec &&
    (c.platforms === null || c.platforms.includes(platform)) &&
    encoders.includes(c.encoder),
  );

  for (const c of candidates) {
    if (opts.forced && c.backend !== opts.forced) continue;
    if (opts.skip?.has(c.backend)) continue;
    // VAAPI: try each render node — the first that passes wins. Render
    // nodes are enumerated generically (no /dev/dri on some systems).
    const deviceVariants: Array<{ chain: typeof c; dev?: string }> = c.deviceArgs
      ? (await listRenderNodes()).map((dev) => ({
          chain: { ...c, hwaccelArgs: [...c.hwaccelArgs, ...c.deviceArgs!(dev)] },
          dev,
        }))
      : [{ chain: c }];
    for (const { chain: variant, dev } of deviceVariants) {
      if (await testEncode(ffmpegPath, variant, 540)) {
        return {
          backend: c.backend,
          ok: true,
          reason: `${c.encoder} verified (${variant.hwaccelArgs.join(" ")})`,
          encoder: c.encoder,
          deviceArgs: c.deviceArgs && dev ? c.deviceArgs(dev) : undefined,
        };
      }
    }
  }
  return { backend: "cpu", ok: true, reason: "no usable hardware encoder — CPU path" };
}

/** Map a probed capability to concrete proxy-args fragments. */
export function proxyEncodeArgs(cap: GpuCapability, height: number, codec: VideoCodec = "h264"): {
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
  // Matched on the CODEC too: the probe is per-codec now, and several candidates share a backend
  // (nvenc exposes both h264_nvenc and av1_nvenc), so matching on the backend alone would return
  // whichever happens to come first in the list.
  const c = CANDIDATES.find((x) => x.backend === cap.backend && x.codec === codec)!;
  return {
    hwaccelArgs: [...c.hwaccelArgs, ...(cap.deviceArgs ?? [])],
    vf: c.workVf.replace("{H}", String(height)),
    encoderArgs: ["-c:v", c.encoder, ...c.encoderArgs],
  };
}