/**
 * Export profile → ffmpeg arguments.
 *
 * The rules here are the difference between an export that is what the user asked for and one that
 * silently is not: an upscaled "cap", a hardware encoder handed a CPU quality flag, a crop applied
 * after the scale. All are arithmetic, so all are pinned here rather than discovered by watching a
 * wrong file come out.
 */
import { assertEquals, assert, assertThrows } from "@std/assert";
import {
  audioArgs,
  buildExportArgs,
  hardwareQualityArgs,
  resolveEncoder,
  softwareQualityArgs,
  videoFilters,
} from "../domain/export-profile.ts";
import {
  CODEC_QUALITY_BANDS,
  hardwareQualityFor,
  normaliseProfile,
  type ExportProfile,
  validateExportProfile,
} from "shared/types";

const NO_CAPTION = { enabled: false, preset: "bold-white" as const, position: "bottom" as const, fontSize: 32, backgroundOpacity: 0.5 };
const esc = (p: string) => p.replace(/:/g, "\\:");
const style = () => "FontName=Inter,FontColor=white";

const profile = (over: Partial<ExportProfile> = {}): ExportProfile => ({
  container: "mp4",
  videoCodec: "h264",
  audioCodec: "aac",
  maxHeight: null,
  encoder: "auto",
  encoderName: null,
  options: { quality: 20, maxBitrateKbps: null },
  aspectRatio: "16:9",
  captions: NO_CAPTION,
  nameTemplate: "{date}-{channel}",
  ...over,
});

Deno.test("the compatibility matrix refuses an impossible combination BY NAME", () => {
  // Normalising silently would hand the user an H.264 file labelled VP9 — the failure mode where
  // the output looks fine and is not what was asked for.
  const vp9InMp4 = validateExportProfile({ container: "mp4", videoCodec: "vp9", maxHeight: null });
  assertEquals(vp9InMp4.ok, false);
  assert(vp9InMp4.ok === false && vp9InMp4.reason.includes("VP9"), "the reason names the codec");

  // H.264-in-WebM is the case that CANNOT be produced at all: the WebM muxer refuses it outright,
  // because WebM is a strict Matroska subset. Measured on a stream copy AND a re-encode.
  const h264InWebm = validateExportProfile({ container: "webm", videoCodec: "h264", maxHeight: null });
  assertEquals(h264InWebm.ok, false);

  // And it accepts the legal pairings.
  assertEquals(validateExportProfile({ container: "mp4", videoCodec: "h264", maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: "webm", videoCodec: "vp9", maxHeight: null }).ok, true);
  // AV1 is legal in WEBM only. `av1` in an MP4 was offered once and is now withdrawn — the codec
  // muxes, but almost nothing consumes it, so the container (which is what decides where a file can
  // go) wins.
  assertEquals(validateExportProfile({ container: "webm", videoCodec: "av1", maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: "mp4", videoCodec: "av1", maxHeight: null }).ok, false);
  // Matroska takes H.264 and H.265 — the format of a local library. This is the pairing that had no
  // home before, since neither MP4 nor WebM could stand in for it.
  assertEquals(validateExportProfile({ container: "mkv", videoCodec: "h264", maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: "mkv", videoCodec: "h265", maxHeight: null }).ok, true);
  // VP9 in Matroska is technically muxable but is NOT offered, and the matrix is the single owner of
  // what is offerable — so it is refused by name rather than silently permitted.
  assertEquals(validateExportProfile({ container: "mkv", videoCodec: "vp9", maxHeight: null }).ok, false);
});

