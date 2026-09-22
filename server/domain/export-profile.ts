/**
 * Turning an export PROFILE into ffmpeg arguments.
 *
 * Pure and separate from the adapter so every rule below can be tested without spawning anything —
 * the arithmetic here is where exports go silently wrong (an upscaled "cap", a hardware encoder
 * handed a CPU `-crf`, a crop-then-scale order that distorts).
 */
import type {
  AudioCodec,
  Container,
  ExportPreset,
  ExportProfile,
  VideoCodec,
} from "shared/types";
import {
  type EncoderChoice,
  MEASURED_ENCODER_DEFAULTS,
  hardwareQualityFor,
  sensibleBitrateKbps,
  validateExportProfile,
} from "shared/types";

/**
 * Which shipped presets a database is MISSING, and must therefore be written.
 *
 * ── WHY THIS IS ITS OWN FUNCTION ─────────────────────────────────────────────────────────────
 * The seeder in the container used to gate on `presets.length === 0`. That was correct while nothing
 * else wrote preset rows: a fresh database arrived empty and received the whole shipped set. The
 * migration chain then began inserting `preset-landscape-169` (0.7.0 adds it, because an existing
 * user needs it too), so the table was NEVER empty at boot — the gate was skipped every time, and a
 * first-run user received exactly ONE preset. Measured on a real first boot: `count: 1`.
 *
 * The gate's actual purpose is not "has this database been seeded" but "must I avoid overwriting a
 * row the user has edited". Answering that per ID is what this does, and it is why the fix is not
 * "always save the defaults": that was the older behaviour, and it silently reverted a user's edits
 * on the next restart.
 *
 * Kept here rather than inline in the container so the rule is testable without booting the app —
 * the container pulls in adapters, the file system and the network.
 */
export function missingShippedPresets(
  shipped: readonly ExportPreset[],
  stored: readonly { id: string }[],
): ExportPreset[] {
  const present = new Set(stored.map((p) => p.id));
  return shipped.filter((p) => !present.has(p.id));
}

/**
 * Whether to use the hardware encoder for this export.
 *
 * MEASURED crossover on the reference host (1080p60, crop + 720p cap + burned captions):
 *
 *   export   wall cpu→hw     cpu-time cpu→hw
 *   5s       0.54→0.83s       5.59→2.93s
 *   15s      1.21→1.12s      15.76→7.01s
 *   30s      2.15→1.75s      31.24→13.09s
 *   50s      3.75→2.44s      52.56→22.52s
 *
 * So hardware ALWAYS halves the CPU time but only beats software in wall-clock above ~10s, where
 * the fixed cost of uploading the frames stops dominating. Below that, the upload costs more than
 * the encode saves.
 *
 * This is GUIDANCE, not a gate. It was measured for H.264, where libx264 is fast enough to compete —
 * it does not transfer to a codec like AV1, whose software encoder is far slower, and applying it as
 * a silent rule would also override an explicit user choice. Where it belongs is the UI, telling the
 * user that hardware is slower below ~10s, and letting them decide.
 */
export const HW_WALL_CLOCK_CROSSOVER_SEC = 10;

export function shouldUseHardware(input: {
  /** A probed, verified encoder for THIS codec, or null. */
  hardwareEncoder: string | null;
  videoCodec: VideoCodec;
  durationSec: number;
  /**
   * What the profile asks for: `auto` (the measured per-codec default), or an explicit choice.
   *
   * An explicit `hardware` is honoured even below the wall-clock crossover — the crossover is about
   * WALL CLOCK, and a user may deliberately prefer hardware to free the CPU for other work, which is
   * a different objective that the measurement does not speak to.
   */
  encoder: EncoderChoice;
  /**
   * A concrete encoder the user picked from the machine's own list (e.g. `h264_vaapi`).
   *
   * Optional so every existing caller and profile still works. When present it is not just a hint:
   * the profile is asking for THAT encoder, and the caller passes it in as `hardwareEncoder`, so a
   * mismatch between the two means the probed candidate cannot honour the request.
   */
  requestedEncoder?: string | null | undefined;
}): boolean {
  // No probed encoder for this codec means hardware is not available at all, whatever was asked for.
  if (!input.hardwareEncoder) return false;
  // The probed encoder must BE for this codec. A mismatch would produce a file that cannot be muxed,
  // which is the worst outcome: it fails at the last step, after the whole encode.
  if (encoderCodecOf(input.hardwareEncoder) !== input.videoCodec) return false;
  if (input.encoder === "software") return false;
  if (input.encoder === "hardware") return true;
  // `auto` is the measured PER-CODEC default and nothing else. It deliberately does NOT consult the
  // wall-clock crossover: H.264 is a software-default codec, so a long H.264 clip must stay on
  // libx264 even though hardware would be faster in wall clock there. Two measurements disagree
  // (hardware wins on time above ~10s, loses on nothing at matched quality), and the owner's
  // decision settles it: hardware is the DEFAULT per codec, so H.264 belongs on the CPU and AV1 on
  // the GPU. The crossover is surfaced to the user as guidance instead of silently overriding them.
  return MEASURED_ENCODER_DEFAULTS[input.videoCodec] === "hardware";
}

