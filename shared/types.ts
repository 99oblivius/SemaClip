/**
 * SemaClip shared types — single source of truth.
 * Imported by frontend (SvelteKit) and backend (Deno).
 * The Python engine emits/consumes JSON matching EngineEvent / EngineCommand.
 */

// ── Domain enums ──────────────────────────────────────────────

export const AXES = ["hype", "humor", "skill", "awkward", "emotional", "tension", "reaction"] as const;
export type Axis = (typeof AXES)[number];

// ── Export filenames: ONE renderer, both sides ────────────────

/**
 * The clip facts a filename template is rendered from.
 *
 * `name` is resolved by the CALLER to `title ?? axis ?? label` — the same precedence the rest of the
 * app displays — because this module renders a template rather than deciding what a clip is called.
 */
export interface FilenameFacts {
  /** The streamer's name, when the stream carries one. */
  channel: string | null;
  /** The clip's own name, or null when it has none. */
  name: string | null;
  /** Seconds from the start of the VOD. */
  startTime: number;
  /** The stream's title. */
  streamTitle: string;
  /** Overridable so a caller (and a test) can pin the date. */
  now?: Date;
}

/** The tokens a user can put in the template. */
export const FILENAME_TOKENS = ["date", "channel", "name", "ts", "title"] as const;
export type FilenameToken = (typeof FILENAME_TOKENS)[number];