Deno.test("the audio codec is checked against the container, not assumed", () => {
  const aacInWebm = validateExportProfile({
    container: "webm", videoCodec: "vp9", audioCodec: "aac", maxHeight: null,
  });
  assertEquals(aacInWebm.ok, false);
  // Opus in an MP4 is MEASURED-LEGAL (ffmpeg writes it, exit 0) but deliberately NOT OFFERED, and the
  // refusal is the honest way to express that: the matrix is what the app accepts, and a combination
  // it will not offer must not be silently accepted either. Opus-in-MP4 is poorly supported by
  // consumers, which is exactly why Opus belongs in WebM and in Matroska.
  const opusInMp4 = validateExportProfile({
    container: "mp4", videoCodec: "h264", audioCodec: "opus", maxHeight: null,
  });
  assertEquals(opusInMp4.ok, false, "legal to mux, but withheld — so it must be refused, not accepted");
  // ...and the containers where Opus DOES belong accept it.
  assertEquals(
    validateExportProfile({ container: "webm", videoCodec: "vp9", audioCodec: "opus", maxHeight: null }).ok,
    true,
  );
  assertEquals(
    validateExportProfile({ container: "mkv", videoCodec: "h264", audioCodec: "opus", maxHeight: null }).ok,
    true,
  );
  // PCM in an MP4 is legal too; PCM in a WEBM is not, and that is the refusal that still holds.
  assertEquals(
    validateExportProfile({ container: "mp4", videoCodec: "h264", audioCodec: "pcm_s16le", maxHeight: null }).ok,
    true,
  );
  assertEquals(
    validateExportProfile({ container: "webm", videoCodec: "vp9", audioCodec: "pcm_s16le", maxHeight: null }).ok,
    false,
  );
  assertEquals(
    validateExportProfile({ container: "webm", videoCodec: "vp9", audioCodec: "flac", maxHeight: null }).ok,
    false,
  );
  // Silence is legal everywhere, which is what makes a muted export possible at all.
  assertEquals(
    validateExportProfile({ container: "webm", videoCodec: "vp9", audioCodec: "none", maxHeight: null }).ok,
    true,
  );
  assertEquals(
    validateExportProfile({ container: "mkv", videoCodec: "h264", audioCodec: "none", maxHeight: null }).ok,
    true,
  );
});

Deno.test("a resolution cap NEVER upscales", () => {
  // A 480p source with a 1080 cap must produce NO scale filter: scaling up would invent pixels and
  // pad the export to a size the source never had.
  const smaller = videoFilters({
    profile: profile({ maxHeight: 1080 }), srtPath: null,
    sourceWidth: 854, sourceHeight: 480, escapePath: esc, captionStyle: style,
  });
  assertEquals(smaller, []);

  // A larger source is capped.
  const larger = videoFilters({
    profile: profile({ maxHeight: 720 }), srtPath: null,
    sourceWidth: 1920, sourceHeight: 1080, escapePath: esc, captionStyle: style,
  });
  assertEquals(larger, ["scale=-2:720"]);

  // EXACTLY at the cap is not over it — no needless re-encode.
  const exact = videoFilters({
    profile: profile({ maxHeight: 720 }), srtPath: null,
    sourceWidth: 1280, sourceHeight: 720, escapePath: esc, captionStyle: style,
  });
  assertEquals(exact, []);
});

Deno.test("crop comes BEFORE scale, and the cap applies to the cropped frame", () => {
  const f = videoFilters({
    profile: profile({ aspectRatio: "9:16", maxHeight: 720 }),
    srtPath: null,
    sourceWidth: 1920, sourceHeight: 1080, escapePath: esc, captionStyle: style,
  });
  // 1080-tall source cropped to 9:16 → 608x1080 (even), then capped to 720.
  assertEquals(f.length, 2);
  assert((f[0] ?? "").startsWith("crop=608:1080:"), `crop first, got ${f[0]}`);
  assertEquals(f[1], "scale=-2:720");
  // Order is the assertion: scaling first would compute the cap against the uncropped height.
  assert(f.indexOf(f[0] ?? "") < f.indexOf(f[1] ?? ""), "the crop precedes the scale");
});