/**
 * The ffmpeg encoder name that will actually run, from the decisions above.
 *
 * Extracted so the precedence is explicit and testable rather than a nested `??` chain the compiler
 * rightly distrusted: a NAMED encoder outranks everything (it is the user's own pick from the machine's
 * verified list), then an explicitly probed/named hardware encoder, then an explicitly named software
 * encoder, then the per-codec software default. It cannot return null — every branch has a fallback,
 * because returning null here would produce an ffmpeg command with no `-c:v` at all.
 */
export function resolveEncoder(input: {
  useHardware: boolean;
  hardwareEncoder: string | null;
  softwareEncoder: string | null;
  named: { encoder: string; hardware: boolean } | null;
  codec: VideoCodec;
}): string {
  if (input.named) return input.named.encoder;
  if (input.useHardware && input.hardwareEncoder) return input.hardwareEncoder;
  if (input.softwareEncoder) return input.softwareEncoder;
  return SOFTWARE_ENCODERS[input.codec];
}

/**
 * The codec an encoder NAME belongs to, or null when it is not recognized.
 *
 * Necessary because the naming is not uniform: H.265's encoders are called `hevc_nvenc`, not
 * `h265_nvenc`, so a naive prefix comparison against the codec id would reject the correct encoder
 * for H.265 while accepting `h264_nvenc` for it. The probe reports the encoder per codec, and this
 * is what verifies that what came back is actually for the codec being exported.
 */
export function encoderCodecOf(encoder: string): VideoCodec | null {
  const base = encoder.split("_")[0];
  if (base === "h264" || base === "avc") return "h264";
  if (base === "hevc" || base === "h265") return "h265";
  if (base === "vp9" || base === "vp8") return "vp9";
  if (base === "av1") return "av1";
  return null;
}

/** One encoder choice: what to name it, whether it is hardware, and how it takes quality. */
export interface EncoderPlan {
  encoder: string;
  hardware: boolean;
  /** Args carrying rate control, mapped PER BACKEND. */
  qualityArgs: string[];
}

/**
 * The codec matrix, software arms.
 *
 * Hardware arms are NOT listed here: `h264_nvenc` and friends are only candidates for H.264 (see
 * references/gpu-encode.md — no probed hardware encoder exists for H.265/VP9 in this stack), and
 * the capability probe decides at runtime which one is usable.
 */
const SOFTWARE_ENCODERS: Record<VideoCodec, string> = {
  h264: "libx264",
  h265: "libx265",
  vp9: "libvpx-vp9",
  av1: "libsvtav1",
};

const AUDIO_ENCODERS: Record<Exclude<AudioCodec, "none">, string> = {
  aac: "aac",
  opus: "libopus",
  // The built-in `vorbis` encoder is experimental in ffmpeg (it warns and is marked X); `libvorbis`
  // is the reference encoder and the only one worth shipping.
  vorbis: "libvorbis",
  mp3: "libmp3lame",
  // FLAC is lossless, so it HAS no bitrate — see AUDIO_BITRATES, which is why a rate must not be
  // passed for it. `-b:a` on a flac encoder is ignored at best and a hard error on some builds.
  flac: "flac",
  pcm_s16le: "pcm_s16le",
  pcm_s24le: "pcm_s24le",
};