/** `mmss` for a clip's start position. */
function filenameStamp(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}${String(s % 60).padStart(2, "0")}`;
}

/** A lowercase dash-joined slug, capped, for the title-derived token. */
function filenameSlug(text: string, max: number): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, max);
}

/**
 * Make a NAME path-safe WITHOUT changing its case.
 *
 * Deliberately NOT the slug above: a clip's name is the user's own text and its casing is part of it
 * (the same rule that makes clip names case-sensitive). Lowercasing here would silently rewrite
 * `Take One` as `take-one` in every filename — the stored name would be right and the artifact would
 * disagree with it.
 *
 * Whitespace IS folded to `-` (so `Take One` → `Take-One`), matching the repo's no-whitespace
 * convention for filenames it writes, and the characters illegal on Windows fold with it: this is a
 * DELIVERABLE the user may copy anywhere, including off this machine, so it must be writable on the
 * strictest filesystem and legible in a shell without quoting. Case is the thing being preserved
 * here; spacing and punctuation are not.
 */
function pathSafeName(text: string, max: number): string {
  return text
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\s<>:"/\\|?*\u0000-\u001f]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-")
    .slice(0, max)
    .replace(/-+$/g, "");
}

/**
 * Render the naming template into a filename STEM (no extension).
 *
 * WHY THIS LIVES IN `shared/` AND NOT IN THE PAGE. The template used to be rendered in exactly one
 * place — the export page — and the rendered result was sent to the server as `filename`. That made
 * the server's output depend on a client that could send anything, and the failure was silent: when
 * the page sent the TEMPLATE STRING instead of a rendered name, every export was written literally
 * as `date---channel---name---ts.mp4`, so three exports of three different clips all produced ONE
 * file that overwrote itself. One rule, called from both sides, is what stops that class of bug:
 * the page previews with it and the server writes with it.
 *
 * The caller must pass a template; a value with no braces in it renders to itself, which is what
 * makes a hand-typed name work as well as a template.
 */
export function renderFilenameTemplate(template: string, facts: FilenameFacts): string {
  const date = (facts.now ?? new Date()).toISOString().slice(0, 10);
  const out = template
    .replaceAll("{date}", date)
    .replaceAll("{channel}", facts.channel ? filenameSlug(facts.channel, 40) : "")
    // Empty when the clip has no name, NOT a placeholder: the segment simply drops out, and the
    // separator cleanup below removes the dash it leaves behind. Inventing a word here would put a
    // label nobody chose into a filename.
    .replaceAll("{name}", facts.name ? pathSafeName(facts.name, 60) : "")
    .replaceAll("{ts}", filenameStamp(facts.startTime))
    .replaceAll("{title}", filenameSlug(facts.streamTitle, 30));
  // Trailing/leading separators and doubled-up dashes read as a mistake in a filename; the
  // template's own text between tokens is otherwise preserved.
  return out.replace(/[/\\]/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * Does this string LOOK like a naming template (rather than an already-rendered name)?
 *
 * Used by the server to decide whether it must render what it was handed. A template always contains
 * one of the known tokens; a rendered filename cannot, because `renderFilenameTemplate` deletes the
 * braces (an unknown token is simply dropped by the `replaceAll` chain).
 */
export function looksLikeFilenameTemplate(value: string): boolean {
  return FILENAME_TOKENS.some((token) => value.includes(`{${token}}`));
}


export const STREAM_STATUS = ["pending", "processing", "completed", "failed"] as const;
export type StreamStatus = (typeof STREAM_STATUS)[number];

export const JOB_STATUS = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type JobStatus = (typeof JOB_STATUS)[number];

// ── Domain entities ───────────────────────────────────────────

export interface Stream {
  id: string;
  vodPath: string;
  chatPath: string | null;
  sourceUrl: string | null;
  title: string | null;
  streamer: string | null;
  game: string | null;
  duration: number | null; // seconds
  createdAt: string; // ISO
  status: StreamStatus;
  /**
   * The folder this project's media lives in, as recorded when it was created (or when the
   * user pointed it somewhere else).
   *
   * It must be recorded because it cannot be re-derived: the folder is named from the VOD's
   * own metadata plus a collision suffix, and its LOCATION is the user's choice — the VOD
   * directory setting, or any drive they moved the project to. `null` means "not recorded
   * yet" (a project created before the field existed): its location resolves from the media
   * paths on the record, and the first reconcile persists what it found.
   */
  projectDir: string | null;
}

export interface Job {
  id: string;
  streamId: string;
  status: JobStatus;
  position: number; // queue order, 0 = next
  startedAt: string | null;
  completedAt: string | null;
  error: string | null;
  config: JobConfig;
}

export interface JobConfig {
  /** Override detection thresholds per axis, 0-1. */
  axisThresholds?: Partial<Record<Axis, number>>;
  /** Max clips to return. */
  maxClips?: number;
}

export interface Clip {
  id: string;
  /** Null for a MANUAL clip: made by hand, with no engine job behind it. */
  jobId: string | null;
  streamId: string;
  /** Null for a manual clip — there is no engine axis to report (never a sentinel). */
  axis: Axis | null;
  /** 0-1 for a detected clip. Null for a manual clip: it is not ranked, and a fake 0
   *  would render as "0.00" in the inspector, i.e. a hand-cut clip shown as a bad find. */
  score: number | null;
  startTime: number; // seconds from VOD start
  endTime: number;
  peakTime: number;
  justification: string | null;
  /** The USER'S name for this clip, free text. Null = not named (never "").
   *
   *  Deliberately not `axis`: `axis` is an engine enum, validated by `isAxis`, queried by the
   *  axis filter and aggregated as axis-weight feedback. Storing a typed name there would corrupt
   *  all three and break the "manual clip = absence of axis" invariant. A name is a different
   *  fact, and a clip may be named while still having no axis. */
  title: string | null;
  rank: number | null;
  exported: boolean;
  exportPath: string | null;
  rejected: boolean; // user discarded → implicit feedback
  /** Per-signal evidence from the engine. null = engine emitted no signals —
   *  the UI must show "no signal data", never fabricated bars. */
  signals: ClipSignals | null;
}

export interface Persona {
  id: string; // streamer name/id
  state: PersonaState;
  updatedAt: string;
  streamCount: number;
}

export interface PersonaState {
  axisWeights: Record<Axis, number>;
  thresholds: Partial<Record<Axis, number>>;
}

// ── Signal breakdown (clip evidence) ──────────────────────────

/**
 * Per-modality evidence for a clip. Absent modalities are 0 AND the
 * justification must not cite them (honesty rule: every nonzero signal is
 * backed by real computation, every zero is a real absence).
 */
export interface ClipSignals {
  /** Chat velocity+emote excitement at the peak second (0-1). */
  chatExcitement: number;
  /** Emote-weighted message velocity (0-1). */
  emoteVelocity: number;
  /** Audio RMS energy at the peak second (0-1). */
  audioEnergy: number;
  /** Fraction of the clip window covered by speech (0-1, from VAD/whisper). */
  speechCoverage: number;
}

// ── Engine IPC protocol (Python ↔ Deno) ───────────────────────
// Newline-delimited JSON over stdin/stdout.

export type EngineCommand =
  | { type: "start"; jobId: string; vodPath: string; chatPath: string | null; config: JobConfig; /** Destination for derived artifacts (SRT). */ artifactDir?: string | undefined; /** Worker budget from the CPU-usage tier. */ workers?: number | undefined }
  | { type: "cancel" };

export type EngineEvent =
  | { type: "progress"; jobId: string; phase: EnginePhase; percent: number; message?: string }
  | { type: "segment"; jobId: string; start: number; end: number; regime: string }
  | { type: "candidate"; jobId: string; axis: Axis; start: number; end: number; score: number; signals: ClipSignals }
  | {
      type: "clip";
      jobId: string;
      id: string;
      axis: Axis;
      start: number;
      end: number;
      peak: number;
      score: number;
      justification: string | null;
      signals: ClipSignals;
    }
  | { type: "complete"; jobId: string; clipsFound: number }
  | { type: "error"; jobId: string; phase: EnginePhase; message: string };

export const ENGINE_PHASES = [
  "audio_extraction",
  "transcription",
  "chat_parsing",
  "segmentation",
  "embedding",
  "llm_triage",
  "axis_scoring",
  "endpoint_resolution",
  "proxy_generation",
  "export_preparation",
] as const;
export type EnginePhase = (typeof ENGINE_PHASES)[number];

export const PHASE_LABELS: Record<EnginePhase, string> = {
  audio_extraction: "Audio extraction",
  transcription: "Transcription",
  chat_parsing: "Chat parsing",
  segmentation: "Adaptive segmentation",
  embedding: "Embedding extraction",
  llm_triage: "LLM triage",
  axis_scoring: "Per-axis scoring",
  endpoint_resolution: "Endpoint resolution",
  proxy_generation: "Scrub proxy",
  export_preparation: "Export preparation",
};

// ── REST API contracts ────────────────────────────────────────

// Stream import
export interface ImportByFileInput {
  /** Explicit video file. Mutually exclusive with folderPath. */
  vodPath: string;
  /** Folder import: first video file found = HQ; any proxy(.ts/.mp4) or scrub.ts = proxy; chat.json = chat. */
  folderPath?: string;
  chatPath?: string | null;
  title?: string;
  streamer?: string;
  /** Original VOD URL if the file was downloaded from Twitch (enables markers). */
  sourceUrl?: string | null;
}
export interface ImportByUrlInput {
  url: string; // Twitch VOD URL
  title?: string;
  streamer?: string;
  /** Progressive download — see ARCHITECTURE.md §5 (download pipeline). */
  progressive?: boolean;
  /** Highest quality of the proxy pass (default 540). */
  proxyHeightCap?: number;
  /** Max resolution of the HQ pass / single download (null = no cap). */
  maxQualityHeight?: number | null;
  /** When false, a single download serves both scrub and HQ roles. */
  includeProxy?: boolean;
}
export type ImportResult = { stream: Stream; downloadJobId: string | null };

// Stream list
export interface ListStreamsQuery {
  status?: StreamStatus;
}
export type ListStreamsResult = Stream[];

// Job queue
export interface QueueAction {
  type: "reorder" | "cancel";
  jobId: string;
  newPosition?: number; // for reorder
}

// Clips
export interface ListClipsQuery {
  axis?: Axis;
  rejected?: boolean;
}
export type ListClipsResult = Clip[];

// Export
/**
 * The container × video-codec pairs the Format control offers.
 *
 * These ARE the encoder presets: choosing a Format fixes the container, the video codec and the
 * legal audio codecs at once, which is why the control is one row and not three independent
 * dropdowns.
 *
 * MKV carries H.264 because Matroska takes anything and H.264-in-MKV is the format of a local media
 * library — it is NOT browser-embeddable, which is why it is a separate entry from MP4 H.264 rather
 * than a replacement. H.264-in-WEBM is impossible and deliberately absent: the WebM muxer refuses it
 * outright ("Only VP8 or VP9 or AV1 video and Vorbis or Opus audio … are supported for WebM"),
 * measured on a stream copy AND a re-encode, because WebM is a strict Matroska subset that never
 * included H.264. A format that cannot be produced is worse than an absent one.
 *
 * AV1 is offered ONCE, in WebM. MP4 AV1 was dropped: it muxes, but almost nothing consumes it, and
 * the container is the part that decides where a file can go.
 *
 * The LEGACY three values (`mp4_h264` / `mp4_h265` / `webm`) are kept in the union because
 * `export_presets.config_json` in an installed database carries them, and a stored row must always
 * be readable. `formatForPair` maps a current pair back onto one of them for those rows.
 *
 * The ORDER here is the order the export control offers them in, and it lives here rather than in the
 * page so the control and anything else listing formats cannot disagree: the two MP4 entries first
 * (almost every consumer accepts MP4), then MKV H.264 — Matroska is not browser-embeddable, but it is
 * where H.264 goes for local keeping, so it belongs with the H.264 pair rather than after WebM — and
 * the two WebM entries last.
 */
export const EXPORT_FORMATS = ["mp4_h264", "mp4_h265", "mkv_h264", "webm_vp9", "webm_av1"] as const;
export type ExportFormat =
  | "mp4_h264"
  | "mp4_h265"
  | "webm"
  | "mp4_av1"
  | (typeof EXPORT_FORMATS)[number];
export type AspectRatio = "16:9" | "9:16" | "1:1";

// ── Export profiles (P1-12 / P0-7: named format/aspect/caption bundles) ──

export const CONTAINERS = ["mp4", "webm", "mkv"] as const;
export type Container = (typeof CONTAINERS)[number];

/**
 * Video codecs, paired with the container(s) they are legal in.
 *
 * Declared as a data table rather than left to the UI so the compatibility matrix can be VALIDATED
 * — a VP9-in-MP4 or H.264-in-WebM combination is refused by name instead of silently normalised to
 * something else the user did not ask for.
 */
export const VIDEO_CODECS = ["h264", "h265", "vp9", "av1"] as const;
export type VideoCodec = (typeof VIDEO_CODECS)[number];
export const AUDIO_CODECS = [
  "aac",
  "opus",
  "vorbis",
  "mp3",
  "flac",
  "pcm_s16le",
  "pcm_s24le",
  "none",
] as const;
export type AudioCodec = (typeof AUDIO_CODECS)[number];

/** Which containers each video codec may be muxed into. */
export const CONTAINER_CODEC_MATRIX: Record<VideoCodec, readonly Container[]> = {
  h264: ["mp4", "mkv"],
  h265: ["mp4", "mkv"],
  vp9: ["webm"],
  av1: ["webm"],
};

/**
 * Which audio codecs each container accepts.
 *
 * WebM takes BOTH Opus and Vorbis — the WebM container spec allows either, and this host's muxer
 * accepts either with no warning (measured). Opus is the DEFAULT because it is the current standard
 * (RFC 7845, Standards Track, 2016) and is what ffmpeg's own webm muxer defaults to; Vorbis is the
 * 2002 codec that older editors support but Opus replaced. Offering Vorbis is for that compatibility
 * case, not because it is the better encoder.
 */
export const CONTAINER_AUDIO_MATRIX: Record<Container, readonly AudioCodec[]> = {
  mp4: ["aac", "mp3", "flac", "pcm_s16le", "pcm_s24le", "none"],
  webm: ["opus", "vorbis", "none"],
  // Matroska takes everything the muxer can write — ALL TEN combinations measured with exit 0, which
  // is why it is the container for "keep the audio exactly as it is" and for archival.
  mkv: ["aac", "opus", "vorbis", "mp3", "flac", "pcm_s16le", "pcm_s24le", "none"],
};

/**
 * A named bundle of output settings — what "a profile" means (P1-12).
 *
 * A resolution/fps field is a CAP, never a target: exporting must never upscale a source smaller
 * than the cap, so `null` means "keep the source".
 */
/**
 * Which encoder to use for a video codec.
 *
 * `auto` is the default and resolves PER CODEC (see MEASED_ENCODER_DEFAULTS): a codec whose software
 * encoder is the sane general choice gets `software`, and one where hardware is the sensible default
 * gets `hardware`. It is in the profile rather than derived at call time because it is part of what a
 * saved profile MEANS — a preset saved as "AV1 on the GPU" must still be that when it is re-opened.
 */
export type EncoderChoice = "auto" | "software" | "hardware";

export interface ExportProfile {
  container: Container;
  videoCodec: VideoCodec;
  /**
   * Software or hardware for this export, or `auto` to take the measured per-codec default.
   *
   * The owner can always override it; the point of `auto` is that the DEFAULT is the right one per
   * codec rather than one policy for all of them.
   */
  encoder: EncoderChoice;
  /**
   * A CONCRETE encoder to use, named from the machine's own verified list (e.g. `h264_vaapi`).
   *
   * Distinct from `encoder` on purpose. `encoder` says what KIND the user wants (`auto` → the measured
   * per-codec default); this says WHICH one, because a machine can have several hardware encoders for
   * one codec — the reference host has `h264_nvenc` AND `h264_vaapi` — and they differ in which GPU
   * does the work. Null means "whichever the default/probe picks", which is what a profile saved
   * before this field existed means.
   */
  encoderName: string | null;
  /**
   * The audio codec, INCLUDING `none` for a silent export.
   *
   * It lives here and not as a per-call argument: it is part of what a saved profile MEANS, and a
   * second input carrying the same decision is how the two drift apart (a profile saved as silent
   * would export with sound when a caller forgot to pass it).
   */
  audioCodec: AudioCodec;
  /** Ceiling on the long edge, or null to keep the source resolution. Never upscales. */
  maxHeight: number | null;
  /**
   * The encoding options for the chosen codec.
   *
   * Quality and bitrate live here rather than as bare numbers on the profile because their MEANING
   * and their useful RANGE are per-codec: `crf 23` is mid-quality for x264, and `crf 23` for
   * libvpx-vp9 is far higher; a codec above its useful ceiling is effectively lossless and only
   * costs encode time. `quality` is always stated on the SOFTWARE scale for the codec, and the
   * hardware arm's own number is derived from it by the measured mapping.
   */
  options: CodecOptions;
  aspectRatio: AspectRatio;
  captions: CaptionStyle;
  /**
   * Filename template tokens: {date} {channel} {name} {ts} {title}.
   *
   * `{name}` is the CLIP's own name (case-preserved, path-unsafe characters folded). `{axis}` was
   * removed: it named an engine concept on a control that also names hand-made clips, which have no
   * axis at all — so the token was inapplicable to exactly the clips a user creates themselves. The
   * engine now writes the matched axis into the clip's NAME at creation, which is where that fact
   * belongs, and `{name}` reads it everywhere.
   */
  nameTemplate: string;
}

/**
 * Validate a profile, returning ONE named reason when it cannot be encoded.
 *
 * Refusing with a reason beats normalising silently: a user who picked VP9 into MP4 needs to know
 * that is not a thing, not to receive an H.264 file labelled VP9.
 */
export function validateExportProfile(p: {
  container: Container;
  videoCodec: VideoCodec;
  audioCodec?: AudioCodec;
  maxHeight: number | null;
}): { ok: true } | { ok: false; reason: string } {
  if (!CONTAINER_CODEC_MATRIX[p.videoCodec]?.includes(p.container)) {
    return {
      ok: false,
      reason: `${p.videoCodec.toUpperCase()} cannot be muxed into ${p.container.toUpperCase()}`,
    };
  }
  const audio: AudioCodec = p.audioCodec ?? defaultAudioFor(p.container);
  if (!CONTAINER_AUDIO_MATRIX[p.container].includes(audio)) {
    return {
      ok: false,
      reason: `${p.container.toUpperCase()} does not accept ${audio.toUpperCase()} audio`,
    };
  }
  if (p.maxHeight !== null && (!Number.isFinite(p.maxHeight) || p.maxHeight <= 0)) {
    return { ok: false, reason: "Resolution cap must be a positive number of pixels" };
  }
  return { ok: true };
}

/** The container's own codec when a profile does not state one. */
export function defaultAudioFor(container: Container): AudioCodec {
  return container === "webm" ? "opus" : "aac";
}

/**
 * The captions block the presets are SHIPPED with, as a value — the guard for the captions-off
 * migration.
 *
 * A preset whose stored captions match this EXACTLY is one the user never touched, so turning its
 * captions off is repairing shipped defaults. One differing in any field — `enabled`, `fontSize`,
 * `position` — was edited by somebody, and their choice is not the migration's to reverse. `origin`
 * cannot make that distinction: editing a seeded preset leaves `origin = 'seeded'`, measured.
 */
export const SHIPPED_CAPTIONS = {
  enabled: false,
  preset: "bold-white",
  position: "bottom",
  fontSize: 48,
  backgroundOpacity: 0.8,
} as const;

/**
 * The container/codec pair a Format value names, in ONE place.
 *
 * Both `normaliseProfile` and the export page's own format control need this mapping, and a second
 * copy is how a stored `webm` row ends up meaning VP9 while the UI's `webm_vp9` means something
 * else. The legacy three values are accepted here for the same reason the union keeps them.
 */
export function pairForFormat(
  format: ExportFormat,
): { container: Container; videoCodec: VideoCodec } | null {
  switch (format) {
    case "webm":
    case "webm_vp9":
      return { container: "webm", videoCodec: "vp9" };
    case "mp4_h265":
      return { container: "mp4", videoCodec: "h265" };
    case "mp4_h264":
      return { container: "mp4", videoCodec: "h264" };
    case "webm_av1":
      return { container: "webm", videoCodec: "av1" };
    case "mkv_h264":
      return { container: "mkv", videoCodec: "h264" };
    case "mp4_av1":
      // RETIRED, still READABLE: a stored row or a saved preset may carry it, and reading it as a
      // null pair would blank the user's preset instead of showing them AV1 in WebM, which is the
      // same codec in the container that actually consumes it. It is never WRITTEN — it is absent
      // from EXPORT_FORMATS, so the control cannot offer it.
      return { container: "webm", videoCodec: "av1" };
    default:
      return null;
  }
}

/**
 * The Format value that names a container/codec pair — the inverse of `pairForFormat`, for writing a
 * pair back into a stored row or a control.
 *
 * Note the ASYMMETRY with `pairForFormat`: `webm` and `webm_vp9` are two spellings of ONE pair, and
 * AV1-in-WebM is reachable from both `webm_av1` and the retired `mp4_av1`, so this returns the
 * current spelling and a legacy row read and re-saved is upgraded. That is the intended direction —
 * the legacy names exist to be READ, never written.
 */
export function formatForPair(container: Container, videoCodec: VideoCodec): ExportFormat {
  if (container === "webm") return videoCodec === "av1" ? "webm_av1" : "webm_vp9";
  if (container === "mkv") return "mkv_h264";
  return videoCodec === "av1" ? "mp4_av1" : videoCodec === "h265" ? "mp4_h265" : "mp4_h264";
}

/**
 * Fill a stored profile's missing fields from the defaults, per field.
 *
 * Preset rows written before profiles existed carry only `format` — a read that destructures and
 * trusts them would hand `undefined` to the encoder and throw somewhere far from the cause. Every
 * field is therefore filled on read, and unknown values fall back rather than propagate.
 */
export function normaliseProfile(
  raw: Partial<ExportProfile> & { format?: ExportFormat | undefined },
): ExportProfile {
  // The old three-way `format` string maps onto the container/codec pair it always meant. Routed
  // through `pairForFormat` rather than re-stated here, so a newly added format cannot be readable
  // in the UI and unreadable from storage — the two spellings of one pair have ONE owner.
  const fromFormat = raw.format ? pairForFormat(raw.format) : null;

  const container: Container = raw.container ?? fromFormat?.container ?? "mp4";
  const rawCodec: VideoCodec = raw.videoCodec ?? fromFormat?.videoCodec ?? "h264";
  // A codec/container pair that cannot be muxed (a hand-edited row) falls back to the container's
  // own default rather than being carried into an export that would fail at the last step.
  const legal = CONTAINER_CODEC_MATRIX[rawCodec].includes(container);
  // The fallback is the container's OWN default codec, so the repair never lands on a codec that
  // container cannot take: a bad pair in an MKV must become H.264, not VP9.
  const fallbackCodec: VideoCodec = container === "webm" ? "vp9" : "h264";
  const videoCodec: VideoCodec = legal ? rawCodec : fallbackCodec;
  return {
    container,
    videoCodec,
    audioCodec: raw.audioCodec ?? defaultAudioFor(container),
    maxHeight: raw.maxHeight ?? null,
    // An absent `encoder` means a row written before the choice existed, and `auto` is exactly what
    // those exports were already doing (the per-codec default), so nothing changes for them.
    encoder: raw.encoder ?? "auto",
    // An absent `encoderName` means "whichever the probe picks", which is what every profile written
    // before the machine's own encoder list existed meant. It is deliberately NOT resolved here: the
    // list is the HOST's, and a normaliser on a server with no such encoder would have to invent one.
    encoderName: raw.encoderName ?? null,
    options: {
      // Quality is clamped to the codec's USEFUL band, not merely the encoder's accepted range: a
      // stored `crf 0` is technically encodable and practically useless (lossless, huge, slow).
      quality: clampQuality(videoCodec, raw.options?.quality ?? CODEC_QUALITY_BANDS[videoCodec].default),
      maxBitrateKbps: raw.options?.maxBitrateKbps ?? null,
    },
    aspectRatio: raw.aspectRatio ?? "16:9",
    captions: raw.captions ?? {
      enabled: false, preset: "bold-white", position: "bottom", fontSize: 32, backgroundOpacity: 0.5,
    },
    nameTemplate: raw.nameTemplate ?? "{date}-{channel}-{name}-{ts}",
  };
}

export interface CaptionStyle {
  enabled: boolean;
  preset: "bold-white" | "yellow" | "custom";
  position: "bottom" | "top";
  fontSize: number;
  backgroundOpacity: number; // 0-1
}

/** Named export bundle (P0-7): everything the export sheet needs in one unit. */
/**
 * The quality/bitrate options for one export, with the per-codec ranges that make them meaningful.
 *
 * `quality` is on the SOFTWARE scale for the codec (see CODEC_QUALITY_RANGE). `maxBitrateKbps` is an
 * OPT-IN ceiling — null means quality-driven, which is the honest default now that the quality
 * scales are mapped correctly.
 */
export interface CodecOptions {
  /** Quality on the codec's software scale. Clamped to the codec's useful band on read. */
  quality: number;
  /** Optional ceiling in kbps, or null to let quality drive the rate. */
  maxBitrateKbps: number | null;
}

/**
 * A codec's quality scale and the band of it that is actually worth using.
 *
 * The fields are named `best`/`worst` rather than min/max ON PURPOSE: on a CRF/quantiser scale LOWER
 * is BETTER, so a numeric `min`/`max` pair reads as "min = low quality" and silently inverts. That
 * exact confusion clamped every stored quality to the worst end of the band when this was first
 * written.
 */
export interface CodecQualityBand {
  /** The encoder's accepted range (0-51 for x264, 0-63 for vp9/av1). */
  accepts: { from: number; to: number };
  /** The HIGHEST quality worth asking for — beyond it the codec is effectively lossless and only
   *  encode time keeps growing. A LOWER number than `worst`. */
  best: number;
  /** The LOWEST quality worth asking for — beyond it the file is visibly damaged. */
  worst: number;
  /**
   * The codec's own documented default, used when nothing else is known.
   *
   * These ARE the encoders' defaults rather than invented midpoints: x264's CRF default is 23,
   * x265's 28, libvpx-vp9's 31 and SVT-AV1's 35. Starting a user at the value the encoder's own
   * maintainers chose is the least surprising place to begin.
   */
  default: number;
  /**
   * MEASURED encode speed at 1080p60, as a multiple of realtime (higher is faster).
   *
   * Recorded because quality and encode TIME move together, and that tradeoff is invisible without a
   * number: the same 15s window takes 2.9s at x264's crf 23 but 19.4s at VP9's crf 31. A user
   * choosing VP9 for ~21% smaller files is choosing a ~7x slower export.
   */
  speed: number;
  /** What a change of 1 in quality is worth, for time estimates and the UI's description. */
  note: string;
}

/**
 * Per-codec quality scales, MEASURED on the reference host (1080p60, VMAF against a lossless
 * reference, encode time recorded alongside — see `references/codec-quality-profiles.md`).
 *
 * `usefulMax` is the important field: it is where the curve flattens. Above it a tier buys bytes
 * and seconds for a change nobody can see.
 */
export const CODEC_QUALITY_BANDS: Record<VideoCodec, CodecQualityBand> = {
  h264: { accepts: { from: 0, to: 51 }, best: 18, worst: 30, default: 23, speed: 5.2, note: "fastest to encode; crf 18 is visually lossless" },
  // H.265 measured only ~9% smaller than H.264 at equal quality, NOT the ~50% the format is often
  // claimed to deliver — at 720p the two were indistinguishable (0.9996x). The gain is real but
  // modest, and it costs ~2.7x the encode time.
  h265: { accepts: { from: 0, to: 51 }, best: 20, worst: 32, default: 28, speed: 2.2, note: "~10% smaller than H.264 at equal quality, at ~2.5x the encode time" },
  // VP9 is by far the slowest software encoder measured (0.9x realtime at 1080p60, so SLOWER than
  // playback) while buying ~21% over H.264 — the point at which hardware becomes the obvious default.
  vp9: { accepts: { from: 0, to: 63 }, best: 24, worst: 42, default: 31, speed: 0.8, note: "~22% smaller than H.264 but ~6x the encode time; its scale runs higher than x264's" },
  av1: { accepts: { from: 0, to: 63 }, best: 28, worst: 45, default: 35, speed: 2.0, note: "smallest at equal quality (~43% under H.264 on the CPU); software encode is slow, hardware is the practical default" },
};

/**
 * A sensible bitrate for a codec at a given resolution and frame rate.
 *
 * MEASURED, per codec, at a quality matched to libx264 crf 23 (1080p60, 15s window): H.264
 * 3554 kbps, H.265 3092 (-13%), VP9 and AV1 both land far lower on their own scales. The RATIOS are
 * what matter, and they are NOT a fixed number: H.265's advantage measured ~13% at 1080p but ~0% at
 * 720p, so this is a starting point for a CEILING a user can edit, not a promise about size.
 *
 * ── THE EXPONENT IS MEASURED, NOT ASSUMED (VMAF-matched, 5 rungs, 16x pixel-rate span) ──
 * Derived by encoding one real 720p60 source down to five resolutions, generating a LOSSLESS (ffv1)
 * reference at each, then VMAF-matching every encode against it to find the bitrate that lands on a
 * common quality. Fitting log(bitrate) = a + b*log(pixelRate):
 *
 *   b = 0.72 (VMAF 94) / 0.73 (VMAF 95)   -> 0.75 is within the measurement's own spread
 *
 * Bits per pixel is therefore NOT constant — it FALLS as resolution rises, which is what the exponent
 * below 1 encodes:
 *
 *   320x180 0.088 bpp | 480x270 0.077 | 640x360 0.065 | 960x540 0.053 | 1280x720 0.040
 *
 * HONEST LIMIT: a single power law is an approximation, and the local exponent DRIFTS — 0.84 across
 * the low three rungs but 0.36 between 960x540 and 1280x720, so the low-resolution end is where this
 * overstates a little and the high end where it understates (max residual ~12% of file size). The
 * value is also a CONSERVATIVE ceiling at the default quality (~28-47% above what crf 26 needs here),
 * which is the right direction for a ceiling, and it is user-editable. Do not "correct" the constant
 * from a single-resolution measurement: the whole point of the exponent is that one point cannot
 * determine it.
 */
export function sensibleBitrateKbps(codec: VideoCodec, width: number, height: number, fps: number): number {
  const CODE_WIDTH = 1920, CODE_HEIGHT = 1080, CODE_FPS = 60;
  const pixelRate = Math.max(1, width * height * Math.max(1, fps));
  const codePixelRate = CODE_WIDTH * CODE_HEIGHT * CODE_FPS;
  const ratio = CODEC_BITRATE_RATIO[codec];
  // 0.75 = the measured exponent (see above). 1080p60 is the NORMALISATION POINT the base is stated
  // at, not a hardcoded assumption about the user's video: pixel count and fps both enter here, so a
  // 4K60 deliverable scales up and a 360p30 one scales down.
  const scaled = CODEC_BASE_KBPS * Math.pow(pixelRate / codePixelRate, 0.75) * ratio;
  return Math.max(300, Math.round(scaled / 50) * 50);
}

/** Measured bits per pixel-rate relative to H.264 at equal quality. */
export const CODEC_BASE_KBPS = 3500;
const CODEC_BITRATE_RATIO: Record<VideoCodec, number> = {
  h264: 1.0,
  h265: 0.87,
  vp9: 0.80,
  av1: 0.78,
};

/**
 * The MEASURED quality -> bitrate curve per codec, at 1080p60, from the same VMAF sweep the bands
 * come from (`util-out.txt` / `references/codec-quality-profiles.md`).
 *
 * A tier is a CHOICE about quality, and each choice produces a genuinely different file size — so a
 * tier click must set BOTH the quality and the bitrate. Interpolating this curve is how it gets a
 * number that was actually measured at that quality, instead of a percentage of some other tier.
 *
 * These are points on a measured curve, not a formula: the pairs are what the encoder produced, and
 * `bitsForQuality` interpolates BETWEEN them. Do not replace this with a constant offset — the
 * spacing is not linear (H.264 falls 6757 -> 1436 kbps from crf 18 to 30 while its crf only moves
 * 12 steps, and VP9 spans a 20-step band for a similar ratio).
 */
export const MEASURED_QUALITY_CURVE: Record<VideoCodec, ReadonlyArray<readonly [number, number]>> = {
  // libx264, crf -> kbps at 1080p60
  h264: [[16, 8600], [18, 6757], [20, 5256], [23, 3554], [26, 2378], [30, 1436]],
  h265: [[18, 6040], [20, 4642], [23, 3092], [26, 2030], [30, 1166]],
  // libvpx-vp9 runs on its own, higher scale
  vp9: [[18, 9294], [24, 7041], [31, 4263], [38, 2466], [45, 1431]],
  av1: [[22, 7516], [28, 4897], [35, 2900], [42, 1760], [50, 1088]],
};

/** The pixel rate `sensibleBitrateKbps` and the measured curves are stated at. */
const CODE_PIXEL_RATE = 1920 * 1080 * 60;

/**
 * A measured bitrate for one quality, interpolated on that codec's own curve.
 *
 * Clamped at the ends rather than extrapolated: past the measured range a straight line would invent
 * numbers the encoder was never run at, and the ends ARE the useful extremes (the band's `best` and
 * `worst`), so clamping lands on a real measurement.
 */
export function bitsForQuality(codec: VideoCodec, quality: number): number {
  const curve = MEASURED_QUALITY_CURVE[codec];
  // The scales are inverted (lower crf = better), so sort ascending by quality to interpolate.
  const pts = [...curve].sort((a, b) => a[0] - b[0]);
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  if (quality <= first[0]) return first[1];
  if (quality >= last[0]) return last[1];
  for (let i = 1; i < pts.length; i++) {
    const [q0, k0] = pts[i - 1]!;
    const [q1, k1] = pts[i]!;
    if (quality <= q1) return Math.round(k0 + ((quality - q0) / (q1 - q0)) * (k1 - k0));
  }
  return last[1];
}

/**
 * A measured bitrate for one quality at a given resolution and frame rate.
 *
 * The same pixel-rate scaling `sensibleBitrateKbps` uses, applied to the MEASURED curve point rather
 * than to a single base constant — so a manual quality edit moves the bitrate to the number that
 * quality actually produced, at this source's own geometry.
 */
export function bitsForQualityScaled(
  codec: VideoCodec,
  quality: number,
  width: number,
  height: number,
  fps: number,
): number {
  const base = bitsForQuality(codec, quality);
  const pixelRate = Math.max(1, width * height * Math.max(1, fps));
  const scaled = base * Math.pow(pixelRate / CODE_PIXEL_RATE, 0.75);
  return Math.max(300, Math.round(scaled / 50) * 50);
}

/**
 * The bitrate a TIER means, at this resolution and frame rate.
 *
 * A tier is a complete description of "what kind of file", so clicking one has to move the bitrate as
 * well as the quality — otherwise the tier says `maximum` while the bitrate still describes `draft`.
 */
export function bitrateForTier(
  codec: VideoCodec,
  tier: QualityTier,
  width: number,
  height: number,
  fps: number,
): number {
  return bitsForQualityScaled(codec, qualityForTier(codec, tier), width, height, fps);
}

/** Quality tiers offered in the UI, resolved to each codec's own scale. */
export const QUALITY_TIERS = ["draft", "standard", "high", "maximum"] as const;
export type QualityTier = (typeof QUALITY_TIERS)[number];

/**
 * A tier as a FRACTION of the codec's useful band, not a fixed number.
 *
 * A single number cannot be a tier for four codecs whose useful bands differ by 20 points; a
 * fraction of each codec's own band can. `draft` sits at the low-quality edge, `maximum` at the
 * lossless-ish edge, and the defaults in between follow the encoders' own recommended values.
 */
export const TIER_FRACTION: Record<QualityTier, number> = {
  draft: 0,
  standard: 0.35,
  high: 0.7,
  maximum: 1,
};

/** The quality a tier means on a given codec's software scale. */
export function qualityForTier(codec: VideoCodec, tier: QualityTier): number {
  const band = CODEC_QUALITY_BANDS[codec];
  // Interpolated from WORST to BEST. Because the scale is inverted, `best` is the smaller number, so
  // this walks DOWN the numbers as the tier rises — the arithmetic is correct but reads backwards
  // unless the field names carry it.
  const raw = band.worst + TIER_FRACTION[tier] * (band.best - band.worst);
  return clampQuality(codec, Math.round(raw));
}

/** Which tier a quality value corresponds to, for the UI's active-button state. */
export function tierForQuality(codec: VideoCodec, quality: number): QualityTier | null {
  for (const tier of QUALITY_TIERS) {
    if (qualityForTier(codec, tier) === quality) return tier;
  }
  return null;
}

/**
 * Clamp a quality to the codec's USEFUL band.
 *
 * Deliberately NOT clamped to the encoder's accepted range alone: a value inside the accepted range
 * but outside the useful one is valid to ffmpeg and useless to the user — `crf 0` on x264 is
 * lossless and multiplies the file, and `crf 51` is visibly destroyed. Accepting the encoder's full
 * range would let a profile mean something nobody wants.
 */
export function clampQuality(codec: VideoCodec, quality: number): number {
  const band = CODEC_QUALITY_BANDS[codec];
  if (!Number.isFinite(quality)) return band.default;
  // Clamped to the USEFUL band, whose ends are `best` (the smaller number) and `worst`.
  return Math.max(band.best, Math.min(band.worst, Math.round(quality)));
}

/**
 * The PER-CODEC default encoder, from measurement rather than taste.
 *
 * MEASURED 2026-09-22 on the reference host (RTX 4090, 1080p60, 30s window, size AT MATCHED VMAF
 * against a lossless reference):
 *
 *   h264  libx264 crf23   13.26 MB  VMAF 92.58
 *         h264_nvenc cq32 13.11 MB  VMAF 92.02   -> parity, software is the general default
 *   av1   libsvtav1 crf35 10.86 MB  VMAF 93.79
 *         av1_nvenc cq40   9.03 MB  VMAF 92.07   -> ~22% smaller at comparable quality
 *
 * H.264 stays on software: `libx264` is universally decodable, already fast at these durations, and
 * hardware buys no size advantage at equal quality. AV1 defaults to HARDWARE: `av1_nvenc` beat
 * `libsvtav1` on both size at comparable quality and encode time, and software AV1 is slow enough
 * that hardware is the obviously better default.
 */
export const MEASURED_ENCODER_DEFAULTS: Record<VideoCodec, "software" | "hardware"> = {
  h264: "software",
  h265: "software",
  vp9: "software",
  av1: "hardware",
};

/**
 * A hardware encoder's own useful quality band, MEASURED, for mapping a software CRF onto it.
 *
 * An OFFSET cannot express this, which is what a `+16` for AV1 got wrong: the two scales do not move
 * together. x264's useful band is 12 points wide and `h264_nvenc`'s is also 12, so a constant +8
 * happens to work there; SVT-AV1's is 17 points wide against `av1_nvenc`'s 9, so the same quality
 * request lands anywhere from cq 32 to cq 46 depending on where in the band it sits. The measured
 * endpoints are used directly instead of inferred from one point.
 */
export interface HardwareQualityBand {
  /** The cq that matches the software band's `best` (its lossless-ish edge). */
  best: number;
  /** The cq that matches the software band's `worst` (its visibly-damaged edge). */
  worst: number;
  /**
   * The encoder's ACCEPTED range, from `ffmpeg -h encoder=...` on this host, for the final clamp.
   * Distinct from the useful band above: av1_nvenc accepts up to 63 but is unusable past ~46.
   */
  accepts: { from: number; to: number };
  /**
   * MEASURED encode speed at 1080p60, as a multiple of realtime, or null when no encoder for this
   * codec exists on the reference host to measure.
   *
   * Null is the honest value for H.265 and VP9: the host exposes `h264_nvenc` and `av1_nvenc` only,
   * so there is nothing to time. A borrowed number would read as measured.
   */
  speed: number | null;
}

/**
 * MEASURED encode speed per CONCRETE encoder, as a multiple of realtime at 1080p60.
 *
 * Keyed by ffmpeg encoder name, not by codec or by "cpu/hardware", because those two distinctions are
 * not what the number depends on: this host has an RTX 4090's `h264_nvenc` AND the 7950X's
 * `h264_vaapi` iGPU, and they are different silicon with different speeds. Reporting one family's
 * measurement under another's name is a borrowed number, which reads as measured.
 *
 * ABSENT means UNMEASURED — the UI shows nothing rather than a borrowed figure. `h264_vaapi`,
 * `hevc_vaapi` and `hevc_nvenc` are absent for exactly that reason: nothing was timed for them.
 */
export const MEASURED_ENCODER_SPEEDS: Record<string, number> = {
  libx264: 5.2,
  libx265: 2.2,
  "libvpx-vp9": 0.8,
  libsvtav1: 2.0,
  h264_nvenc: 6.2,
  av1_nvenc: 6.0,
};

/**
 * Where each software codec's useful band lands on its hardware encoder's scale.
 *
 * MEASURED on the reference host (RTX 4090, 1080p60, 15s window, VMAF against a lossless reference)
 * by interpolating the hardware sweep to each end of the software band:
 *
 *   h264  libx264 crf 18..30  (VMAF 95.20..84.49)  ->  h264_nvenc cq 26..38   (slope 1.0)
 *   av1   libsvtav1 crf 28..45 (VMAF 95.22..91.31) ->  av1_nvenc  cq 32..41   (slope 0.53)
 *
 * The AV1 rows are why this is a band and not a number: the same `+16` that would be tolerable near
 * the bottom of the AV1 band overshoots to the least useful cq the encoder accepts at its default.
 */
export const HW_QUALITY_BANDS: Record<VideoCodec, HardwareQualityBand> = {
  h264: { best: 26, worst: 38, accepts: { from: 0, to: 51 }, speed: 6.2 },
  // H.265 and VP9 have no hardware encoder on the reference host, so nothing was timed.
  h265: { best: 26, worst: 38, accepts: { from: 0, to: 51 }, speed: null },
  vp9: { best: 26, worst: 38, accepts: { from: 0, to: 63 }, speed: null },
  av1: { best: 32, worst: 41, accepts: { from: 0, to: 63 }, speed: 6.0 },
};

/**
 * The hardware quality that corresponds to a software CRF, on the hardware encoder's own scale.
 *
 * Interpolated across the two MEASURED bands rather than offset by a constant — see
 * `HW_QUALITY_BANDS`. The software value is clamped into its own band first, so a request from
 * outside the band maps to that band's edge instead of extrapolating past it.
 *
 * Worked examples, both matching the encoders' measured behaviour:
 *   crf 23 (the x264 default) -> cq 31, the cq measured to match crf 23's VMAF.
 *   crf 35 (the SVT-AV1 default) -> cq 36, likewise.
 */
export function hardwareQualityFor(codec: VideoCodec, softwareQuality: number): number {
  const sw = CODEC_QUALITY_BANDS[codec];
  const hw = HW_QUALITY_BANDS[codec];
  const q = clampQuality(codec, softwareQuality);
  // 0 at the software band's `best` (its highest quality), 1 at its `worst`. The hardware band is
  // walked the same way, so the inverted direction of the CRF scale is carried by the endpoints
  // rather than assumed in the arithmetic here.
  const t = (q - sw.best) / (sw.worst - sw.best || 1);
  const cq = Math.round(hw.best + t * (hw.worst - hw.best));
  return Math.max(hw.accepts.from, Math.min(hw.accepts.to, cq));
}

/** Whether the given profile wants the hardware encoder, resolving `auto` per codec. */
export function resolvesToHardware(p: ExportProfile): boolean {
  if (p.encoder === "hardware") return true;
  if (p.encoder === "software") return false;
  return MEASURED_ENCODER_DEFAULTS[p.videoCodec] === "hardware";
}

export interface ExportPreset {
  id: string;
  name: string;
  /**
   * The FULL profile this preset stands for.
   *
   * A preset used to carry only the legacy subset (format/aspectRatio/cropPosition/captions/
   * nameTemplate), which meant it could not express the encoder, the resolution cap or the bitrate
   * ceiling — three of the things that most change what a user gets. Stored as
   * `export_presets.config_json`, so it is the profile that is saved, not a shape that resembles one.
   */
  profile: ExportProfile;
  createdAt: string;
  /**
   * Who the preset belongs to, and therefore whether it can be deleted.
   *
   * `seeded` presets ship with the app and are the user's to SELECT but not to remove — deleting one
   * would silently change the starting point for every future export, with no way back. `user`
   * presets are the user's own and deletable.
   *
   * Carried from the server rather than inferred from a hardcoded id list in the UI: the server owns
   * the column, it refuses the delete by name, and the UI then only has to render what it was told.
   * A client-side list also had to be kept in step with the presets themselves, which is exactly the
   * kind of duplication that drifts.
   */
  origin: "seeded" | "user";
}

export interface ExportClipInput {
  clipId: string;
  /**
   * The full output profile. Preferred over the legacy individual fields below.
   *
   * Absent for an older client: the fields are then folded into a profile by `normaliseProfile`, so
   * one profile type is what the encoder ever sees and the two shapes cannot diverge.
   */
  profile?: ExportProfile;
  format?: ExportFormat;
  aspectRatio?: AspectRatio;
  captions?: CaptionStyle;
  outputPath: string | null; // null = default location
  /** Filename without extension; null = server default (semaclip_axis_peaktime). */
  filename: string | null;
  /** Progress of the encode, in encoded seconds of the clip. Used by the export batch. */
  onProgress?: ((p: { encodedSec: number }) => void) | undefined;
  /** Cancellation for the encode. Used by the export batch's cancel. */
  signal?: AbortSignal | undefined;
}
/**
 * What the SOURCE video actually is.
 *
 * Needed for the export's "use the original bitrate" option: whether that is even possible depends on
 * whether the chosen output format matches the source's codec, and the number shown to the user has to
 * be the real one rather than a guess. Every field is nullable because a probe can fail — and an
 * unmeasured value must be reported as unmeasured, never as a default that reads as measured.
 */
export interface SourceMedia {
  /** The source video codec, as ffprobe names it (`h264`, `vp9`, ...). */
  codec: string | null;
  /** The source VIDEO bitrate in kbps, audio excluded when it can be determined. */
  bitrateKbps: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
}

export interface ExportResult {
  clipId: string;
  exportPath: string;
  durationMs: number;
  /**
   * Which encoder actually produced the file.
   *
   * Reported by what RAN, never by what was requested: a hardware export that fails and falls back
   * to the CPU would otherwise claim `nvenc`, and the file would contradict it. Optional because an
   * older client/server pair may not send it.
   */
  backend?: string;
}

// ── The export list and the export batch ───────────────────────
//
// A clip is a persistent entity; the LIST is the user's intent to export it, and the BATCH is the
// work that carries that intent out. They are separate because they fail differently: the list must
// survive a restart untouched, while the batch is meant to resume.

/** One entry in the export list: a REFERENCE to a clip, plus the context the page renders. */
export interface ExportListEntry {
  clipId: string;
  streamId: string;
  streamTitle: string;
  position: number;
  addedAt: string;
  /** The clip itself, resolved for display. Null when the clip row no longer exists at all. */
  clip: Clip | null;
}

export const EXPORT_STATUSES = ["queued", "running", "completed", "failed", "cancelled"] as const;
export type ExportStatus = (typeof EXPORT_STATUSES)[number];

/** What an export is doing, in the order it happens. The UI names these to the user. */
export const EXPORT_PHASES = ["probing", "encoding", "finalising"] as const;
export type ExportPhase = (typeof EXPORT_PHASES)[number];

/** One item of the export batch, as the UI reads it. */
export interface ExportJobView {
  clipId: string;
  streamId: string | null;
  /** Display name for the item — the clip's title, its axis, or its kind. */
  label: string;
  status: ExportStatus;
  /** 1-based position among the pending items; 0 once it is no longer waiting. */
  position: number;
  phase: ExportPhase | null;
  /** 0-1 progress of THIS item. */
  percent: number;
  startedAt: string | null;
  completedAt: string | null;
  /** Where the finished file landed, and where a partial one is — for cancel to delete. */
  artifactPath: string | null;
  exportPath: string | null;
  error: string | null;
  /** Seconds of media in the clip, for an ETA. Null when the clip is unknown. */
  durationSec: number | null;
  /** Measured seconds per media-second so far, for an ETA. Null before there is enough evidence. */
  secondsPerMediaSecond: number | null;
}

/** The batch, with the totals a progress bar and its stats need. */
export interface ExportQueueView {
  items: ExportJobView[];
  /** Counts by status — the stat line reads these, never a client-side re-count. */
  counts: Record<ExportStatus, number> & { total: number };
  /** 0-1 across the WHOLE batch, so the bar does not reset at each item. */
  percent: number;
  /** Wall-clock start of the batch (first item that ran), for elapsed. */
  startedAt: string | null;
  /** Estimated seconds remaining, or null when it cannot honestly be estimated. */
  etaSec: number | null;
  running: string | null;
}

// ── WebSocket events (Deno → frontend) ────────────────────────
// The backend forwards engine events plus its own job-lifecycle events.

export type WsEvent =
  | EngineEvent
  | { type: "job_status"; jobId: string; status: JobStatus; streamId: string }
  | { type: "stream_status"; streamId: string; status: StreamStatus }
  | { type: "export_progress"; clipId: string; status: ExportStatus; percent: number; phase: ExportPhase | null }
  | { type: "export_queue"; reason: "enqueued" | "started" | "progress" | "item_done" | "finished" | "cancelled" }
  /**
   * The durable export LIST changed — the list itself, not the batch running over it.
   *
   * A separate variant from `export_queue` because the two have different consequences: a queue
   * transition also invalidates the clip rows (an export writes `exported`/`export_path` onto its
   * clip), while adding or removing a reference touches nothing but the list.
   */
  | { type: "export_list"; reason: "added" | "removed" | "cleared" }
  | { type: "download_progress"; jobId: string; percent: number; bytesDownloaded: number; totalBytes: number }
  /**
   * A stream's stored state changed (an artifact was deleted or attached, a download
   * finished). The client refetches rather than polling for it.
   */
  | { type: "stream_changed"; streamId: string; reason: "chat" | "video" | "proxy" | "download" | "metadata" };

// ── App settings ──────────────────────────────────────────────

export interface AppSettings {
  gpuDevice: number | null; // CUDA device index, null = auto
  exportDir: string;
  /**
   * Where a new VOD download creates its project folder.
   *
   * Existing projects keep their OWN location (each records its own path), so changing this
   * never relocates anything already downloaded — it only decides where the next download
   * lands. Empty means "the app's cache, as before", which the server resolves to a concrete
   * path when it reads the setting.
   */
  vodDir: string;
  defaultAspectRatio: AspectRatio;
  defaultCaptions: CaptionStyle;
  engineBinaryPath: string | null;
  /**
   * How hard SemaClip may push the CPU ("I bought my CPU to use it" tiers).
   * slow = ≤25% of cores, medium = ≤50%, fast = all cores. Applied to the
   * transcription worker pool and whisper thread count; re-probed per job.
   */
  cpuUsage: "slow" | "medium" | "fast";
  /**
   * Default max download quality (vertical px, orientation-safe) for the
   * HQ pass / single downloads; null = no cap (source quality). The import
   * modal's selector overrides this per download.
   */
  defaultMaxQualityHeight: number | null;
  /**
   * Overall UI scale, as a multiplier of the app's 14px base font.
   *
   * medium (1.5) is the DEFAULT — the app is dense by design and 1.0 is smaller
   * than comfortable on a normal monitor. Exposed as small/medium/large rather
   * than a free percentage so the three states are deliberately chosen and
   * testable, and applied as a root font-size so every rem-based size and
   * Tailwind spacing utility scales together.
   */
  uiScale: UiScale;
}

/** Discrete UI scale steps. Values are multipliers of the 14px base, so
 * small (1.0) is exactly the app's original density. */
export const UI_SCALE_FACTOR = {
  small: 1,
  medium: 1.5,
  large: 2,
} as const;

export type UiScale = keyof typeof UI_SCALE_FACTOR;

/**
 * ffmpeg availability, as reported by GET /api/tools.
 *
 * The app resolves ffmpeg PATH-first (see server/adapters/outbound/ffmpeg/
 * tool-paths.ts) rather than bundling ~330MB into every installer, so the UI needs
 * to ask whether it is missing and offer a download. `downloadable` is false when
 * an explicit override points somewhere that does not exist — in that case a
 * download would not help and the UI says so instead of offering it.
 */
export interface ToolStatus {
  /**
   * Resolved binary locations plus WHERE they came from. "missing" means discovery
   * found nothing, so the pair is only ever names to attempt — check `available`.
   */
  paths: { ffmpeg: string | null; ffprobe: string | null; source?: "env" | "managed" | "path" | "missing" };
  /** False when the binaries are missing and must be provisioned. */
  available: boolean;
  /** True when a user-approved download could supply them. */
  downloadable: boolean;
  /** Where an approved download would be installed. */
  managedDir: string;
  platform: string;
}