Deno.test("a non-16:9 crop is CENTRED, and the crop cannot be placed elsewhere", () => {
  // The crop used to be selectable (top/centre/bottom) and is not any more. What must hold now is
  // that the crop centres on the source frame, and that there is no field left through which a
  // caller could move it — the offsets are computed, not read from the profile.
  const base = { aspectRatio: "1:1" as const, maxHeight: null };
  const yOf = (s: string | undefined) => Number((s ?? "").split(":")[3]);
  const xOf = (s: string | undefined) => Number((s ?? "").split(":")[2]);

  // 1080x1920 source: a 1:1 crop is 1080x1080, so 840 rows are distributed and centring takes 420.
  const tall = videoFilters({
    profile: profile(base), srtPath: null,
    sourceWidth: 1080, sourceHeight: 1920, escapePath: esc, captionStyle: style,
  });
  assertEquals(yOf(tall[0]), 420);
  assertEquals(xOf(tall[0]), 0);

  // A 16:9 source cropped square is limited by height, so y is 0 and x distributes.
  const wide = videoFilters({
    profile: profile(base), srtPath: null,
    sourceWidth: 1920, sourceHeight: 1080, escapePath: esc, captionStyle: style,
  });
  assertEquals(yOf(wide[0]), 0);
  assertEquals(xOf(wide[0]), 420);

  // Even dimensions are guaranteed (yuv420 needs them).
  for (const s of [...tall, ...wide]) {
    const parts = s.replace("crop=", "").split(":").map(Number);
    const w = parts[0] ?? 0;
    const h = parts[1] ?? 0;
    assertEquals(w % 2, 0, `width not even in ${s}`);
    assertEquals(h % 2, 0, `height not even in ${s}`);
  }
});

Deno.test("captions burn in only when a transcript actually exists", () => {
  const enabled = NO_CAPTION; // enabled: false
  assertEquals(
    videoFilters({ profile: profile({ captions: enabled }), srtPath: "/tmp/a.srt", sourceWidth: 1920, sourceHeight: 1080, escapePath: esc, captionStyle: style }),
    [],
  );
  // Enabled with no transcript must NOT emit a subtitles filter pointing at nothing — ffmpeg would
  // fail the whole export on a missing file.
  assertEquals(
    videoFilters({
      profile: profile({ captions: { ...NO_CAPTION, enabled: true } }), srtPath: null,
      sourceWidth: 1920, sourceHeight: 1080, escapePath: esc, captionStyle: style,
    }),
    [],
  );
  const burned = videoFilters({
    profile: profile({ captions: { ...NO_CAPTION, enabled: true } }), srtPath: "/tmp/a.srt",
    sourceWidth: 1920, sourceHeight: 1080, escapePath: (p) => p.replace(/:/g, "\\:"), captionStyle: style,
  });
  assertEquals(burned.length, 1);
  assert((burned[0] ?? "").startsWith("subtitles=/tmp/a.srt"), burned[0]);
});

Deno.test("a CPU quality flag is NEVER handed to a hardware encoder", () => {
  // -crf is silently ignored by nvenc/qsv/vaapi and an error on some builds; each backend takes its
  // own rate control.
  assert(!hardwareQualityArgs("h264_nvenc", 26, "h264", 3000).includes("-crf"));
  assertEquals(hardwareQualityArgs("h264_nvenc", 26, "h264", 3000)[0], "-cq");
  assertEquals(hardwareQualityArgs("h264_qsv", 26, "h264", 3000)[0], "-global_quality");
  // VAAPI must use CQP with `-qp`: pairing a constant QP with VBR is contradictory and ffmpeg refuses
  // it (exit 234, nothing written), which made every VAAPI export fail and silently fall back to CPU.
  assertEquals(hardwareQualityArgs("h264_vaapi", 26, "h264", null).slice(0, 2), ["-rc_mode", "CQP"]);
  // With a forced bitrate the control IS the bitrate, so no constant QP is set.
  assertEquals(hardwareQualityArgs("h264_vaapi", 26, "h264", 3000).slice(0, 2), ["-rc_mode", "VBR"]);
  assert(!hardwareQualityArgs("h264_vaapi", 26, "h264", 3000).includes("-qp"));
  assertEquals(hardwareQualityArgs("h264_amf", 26, "h264", 3000).slice(0, 2), ["-rc", "vbr_peak"]);
  // With a ceiling, the bitrate cap rides along (uncapped nvenc spirals — measured 3.7x).
  assert(hardwareQualityArgs("h264_nvenc", 26, "h264", 3000).includes("-maxrate"));
  // An unknown hardware arm falls back to a ceiling rather than forwarding a flag it may reject.
  const unknown = hardwareQualityArgs("h264_weird", 26, "h264", 3000);
  assert(!unknown.includes("-crf") && !unknown.includes("-cq"), unknown.join(" "));
});