/**
 * The rate for a LOSSY codec, in kbps. `null` means the codec takes no rate at all.
 *
 * Per CODEC, not per container: Opus and Vorbis do not deliver the same quality at the same number,
 * and Vorbis needs a noticeably higher rate to match Opus. Deriving it from the container made the
 * WebM arm's audio quality depend on which codec happened to be chosen.
 *
 * FLAC and the PCM codecs are LOSSLESS and unbounded by a bitrate — passing `-b:a` to them is
 * meaningless, so they are `null` here and the argument is omitted entirely rather than defaulted to
 * a number that would silently do nothing.
 */
const AUDIO_BITRATES: Record<Exclude<AudioCodec, "none">, string | null> = {
  aac: "128k",
  opus: "96k",
  // Vorbis needs more bits than Opus for the same quality.
  vorbis: "160k",
  mp3: "192k",
  flac: null,
  pcm_s16le: null,
  pcm_s24le: null,
};

/**
 * Rate control for a hardware encoder, mapped per backend.
 *
 * The flags are NOT interchangeable: `-crf` is silently ignored by nvenc/qsv/vaapi and a hard error
 * on some builds, so a CPU quality number must never be forwarded as-is.
 *
 * `codec` is required because the QUALITY NUMBER is not transferable between encoders either. The
 * caller passes the already-MAPPED `hardwareQuality` — see `hardwareQualityFor` — and it is a
 * separate argument from a software CRF on purpose, so the two scales cannot be confused at a call
 * site.
 *
 * `maxBitrateKbps` is now OPT-IN (`profile.maxBitrateKbps`) rather than an automatic ceiling. The
 * automatic one was compensating for the scale mismatch this mapping fixes: at a MATCHED quality,
 * nvenc lands at parity with libx264 (measured 13.11 MB vs 13.26 MB at VMAF 92.0 vs 92.6), so
 * capping by default would have been the band-aid rather than the fix.
 */
export function hardwareQualityArgs(
  encoder: string,
  hardwareQuality: number,
  codec: VideoCodec,
  maxBitrateKbps: number | null,
): string[] {
  const vbr = maxBitrateKbps !== null
    ? ["-b:v", `${maxBitrateKbps}k`, "-maxrate", `${Math.round(maxBitrateKbps * 2)}k`]
    : ["-b:v", "0"];
  if (encoder.endsWith("_nvenc")) {
    // The quality features are OFF at NVENC's defaults, and they are what make a constant-quality
    // encode actually constant-quality rather than merely fast: no lookahead and no adaptive
    // quantisation means the rate control cannot see a scene change coming. Measured as neutral on
    // size (they made it ~4% bigger at the same cq and marginally better), so they are enabled for
    // the quality, not for the bytes.
    const quality: string[] = ["-tune", "hq", "-rc-lookahead", "32", "-spatial-aq", "1"];
    const bframes = encoder.startsWith("av1") ? [] : ["-b_ref_mode", "middle"];
    return ["-cq", String(hardwareQuality), ...vbr, ...quality, ...bframes];
  }
  if (encoder.endsWith("_qsv")) return ["-global_quality", String(hardwareQuality), ...vbr];
  if (encoder.endsWith("_vaapi")) {
    // CQP, not VBR: `-qp` is the CONSTANT-QP control, and pairing it with VBR is a contradiction ffmpeg
    // rejects outright — MEASURED on the reference host: `-rc_mode VBR -qp N` exits 234 with
    // "Could not open encoder before EOF" and writes nothing, while `-rc_mode CQP -qp N` encodes at the
    // same speed. VBR was silently making every VAAPI export fail and fall back to the CPU.
    //
    // With a forced bitrate the rate control is genuinely VBR, and then there is no constant qp to set:
    // the bitrate IS the control.
    if (maxBitrateKbps !== null) return ["-rc_mode", "VBR", "-b:v", `${maxBitrateKbps}k`, "-maxrate", `${Math.round(maxBitrateKbps * 2)}k`];
    return ["-rc_mode", "CQP", "-qp", String(hardwareQuality), "-b:v", "0"];
  }
  if (encoder.endsWith("_amf")) return ["-rc", "vbr_peak", "-qp_i", String(hardwareQuality), "-qp_p", String(hardwareQuality), ...vbr];
  // Unknown hardware arm: no quality flag it might reject. With no ceiling either that leaves
  // the encoder at its own default rate control, which is honest and encodable rather than
  // "correct-looking" and broken.
  void codec;
  return [...vbr];
}