Deno.test("the software arm uses CRF, per codec", () => {
  for (const c of ["h264", "h265", "vp9", "av1"] as const) {
    assert(softwareQualityArgs(c, 22).includes("-crf"), c);
  }
  // hvc1 is what makes an H.265 MP4 play in Chromium rather than silently not.
  assert(softwareQualityArgs("h265", 24).includes("hvc1"));
});

Deno.test("buildExportArgs: the encoder per codec, and the user's override of it", () => {
  const base = {
    startTime: 10, endTime: 40, vodPath: "/v.mp4", outputPath: "/o.mp4",
    sourceWidth: 1920, sourceHeight: 1080, srtPath: null,
    escapePath: esc, captionStyle: style,
  };

  // H.264's measured default is software, so `auto` stays on libx264 for a LONG clip too — this is
  // the codec where the measurement showed parity and hardware therefore buys no size advantage.
  const h264Auto = buildExportArgs({
    ...base, profile: profile({ videoCodec: "h264" }), hardwareEncoder: "h264_nvenc",
  });
  assert(h264Auto.includes("libx264"), h264Auto.join(" "));
  assert(!h264Auto.includes("h264_nvenc"));

  // A SHORT H.264 clip also stays on the CPU: the wall-clock crossover is guidance for the user, not
  // a silent gate, so `auto` resolves to the codec's default at any duration.
  const h264Short = buildExportArgs({
    ...base, startTime: 10, endTime: 12,
    profile: profile({ videoCodec: "h264" }), hardwareEncoder: "h264_nvenc",
  });
  assert(h264Short.includes("libx264"), "a short clip must not switch codec default either");

  // EXPLICIT hardware is honoured even when the default would not choose it: freeing the CPU is a
  // different objective from wall-clock, and the user's choice wins.
  const forced = buildExportArgs({
    ...base, startTime: 10, endTime: 12,
    profile: profile({ videoCodec: "h264", encoder: "hardware" } as never),
    hardwareEncoder: "h264_nvenc",
  });
  assert(forced.includes("h264_nvenc"), forced.join(" "));

  // AV1's measured default IS hardware, so `auto` goes to the GPU without the user asking. In WEBM,
  // which is the only container AV1 is offered in now.
  const av1Auto = buildExportArgs({
    ...base,
    // `opus` as well as `webm`: the base profile is an MP4 one, and an AAC track in a WebM is refused
    // by name — so a WebM arm has to carry its own legal audio codec.
    profile: profile({ container: "webm", videoCodec: "av1", audioCodec: "opus", encoder: "auto" } as never),
    hardwareEncoder: "av1_nvenc",
  });
  assert(av1Auto.includes("av1_nvenc"), av1Auto.join(" "));

  // EXPLICIT software is honoured for AV1 as well.
  const av1Cpu = buildExportArgs({
    ...base,
    profile: profile({ container: "webm", videoCodec: "av1", audioCodec: "opus", encoder: "software" } as never),
    hardwareEncoder: "av1_nvenc",
  });
  assert(av1Cpu.includes("libsvtav1"), av1Cpu.join(" "));
  assert(!av1Cpu.includes("av1_nvenc"));

  // A verified encoder for a DIFFERENT codec is never used: pretending otherwise would produce a
  // file that cannot be muxed.
  const mismatched = buildExportArgs({
    ...base, profile: profile({ videoCodec: "h265", encoder: "hardware" } as never),
    hardwareEncoder: "h264_nvenc",
  });
  assert(mismatched.includes("libx265"), mismatched.join(" "));
  assert(!mismatched.includes("h264_nvenc"));

  // No probed encoder at all → software, whatever was asked for.
  const noGpu = buildExportArgs({
    ...base,
    profile: profile({ container: "webm", videoCodec: "av1", audioCodec: "opus", encoder: "hardware" } as never),
    hardwareEncoder: null,
  });
  assert(noGpu.includes("libsvtav1"), noGpu.join(" "));
});

Deno.test("the hardware quality is MAPPED, not forwarded — the 2.1x file-size defect", () => {
  // Measured: libx264 crf 23 is VMAF 92.58; h264_nvenc reaches that at cq ~31, and av1_nvenc at
  // cq ~39. Forwarding 23 unchanged asked nvenc for a HIGHER quality (VMAF 96.7) and produced a file
  // 2.8x the size — the size was a consequence of the mismatch, not of the encoder.
  assertEquals(hardwareQualityFor("h264", 23), 31);
  // AV1 is why an OFFSET cannot work. Measured within AV1's OWN scale, the SVT-AV1 default crf 35
  // is matched by av1_nvenc cq 36 — an offset of +1, not the +16 that was derived by comparing AV1
  // against libx264's crf 23, which is a cross-codec comparison and not a mapping at all.
  assertEquals(hardwareQualityFor("av1", 35), 36, "the SVT-AV1 default maps to the measured cq");
  // The ends of each software band meet the ends of the hardware band, measured.
  assertEquals(hardwareQualityFor("av1", 28), 32, "av1's best edge");
  assertEquals(hardwareQualityFor("av1", 45), 41, "av1's worst edge");
  assertEquals(hardwareQualityFor("h264", 18), 26, "x264's best edge");
  assertEquals(hardwareQualityFor("h264", 30), 38, "x264's worst edge");
  // A value OUTSIDE the software band maps to that band's edge, never extrapolated past it, and the
  // result stays inside the encoder's own accepted range.
  assertEquals(hardwareQualityFor("av1", 50), 41, "clamped to av1's band edge, not extrapolated");
  assertEquals(hardwareQualityFor("h264", 50), 38, "clamped to x264's band edge");
  assertEquals(hardwareQualityFor("h264", -10), 26, "and at the other end");
  // Monotonic: a worse software quality can never ask for a BETTER hardware quality. This is the
  // property a wrong-sign lerp would break, and it is invisible in any single point.
  for (const codec of ["h264", "h265", "vp9", "av1"] as const) {
    const band = CODEC_QUALITY_BANDS[codec];
    let prev = hardwareQualityFor(codec, band.best);
    for (let q = band.best + 1; q <= band.worst; q++) {
      const cq = hardwareQualityFor(codec, q);
      assert(cq >= prev, `${codec}: crf ${q} mapped to cq ${cq}, better than crf ${q - 1}'s ${prev}`);
      prev = cq;
    }
  }

  // The ARGS carry the mapped number, not the profile's.
  const args = buildExportArgs({
    startTime: 0, endTime: 30, vodPath: "/v.mp4", outputPath: "/o.mp4",
    sourceWidth: 1920, sourceHeight: 1080, srtPath: null,
    escapePath: esc, captionStyle: style,
    profile: profile({ videoCodec: "h264", encoder: "hardware", options: { quality: 23, maxBitrateKbps: null } } as never),
    hardwareEncoder: "h264_nvenc",
  });
  const cq = args[args.indexOf("-cq") + 1];
  assertEquals(cq, "31", `-cq must be the MAPPED quality, got ${cq}`);

  // The quality features are on: nvenc's defaults are lookahead 0 and no AQ, which is what makes a
  // constant-quality encode unable to see a scene change coming.
  assert(args.includes("-rc-lookahead"), args.join(" "));
  assert(args.includes("-spatial-aq"), args.join(" "));
});

Deno.test("the bitrate ceiling is OPT-IN, not automatic", () => {
  const mk = (maxBitrateKbps: number | null) => buildExportArgs({
    startTime: 0, endTime: 30, vodPath: "/v.mp4", outputPath: "/o.mp4",
    sourceWidth: 1920, sourceHeight: 1080, srtPath: null,
    escapePath: esc, captionStyle: style,
    profile: profile({ videoCodec: "h264", encoder: "hardware", options: { quality: 23, maxBitrateKbps } } as never),
    hardwareEncoder: "h264_nvenc",
  });

  // No ceiling stated → `-b:v 0`, i.e. pure constant quality. An automatic ceiling would cap a file
  // that is already at parity with the software arm (13.11 MB vs 13.26 MB at matched VMAF).
  const uncapped = mk(null);
  assert(uncapped.includes("-b:v"));
  assertEquals(uncapped[uncapped.indexOf("-b:v") + 1], "0");
  assert(!uncapped.includes("-maxrate"), uncapped.join(" "));

  // Stated → a real cap, with maxrate above it.
  const capped = mk(6000);
  assertEquals(capped[capped.indexOf("-b:v") + 1], "6000k");
  assert(capped.includes("-maxrate"), capped.join(" "));
});