/** The software arm's quality/rate-control pair. */
export function softwareQualityArgs(codec: VideoCodec, quality: number): string[] {
  switch (codec) {
    case "h264": return ["-crf", String(quality), "-preset", "medium"];
    case "h265": return ["-crf", String(quality), "-preset", "medium", "-tag:v", "hvc1"];
    case "vp9": return ["-crf", String(quality), "-b:v", "0", "-row-mt", "1"];
    case "av1": return ["-crf", String(quality), "-preset", "6"];
  }
}

/**
 * The video filter chain: CROP first, then the resolution CAP, then captions.
 *
 * Order matters and is not cosmetic. Crop before scale, so an aspect crop cuts the source frame and
 * the cap then applies to the result; scaling first would compute the cap against the uncropped
 * frame and could crop away part of the scaled image. The cap is applied ONLY when the source
 * actually exceeds it — a "cap" that upscales turns a 480p source into a 1080p file and pads the
 * export with invented pixels.
 */
export function videoFilters(input: {
  profile: Pick<ExportProfile, "aspectRatio" | "maxHeight" | "captions">;
  /** The generated transcript, if any. A runtime fact, not part of the profile: the style below is
   *  a preference that exists whether or not a transcript does. */
  srtPath: string | null;
  sourceWidth: number;
  sourceHeight: number;
  escapePath: (p: string) => string;
  captionStyle: (c: ExportProfile["captions"]) => string;
}): string[] {
  const filters: string[] = [];
  const { aspectRatio, maxHeight, captions } = input.profile;
  let width = input.sourceWidth;
  let height = input.sourceHeight;

  if (aspectRatio !== "16:9") {
    const targetAspect = aspectRatio === "9:16" ? 9 / 16 : 1;
    let cw: number, ch: number;
    if (width / height > targetAspect) {
      ch = height - (height % 2);
      cw = Math.round(ch * targetAspect) - (Math.round(ch * targetAspect) % 2);
    } else {
      cw = width - (width % 2);
      ch = Math.round(cw / targetAspect) - (Math.round(cw / targetAspect) % 2);
    }
    // Centred. The crop was selectable (top/centre/bottom) and is not any more: a vertical crop of a
    // 16:9 source has no better answer than the middle, and offering three positions invited the user
    // to cut off heads or feet while looking for one that framing had already chosen.
    const cropY = Math.floor((height - ch) / 2);
    const cropX = Math.floor((width - cw) / 2);
    filters.push(`crop=${cw}:${ch}:${cropX}:${cropY}`);
    width = cw;
    height = ch;
  }

  if (maxHeight !== null && height > maxHeight) {
    // -2 keeps the other axis even AND derived from the source's own aspect, so no distortion.
    filters.push(`scale=-2:${maxHeight}`);
  }

  if (captions.enabled && input.srtPath) {
    filters.push(
      `subtitles=${input.escapePath(input.srtPath)}:force_style='${input.captionStyle(captions)}'`,
    );
  }
  return filters;
}

/**
 * The audio args, or nothing at all when the profile asks for silence.
 *
 * The bitrate is per CODEC, not per container: Opus and Vorbis do not deliver the same quality at the
 * same number, and Vorbis needs a noticeably higher rate to match Opus. Deriving it from the
 * container made the WebM arm's audio quality depend on which codec happened to be chosen.
 */
export function audioArgs(container: Container, audio: AudioCodec): string[] {
  if (audio === "none") return ["-an"];
  const encoder = AUDIO_ENCODERS[audio];
  const kbps = AUDIO_BITRATES[audio];
  // A LOSSLESS codec gets no `-b:a` at all. Passing one is not harmless: it is ignored, so the
  // argument list would claim a rate the encoder never used — a lie in the command we log.
  if (kbps === null) return ["-c:a", encoder];
  return ["-c:a", encoder, "-b:a", kbps];
}

/**
 * Assemble the whole argument list, refusing an impossible profile by name.
 *
 * `hardwareEncoder` is the probed-and-verified encoder for THIS codec, or null for the software arm
 * — the probe is the caller's business, but the mapping from its answer to arguments is this
 * function's, so the two cannot drift.
 */