Deno.test("buildExportArgs refuses an impossible profile and a zero-length clip", () => {
  const base = {
    startTime: 10, endTime: 40, vodPath: "/v.mp4", outputPath: "/o.mp4",
    sourceWidth: 1920, sourceHeight: 1080, srtPath: null,
    escapePath: esc, captionStyle: style, hardwareEncoder: null,
  };
  assertThrows(
    () => buildExportArgs({ ...base, profile: profile({ container: "mp4", videoCodec: "vp9" }) }),
    Error,
    "cannot be muxed",
  );
  assertThrows(
    () => buildExportArgs({ ...base, profile: profile(), startTime: 40, endTime: 40 }),
    Error,
    "Invalid clip duration",
  );
});

Deno.test("the window is bounded by -ss AND -t, and faststart is set for MP4", () => {
  const args = buildExportArgs({
    profile: profile(), startTime: 12, endTime: 42, vodPath: "/v.mp4", outputPath: "/o.mp4",
    sourceWidth: 1920, sourceHeight: 1080, srtPath: null,
    escapePath: esc, captionStyle: style, hardwareEncoder: null,
  });
  // Both are required: an arm with -ss but no -t silently encodes the whole multi-hour source.
  assertEquals(args[args.indexOf("-ss") + 1], "12");
  assertEquals(args[args.indexOf("-t") + 1], "30");
  assert(args.includes("+faststart"), "MP4 must be stream-ready for <video>");
  assertEquals(args[args.length - 1], "/o.mp4", "the output path is last");
});

Deno.test("silent exports omit the audio stream entirely", () => {
  assertEquals(audioArgs("webm", "none"), ["-an"]);
  assertEquals(audioArgs("mp4", "none"), ["-an"]);
  // Silence is a PROFILE property, so a profile saved as silent cannot export with sound because a
  // caller forgot to say so — the decision travels with the profile.
  const silent = buildExportArgs({
    profile: profile({ audioCodec: "none" }), startTime: 0, endTime: 5,
    vodPath: "/v.mp4", outputPath: "/o.mp4", sourceWidth: 1920, sourceHeight: 1080,
    srtPath: null, escapePath: esc, captionStyle: style, hardwareEncoder: null,
  });
  assertEquals(silent[silent.indexOf("-an")], "-an");
  assert(!silent.includes("-c:a"), silent.join(" "));
  // The container's own default codec, so an MP4 never gets Opus.
  assert(audioArgs("mp4", "aac").includes("aac"));
  assert(audioArgs("webm", "opus").includes("libopus"));
});

Deno.test("a preset row written before profiles existed still exports", () => {
  // The seeded rows carry only the old three-way `format`. A read that trusted them would hand
  // `undefined` to the encoder and throw far from the cause.
  const legacyWebm = normaliseProfile({ format: "webm" });
  assertEquals(legacyWebm.container, "webm");
  assertEquals(legacyWebm.videoCodec, "vp9");
  assertEquals(legacyWebm.audioCodec, "opus");
  assertEquals(validateExportProfile({ container: legacyWebm.container, videoCodec: legacyWebm.videoCodec, audioCodec: legacyWebm.audioCodec, maxHeight: legacyWebm.maxHeight }).ok, true);

  const legacyH265 = normaliseProfile({ format: "mp4_h265" });
  assertEquals([legacyH265.container, legacyH265.videoCodec], ["mp4", "h265"]);
  assertEquals(legacyH265.audioCodec, "aac", "an MP4 must never default to Opus");

  // An empty row is still a usable profile, and every field is present.
  const empty = normaliseProfile({});
  const expected: ExportProfile = {
    container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: null,
    // A row written before the encoder existed gets `auto` (what it was already doing) and the
    // codec's OWN default quality, which for x264 is 23.
    encoder: "auto", encoderName: null, options: { quality: 23, maxBitrateKbps: null },
    aspectRatio: "16:9",
    captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 32, backgroundOpacity: 0.5 },
    nameTemplate: "{date}-{channel}-{name}-{ts}",
  };
  assertEquals(empty, expected);
  // No field may be undefined — that is the whole point of filling on read.
  for (const [k, v] of Object.entries(empty)) assertEquals(v === undefined, false, `${k} undefined`);

  // A hand-edited row pairing VP9 with MP4 falls back instead of producing an unencodable export.
  const broken = normaliseProfile({ container: "mp4", videoCodec: "vp9" });
  assertEquals(broken.videoCodec, "h264");
  assertEquals(validateExportProfile({ container: broken.container, videoCodec: broken.videoCodec, audioCodec: broken.audioCodec, maxHeight: broken.maxHeight }).ok, true);
});

/**
 * Three bugs that a LIVE export probe caught and unit tests must now hold shut. Each was silent: the
 * export "succeeded" while ignoring what was asked for, or quietly ran on the CPU.
 */
Deno.test("a NAMED encoder outranks the profile's own default", () => {
  // The bug: `shouldUseHardware` answered from `profile.encoder` alone, so a profile naming
  // `h264_nvenc` with `encoder: "auto"` — exactly what picking from the list produces — was decided by
  // the per-codec default and ran libx264 on the CPU. Three live arms all reported `backend: "cpu"`.
  assertEquals(
    resolveEncoder({
      useHardware: false,
      hardwareEncoder: "h264_nvenc",
      softwareEncoder: null,
      named: { encoder: "h264_nvenc", hardware: true },
      codec: "h264",
    }),
    "h264_nvenc",
    "naming a hardware encoder must survive a CPU-defaulting profile",
  );
  // And a named SOFTWARE pick must survive too; the table would otherwise replace it.
  assertEquals(
    resolveEncoder({
      useHardware: true,
      hardwareEncoder: null,
      softwareEncoder: null,
      named: { encoder: "libx264", hardware: false },
      codec: "h264",
    }),
    "libx264",
  );
  // Nothing named: the old precedence stands, so nothing changes for profiles without a name.
  assertEquals(
    resolveEncoder({ useHardware: false, hardwareEncoder: "h264_nvenc", softwareEncoder: null, named: null, codec: "h264" }),
    "libx264",
  );
  assertEquals(
    resolveEncoder({ useHardware: true, hardwareEncoder: "h264_nvenc", softwareEncoder: null, named: null, codec: "h264" }),
    "h264_nvenc",
  );
  // Never null: a null here would emit an ffmpeg command with no `-c:v` at all.
  assertEquals(
    resolveEncoder({ useHardware: true, hardwareEncoder: null, softwareEncoder: null, named: null, codec: "av1" }),
    "libsvtav1",
  );
});

Deno.test("a NAMED hardware encoder reaches the args with its device initialisation", () => {
  // The named VAAPI path needs `-vaapi_device`, or ffmpeg fails with "Error initializing filters".
  // Asserted from the BUILT ARGS rather than an internal field, because the args are what ffmpeg sees.
  const args = buildExportArgs({
    profile: {
      container: "mp4", videoCodec: "h264", audioCodec: "aac", maxHeight: null,
      encoder: "auto", encoderName: "h264_vaapi", options: { quality: 26, maxBitrateKbps: null },
      aspectRatio: "16:9",
      captions: { enabled: false, preset: "bold-white", position: "bottom", fontSize: 48, backgroundOpacity: 0.8 },
      nameTemplate: "{date}",
    },
    startTime: 0, endTime: 12, vodPath: "/tmp/in.mp4", outputPath: "/tmp/out.mp4",
    sourceWidth: 1280, sourceHeight: 720, srtPath: null,
    hardwareEncoder: "h264_vaapi",
    namedEncoder: { encoder: "h264_vaapi", hardware: true },
    deviceArgs: ["-vaapi_device", "/dev/dri/renderD128"],
    escapePath: (p) => p,
    captionStyle: () => "",
  });
  assert(args.includes("-vaapi_device"), "-vaapi_device must be present or the encode cannot start");
  assert(args.includes("/dev/dri/renderD128"), "the PROBED node must be the one used");
  assertEquals(args[args.indexOf("-c:v") + 1], "h264_vaapi");
  assertEquals(args[args.indexOf("-c:v") + 1], "h264_vaapi");
});