export function buildExportArgs(input: {
  profile: ExportProfile;
  startTime: number;
  endTime: number;
  vodPath: string;
  outputPath: string;
  sourceWidth: number;
  sourceHeight: number;
  /** The generated transcript to burn in, or null when none exists. */
  srtPath: string | null;
  hardwareEncoder?: string | null | undefined;
  /**
   * A software encoder the user NAMED, overriding the per-codec default table.
   *
   * The table (`SOFTWARE_ENCODERS`) is the sensible default and stays the answer when nothing is
   * named; this exists so an explicit pick is not silently replaced by that table.
   */
  softwareEncoder?: string | null | undefined;
  /**
   * Device initialisation the chosen hardware encoder requires (e.g. `-vaapi_device /dev/dri/renderD128`).
   *
   * Supplied by the caller because only the PROBE knows which device verified: on a hybrid machine
   * several nodes exist and only some encode, so letting ffmpeg choose can pick a decode-only node.
   */
  deviceArgs?: string[] | undefined;
  /**
   * An encoder the user NAMED from this machine's list, which SETTLES the hardware question.
   *
   * Required because a name is itself the decision. `shouldUseHardware` answers from the profile's
   * `encoder` field alone, so a profile naming `h264_nvenc` while leaving `encoder` at `auto` — which
   * is exactly what picking one from the list produces — was decided by the per-codec default instead
   * and quietly ran libx264 on the CPU. A live probe caught all three named arms reporting `cpu`.
   */
  namedEncoder?: { encoder: string; hardware: boolean } | null | undefined;
  escapePath: (p: string) => string;
  captionStyle: (c: ExportProfile["captions"]) => string;
}): string[] {
  const { profile } = input;
  const check = validateExportProfile({
    container: profile.container,
    videoCodec: profile.videoCodec,
    audioCodec: profile.audioCodec,
    maxHeight: profile.maxHeight,
  });
  if (!check.ok) throw new Error(`Invalid export profile: ${check.reason}`);

  const duration = input.endTime - input.startTime;
  if (!(duration > 0)) throw new Error(`Invalid clip duration: ${duration}s`);

  const outputHeight = outputHeightFor(input.sourceHeight, input.sourceWidth, profile);
  /**
   * A NAMED encoder settles the hardware question before the profile's default is consulted.
   *
   * Ordered this way on purpose: the name is the more specific statement, and the profile's `encoder`
   * field was being allowed to overrule it — which silently ran libx264 for a profile naming
   * `h264_nvenc`. Nothing named falls through to the profile's own choice.
   */
  const named = input.namedEncoder ?? null;
  const useHardware = named
    ? named.hardware
    : shouldUseHardware({
      hardwareEncoder: input.hardwareEncoder ?? null,
      videoCodec: profile.videoCodec,
      durationSec: duration,
      encoder: profile.encoder,
    });
  const encoder = resolveEncoder({
    useHardware,
    hardwareEncoder: input.hardwareEncoder ?? null,
    softwareEncoder: input.softwareEncoder ?? null,
    named,
    codec: profile.videoCodec,
  });

  const filters = videoFilters({
    profile,
    srtPath: input.srtPath,
    sourceWidth: input.sourceWidth,
    sourceHeight: input.sourceHeight,
    escapePath: input.escapePath,
    captionStyle: input.captionStyle,
  });

  const args = [
    "-y",
    "-ss", String(input.startTime),
    "-t", String(duration),
    "-i", input.vodPath,
    "-nostats",
    // Machine-readable progress on stdout. NOT parsed from the human stats on stderr: this is the
    // documented interface, and `-nostats` keeps the noisy version off stderr entirely.
    "-progress", "pipe:1",
    "-loglevel", "error",
  ];
  args.push("-c:v", encoder);
  if (useHardware) {
    // Device args FIRST: vaapi and qsv need their device initialized before any filter references it,
    // and the probed node must be reused rather than letting ffmpeg pick one (on a hybrid machine it
    // can pick a decode-only node — measured on the reference host, where renderD129/130 reject every
    // encode profile).
    if (input.deviceArgs && input.deviceArgs.length > 0) args.push(...input.deviceArgs);
    // A ceiling is supplied when the profile does not state one: measured 2.1x the size otherwise.
    // The quality is MAPPED onto this encoder's own scale. Forwarding the software number was the
    // defect behind "hardware makes the file 2.1x bigger": at `-cq 23` nvenc was simply being asked
    // for a HIGHER quality than `-crf 23` (measured VMAF 96.7 vs 92.6) and delivering it.
    const hwQuality = hardwareQualityFor(profile.videoCodec, profile.options.quality);
    // The ceiling is now opt-in. The automatic one was compensating for that same scale mismatch;
    // at a matched quality nvenc lands at parity (13.11 MB vs 13.26 MB at VMAF 92.0 vs 92.6), so
    // capping by default would cap a file that is not oversized.
    args.push(...hardwareQualityArgs(encoder, hwQuality, profile.videoCodec, profile.options.maxBitrateKbps));
    // Software frames must be converted to the encoder's own format before upload. Omitting this
    // fails on NVENC/qsv with "Pixel format 'yuv420p' is not supported" — and the frames are
    // already software here, because the crop and the caption burn-in both need them that way.
    filters.push("format=nv12", HW_UPLOAD_FOR[encoder] ?? "hwupload");
  } else {
    args.push(...softwareQualityArgs(profile.videoCodec, profile.options.quality));
  }
  // ONE -vf carries the whole chain: a second -vf would silently replace the first, dropping the
  // crop and the captions.
  if (filters.length > 0) args.push("-vf", filters.join(","));
  args.push(...audioArgs(profile.container, profile.audioCodec));
  if (profile.container === "mp4") args.push("-movflags", "+faststart");
  args.push(input.outputPath);
  return args;
}

/**
 * The pixel-format conversion each hardware encoder needs before software frames can be uploaded.
 *
 * `hwupload` (VAAPI) converts implicitly; CUDA and QSV do not and reject yuv420p outright, so the
 * format is named per encoder rather than assumed to be uniform.
 */
export const HW_UPLOAD_FOR: Record<string, string> = {
  h264_nvenc: "hwupload_cuda",
  // av1_nvenc needs the SAME CUDA upload as h264_nvenc. It was absent from this map, so the lookup
  // fell through to the bare `hwupload`, which requires a device reference and fails with
  // "A hardware device reference is required to upload frames to" — the AV1 hardware arm could never
  // have worked. MEASURED on the reference host: `format=nv12,hwupload` fails, `hwupload_cuda` works,
  // for both nvenc encoders.
  av1_nvenc: "hwupload_cuda",
  hevc_nvenc: "hwupload_cuda",
  // QSV needs `extra_hw_frames`: the encoder holds frames in flight and the default pool is too small
  // for a filter chain that includes scaling.
  h264_qsv: "hwupload=extra_hw_frames=64",
  av1_qsv: "hwupload=extra_hw_frames=64",
  hevc_qsv: "hwupload=extra_hw_frames=64",
  vp9_qsv: "hwupload=extra_hw_frames=64",
  h264_amf: "hwupload",
  // ALL the VAAPI encoders take the bare form, which converts implicitly once a device was
  // initialized. MEASURED on the reference host: the AMD iGPU (renderD128) encodes h264 and hevc this
  // way, and requires `-vaapi_device` to be present (see `deviceArgs`).
  h264_vaapi: "hwupload",
  hevc_vaapi: "hwupload",
  av1_vaapi: "hwupload",
  vp9_vaapi: "hwupload",
};

/**
 * The height the export will actually have, after the crop and the cap.
 *
 * Needed for the default bitrate ceiling: the ceiling must describe the file being produced, not
 * the source it was cut from.
 */
export function outputHeightFor(
  sourceHeight: number,
  sourceWidth: number,
  profile: Pick<ExportProfile, "aspectRatio" | "maxHeight">,
): number {
  let height = sourceHeight;
  if (profile.aspectRatio !== "16:9") {
    const targetAspect = profile.aspectRatio === "9:16" ? 9 / 16 : 1;
    if (sourceWidth / sourceHeight > targetAspect) {
      height = sourceHeight - (sourceHeight % 2);
    } else {
      const cw = sourceWidth - (sourceWidth % 2);
      height = Math.round(cw / targetAspect) - (Math.round(cw / targetAspect) % 2);
    }
  }
  return profile.maxHeight !== null && height > profile.maxHeight ? profile.maxHeight : height;
}
