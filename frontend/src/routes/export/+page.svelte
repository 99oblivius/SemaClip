<script lang="ts">
  import { createQuery, createMutation, useQueryClient } from '@tanstack/svelte-query';
  import { page } from '$app/stores';
  import { apiClient } from '$lib/api/client';
  import { renderFilenameTemplate, FILENAME_TOKENS, type FilenameFacts } from '$lib/filename';
  import { playerStore } from '$lib/stores/player';
  import Icon from '$lib/components/Icon.svelte';
  import { fadeIn } from '$lib/actions/gsap';
  import type { Clip, ExportFormat, AspectRatio, AudioCodec, CaptionStyle, ExportPreset, ExportProfile, VideoCodec, EncoderChoice, QualityTier } from '$shared/types';
  import { CODEC_QUALITY_BANDS, AUDIO_CODECS, CONTAINER_AUDIO_MATRIX, defaultAudioFor, pairForFormat, formatForPair, MEASURED_ENCODER_DEFAULTS, QUALITY_TIERS, TIER_FRACTION, clampQuality, qualityForTier, bitsForQualityScaled, bitrateForTier, sensibleBitrateKbps } from '$shared/types';

  const queryClient = useQueryClient();

  // Selected clip: ?clip=<id> query param, else the first un-rejected clip.
  // SSR: window is undefined — $page.url is the SSR-safe equivalent.
  let selectedClipId = $state($page.url.searchParams.get('clip'));

  const presetsQuery = createQuery(() => ({
    queryKey: ['presets'],
    queryFn: () => apiClient.listPresets(),
  }));

  /**
   * The export LIST — durable references to the clips the user chose, NOT a live query over every
   * clip that happens to exist.
   *
   * This used to be derived from every completed stream's clips, which made the page's "list" mean
   * "all clips that exist" and the Review page's Export button a plain navigation. Sending a clip to
   * export is now a write, and this is where the result is read back.
   */
  const listQuery = createQuery(() => ({
    queryKey: ['export-list'],
    queryFn: () => apiClient.getExportList(),
    refetchInterval: 30000,
  }));

  /**
   * The export BATCH — polled while work is pending, idle otherwise.
   *
   * Progress also arrives over the websocket; this poll is the safety net for a dropped socket (the
   * same arrangement the jobs page uses). It speeds up to 1s while anything is queued or running so
   * the bar moves even if the socket is down.
   */
  const queueQuery = createQuery(() => ({
    queryKey: ['export-queue'],
    queryFn: () => apiClient.getExportQueue(),
    refetchInterval: (query) => {
      const d = query.state.data;
      if (!d) return 15000;
      const active = (d.counts?.queued ?? 0) + (d.counts?.running ?? 0);
      return active > 0 ? 1000 : 15000;
    },
  }));

  const entries = $derived(listQuery.data?.entries ?? []);
  /** Entries whose clip row no longer exists — shown as unavailable, never silently dropped. */
  const unavailable = $derived(entries.filter((e) => e.clip === null));
  const queue = $derived(queueQuery.data);
  /** Batch items by clip, so a list row can show its own progress without scanning the array. */
  const jobsByClip = $derived(
    new Map((queue?.items ?? []).map((i) => [i.clipId, i])),
  );

  /**
   * The exportable list: resolved entries only.
   *
   * A reference whose clip is gone is separated out rather than filtered away in silence — the list
   * length must still account for what the user added, and the page can then say which entry is
   * unusable instead of quietly showing fewer items than they sent.
   */
  let acceptedClips = $derived(
    entries
      .filter((e): e is typeof e & { clip: Clip } => e.clip !== null)
      .map((e) => ({
        streamId: e.streamId,
        streamTitle: e.streamTitle,
        clip: e.clip,
        clipId: e.clipId,
      })),
  );

  const selected = $derived(
    acceptedClips.find((x) => x.clip.id === selectedClipId) ?? acceptedClips[0] ?? null,
  );

  // ── Export config state (initialized from the selected preset) ──
  let activePresetId = $state<string | null>(null);
  let format = $state<ExportFormat>('mp4_h264');
  /**
   * The container and codec, derived from `format` through the SHARED mapping.
   *
   * Not a local three-way ternary: the format table lives in `shared/types.ts` (and grew AV1 in both
   * containers), so a copy here would silently disagree with what `normaliseProfile` and the server
   * consider the same format to mean. One owner, read from both places.
   */
  const pair = $derived(pairForFormat(format) ?? { container: 'mp4' as const, videoCodec: 'h264' as const });
  /**
   * The file extension the CURRENT format produces.
   *
   * Derived, not written per format: the server names the file from the container, so a preview
   * carrying a hardcoded `.mp4` promised a filename the export would not produce for a WebM or MKV.
   * A table rather than a ternary so a container added without updating this cannot silently inherit
   * another container's extension — the same shape as the server's own naming.
   */
  const extension = $derived({ mp4: '.mp4', webm: '.webm', mkv: '.mkv' }[pair.container]);
  const codec = $derived<VideoCodec>(pair.videoCodec);
  const band = $derived(CODEC_QUALITY_BANDS[codec]);
  /**
   * Encoder choice, quality and the bitrate ceiling.
   *
   * Quality is stored in the codec's own scale and CLAMPED to its useful band, so switching codec
   * cannot leave a value outside the range that codec does anything useful with.
   */
  let encoderChoice = $state<EncoderChoice>('auto');
  /**
   * The CONCRETE encoder the user picked from this machine's list, or null for "the default".
   *
   * Separate from `encoderChoice` because a machine can have several hardware encoders for one codec
   * (this host has `h264_nvenc` and `h264_vaapi`) and they are not interchangeable — one is a discrete
   * NVIDIA card, the other an iGPU. `encoderChoice` says CPU or GPU; this says which.
   */
  let encoderEncoderName = $state<string | null>(null);
  let quality = $state(23);
  let forceBitrate = $state(false);
  let bitrateKbps = $state(0);

  /**
   * What the bitrate control held BEFORE a format change overrode it, so returning to the source's
   * format restores the user's own state exactly.
   *
   * A format change cannot reuse the source's bitrate — a transcode to another codec has no original
   * rate to fall back to — so it forces a sensible one. That override must not DESTROY what the user
   * had: switching away and back has to land on the original bitrate again, whether they were using
   * the source's own rate or had pinned a custom one.
   */
  let bitrateBeforeFormatChange = $state<{ forced: boolean; kbps: number } | null>(null);

  /**
   * The selected clip's SOURCE video facts, probed from the server.
   *
   * Needed to make "the original bitrate is used" a real statement rather than a claim: the number is
   * the source's own, and whether it can be reused depends on the source's CODEC — a transcode to a
   * different codec has no original bitrate to reuse.
   */
  const sourceMediaQuery = createQuery(() => ({
    queryKey: ['source-media', selected?.streamId ?? null],
    queryFn: () => apiClient.getSourceMedia(selected!.streamId),
    enabled: !!selected,
  }));
  const sourceMedia = $derived(sourceMediaQuery.data ?? null);
  /** The geometry and rate the bitrate estimate should describe: the source's, when known. */
  const sourceWidth = $derived(sourceMedia?.width ?? 1920);
  const sourceHeight = $derived(sourceMedia?.height ?? 1080);
  const sourceFps = $derived(sourceMedia?.fps ?? 60);

  /** The source codec as the OUTPUT codec, so the two are comparable by name. */
  const outputCodecLabel = $derived(codec.toUpperCase());

  /**
   * Whether the chosen output format matches the source's codec.
   *
   * `null` (unprobed) is treated as MISMATCHED, which forces a bitrate: assuming a match we cannot see
   * would silently claim "the original bitrate is used" for a transcode.
   */
  const sourceMatchesOutput = $derived.by(() => {
    const src = sourceMedia?.codec;
    if (!src) return false;
    // ffprobe says `h264`/`hevc`/`vp9`/`av1`; the profile says h264/h265/vp9/av1.
    const normalised = src === 'hevc' ? 'h265' : src;
    return normalised === codec;
  });

  /**
   * The FORMAT selection at which the source's own bitrate is reusable.
   *
   * Derived from the probed source codec rather than remembered: the export can start with the source
   * unmeasured (the probe is async), so a value captured at mount would be wrong. Keyed on the codec
   * because `format` is the legacy three-way control that the layout is built around — the same
   * h264 source can be reached from `mp4_h264` only, and a webm source from `webm`.
   */
  const sourceFormat = $derived.by<ExportFormat>(() => {
    const src = sourceMedia?.codec;
    if (!src) return format;
    const normalised = src === 'hevc' ? 'h265' : src;
    // A source codec maps onto the format that names it; the container is the source's own, and VP9/
    // AV1 in MP4 are not states a SOURCE here can be in, so `formatForPair` resolves the rest.
    if (normalised === 'vp9') return formatForPair('webm', 'vp9');
    if (normalised === 'av1') return formatForPair('webm', 'av1');
    if (normalised === 'h265') return formatForPair('mp4', 'h265');
    return formatForPair('mp4', 'h264');
  });
  let aspectRatio = $state<AspectRatio>('16:9');
  let captionsEnabled = $state(false);
  let captionPreset = $state<CaptionStyle['preset']>('bold-white');
  let captionPosition = $state<CaptionStyle['position']>('bottom');
  let captionFontSize = $state(48);
  let captionBgOpacity = $state(0.8);
  let nameTemplate = $state('{date}-{channel}-{name}-{ts}');
  let presetTouched = $state(false);

  const presets = $derived(presetsQuery.data ?? []);

  /**
   * The preset the controls currently represent, by id.
   *
   * `presets[0]` is the fallback rather than null: the page must ALWAYS have a selected preset, which
   * is what makes the controls renderable and their values meaningful with no clip and no prior
   * choice. A null here is the state that left the encoder and quality controls unreachable.
   */
  const activePreset = $derived(
    presets.find((p) => p.id === activePresetId) ?? presets[0] ?? null,
  );

  /**
   * A preset-level failure (a refused delete, a failed save), shown in the actions row.
   *
   * Needed because the seeded-delete refusal is a 409 the server sends deliberately: swallowing it
   * would leave the user pressing a button that silently does nothing.
   */
  let presetError = $state<string | null>(null);

  /**
   * Whether the Advanced (encoder) section is open. Closed by default: the quality scale and encoder
   * matrix are the settings that most often make a page look complicated without being the decision
   * the user came to make.
   */
  let showAdvanced = $state(false);

  // Applying a preset fills every control (P0-7: one applied by default).
  $effect(() => {
    if (presets.length === 0 || presetTouched) return;
    const target = presets.find((p) => p.id === activePresetId) ?? presets[0];
    if (!target) return;
    applyPreset(target);
  });

  /** Format from a container/codec pair, through the shared inverse mapping. */
  function formatOf(profile: ExportProfile): ExportFormat {
    return formatForPair(profile.container, profile.videoCodec);
  }

  /**
   * ── SETTERS VS. RADIOS, and why Revert could not work without this split ─────────────────────
   *
   * The controls on this page are two different KINDS of thing, and treating them alike is what made
   * Revert look broken:
   *
   *   RADIOS hold a current VALUE that is always displayed (format, aspect ratio, encoder, caption
   *   on/off and its placement, the filename template). Their state IS the selection, so reverting
   *   them means writing the preset's value back.
   *
   *   SETTERS are ACTIONS that push a value somewhere else and hold nothing themselves: a quality
   *   tier ("draft", "standard", …) and its sibling `Maximum quality` button are one-shot setters for
   *   the quality AND the bitrate. Pressing one is not selecting "draft" as a mode — it writes a
   *   quality and a bitrate, and then the buttons must all read UNSELECTED, because the user has not
   *   selected a mode; they have taken an action. A tier staying lit is the same category error as a
   *   "Save" button staying pressed.
   *
   * So `selectedTier` does not exist. There is nothing to highlight, and reverting a tier is
   * meaningless — the SETTER's effect lives in `quality` and `bitrateKbps`, which Revert restores
   * from the preset like every other value. This is also why no tier button can ever be re-lit by
   * landing on its number: there is no tier state to derive from the number.
   *
   * A manual quality edit is not a third category — it is the user writing the value directly.
   */

  /** The values a preset contributes to the controls. ONE source, used by apply and by revert. */
  function valuesFromPreset(p: ExportPreset) {
    const prof = p.profile;
    return {
      format: formatOf(prof),
      encoderChoice: prof.encoder,
      encoderName: prof.encoderName,
      quality: prof.options.quality,
      forceBitrate: prof.options.maxBitrateKbps !== null,
      bitrateKbps: prof.options.maxBitrateKbps ?? sensibleBitrateKbps(prof.videoCodec, 1920, 1080, 60),
      aspectRatio: prof.aspectRatio,
      audioCodec: prof.audioCodec,
      captions: { ...prof.captions },
      nameTemplate: prof.nameTemplate,
    };
  }

  /**
   * Write a preset's values into the controls.
   *
   * `applyPreset` and `revertToPreset` are THE SAME OPERATION — write the preset's values — and the
   * only difference is that applying also adopts the preset as the active one. That is why they share
   * this body: a separate "revert" implementation is what made Revert fail to cover every control,
   * since each new control had to be added to two places and only one of them got updated.
   */
  function writeValues(v: ReturnType<typeof valuesFromPreset>) {
    format = v.format;
    encoderChoice = v.encoderChoice;
    encoderEncoderName = v.encoderName;
    quality = v.quality;
    forceBitrate = v.forceBitrate;
    bitrateKbps = v.bitrateKbps;
    aspectRatio = v.aspectRatio;
    audioCodec = v.audioCodec;
    // Every caption field, not just `enabled` — a revert that switched captions on but left the
    // font size from an edit has not reverted anything.
    captionsEnabled = v.captions.enabled;
    captionPreset = v.captions.preset;
    captionPosition = v.captions.position;
    captionFontSize = v.captions.fontSize;
    captionBgOpacity = v.captions.backgroundOpacity;
    nameTemplate = v.nameTemplate;
    // An override belongs to the format that caused it; a fresh set of values is a fresh baseline.
    bitrateBeforeFormatChange = null;
  }

  function applyPreset(p: ExportPreset) {
    activePresetId = p.id;
    writeValues(valuesFromPreset(p));
  }

  /** Discard every edit and return to the active preset. */
  function revertToPreset() {
    const p = activePreset;
    if (!p) return;
    presetTouched = false;
    writeValues(valuesFromPreset(p));
  }

  /**
   * Switching codec re-clamps the quality.
   *
   * Necessary because the scales differ: VP9's useful band runs to crf 42 while x264's stops at 30,
   * so carrying a number across codecs can land outside the new codec's useful range — either
   * wasting time at 24 on VP9 (which is past its lossless point) or producing a visibly damaged file
   * at 42 on x264.
   *
   * ── The BITRATE is OVERRIDDEN, never overwritten (owner correction) ──────────────────────────
   * The bitrate control can mean two different things: "use the source's own rate" (off) or "use this
   * pinned number" (on). Changing the format makes the source's rate unusable — a transcode to another
   * codec has no original rate to fall back to — so the control has to move to a forced one. But that
   * is a TEMPORARY override of the user's intent, not a replacement for it: `bitrateBeforeFormatChange`
   * remembers exactly what they had, and returning to the source's format restores it, so switching
   * away and back leaves the user where they started rather than silently converting "use the source's
   * rate" into a pinned number they never chose.
   */
  function changeFormat(next: ExportFormat) {
    const nextPair = pairForFormat(next);
    const nextCodec: VideoCodec = nextPair?.videoCodec ?? 'h264';
    const wasSourceFormat = format === sourceFormat;
    const previousPair = pairForFormat(format);
    format = next;
    presetTouched = true;
    quality = clampQuality(nextCodec, quality);

    // The audio codec follows the CONTAINER, and only when crossing containers. Switching MP4/H.264 →
    // MP4/AV1 keeps AAC (the container accepts it); MP4 → WebM must not carry AAC across, because the
    // container cannot hold it and the profile would be refused. An explicit choice the user made
    // within one container survives a codec change inside it.
    if (nextPair && previousPair && nextPair.container !== previousPair.container) {
      if (!CONTAINER_AUDIO_MATRIX[nextPair.container].includes(audioCodec)) {
        audioCodec = defaultAudioFor(nextPair.container);
      }
    }

    const nowSourceFormat = next === sourceFormat;
    if (nowSourceFormat) {
      // Back at the source's own format: give the user their state back, if we overrode it.
      if (bitrateBeforeFormatChange) {
        forceBitrate = bitrateBeforeFormatChange.forced;
        bitrateKbps = bitrateBeforeFormatChange.kbps;
        bitrateBeforeFormatChange = null;
      }
      return;
    }
    // Leaving the source's format: remember the user's state ONCE, so repeated format changes do not
    // overwrite the memory with a previous override's value.
    if (wasSourceFormat && !bitrateBeforeFormatChange) {
      bitrateBeforeFormatChange = { forced: forceBitrate, kbps: bitrateKbps };
    }
    forceBitrate = true;
    bitrateKbps = sensibleBitrateKbps(nextCodec, sourceWidth, sourceHeight, sourceFps);
  }

  /**
   * A tier click: a ONE-SHOT SETTER for the quality AND the bitrate.
   *
   * Both together because a tier is a complete description of "what kind of file", and leaving the
   * bitrate from a previous tier behind would silently contradict the quality just chosen. The two
   * numbers come from the MEASURED quality->bitrate curve for this codec (`bitrateForTier`), scaled to
   * the source's own resolution and frame rate, so `maximum` really is a bigger file than `draft`.
   *
   * Nothing is highlighted afterwards. The user took an ACTION, not selected a mode — so the buttons
   * all read unselected, and the resulting numbers are what the controls show.
   */
  function applyTier(tier: QualityTier) {
    quality = qualityForTier(codec, tier);
    presetTouched = true;
    // A tier always sets the bitrate: it is the value the tier MEANS. Setting it only when the bitrate
    // was already forced left the two disagreeing about the same choice.
    forceBitrate = true;
    bitrateKbps = bitrateForTier(codec, tier, sourceWidth, sourceHeight, sourceFps);
  }

  /**
   * A manual quality edit: the user is writing the value directly.
   *
   * It moves the forced bitrate to follow, since the pair is what describes the output — otherwise the
   * number would still belong to a quality the user has just left.
   */
  function onManualQuality() {
    presetTouched = true;
    if (forceBitrate) bitrateKbps = bitsForQualityScaled(codec, quality, sourceWidth, sourceHeight, sourceFps);
  }

  /**
   * The encoders this machine actually offers for the current codec.
   *
   * Fetched rather than assumed: the list is the host's, verified by encoding. Until it arrives the
   * picker shows nothing rather than guessing, and if it fails the software entry is the only safe
   * fallback because it always exists.
   */
  const encodersQuery = createQuery(() => ({
    queryKey: ['encoders', codec],
    queryFn: () => apiClient.listEncoders(codec),
  }));
  const encoderOptions = $derived(encodersQuery.data ?? []);
  /** The entry the export will use: the explicit choice, else the measured default for this codec. */
  const chosenEncoder = $derived.by(() => {
    const hwDefault = MEASURED_ENCODER_DEFAULTS[codec] === 'hardware';
    if (encoderEncoderName) {
      const explicit = encoderOptions.find((o) => o.encoder === encoderEncoderName);
      if (explicit) return explicit;
    }
    const preferred = hwDefault
      ? encoderOptions.find((o) => !o.software)
      : encoderOptions.find((o) => o.software);
    return preferred ?? encoderOptions[0] ?? null;
  });
  /** Whether the machine offers ANY hardware encoder for this codec. */
  const hwAvailable = $derived(
    encodersQuery.data ? encoderOptions.some((o) => !o.software) : null,
  );

  /** The encoder actually used for the current codec under `auto`, per the measured defaults. */
  const autoEncoder = $derived(MEASURED_ENCODER_DEFAULTS[codec]);

  /**
   * The audio codec for the chosen format.
   *
   * A RADIO like the others: its value IS the state. Defaulted per container rather than fixed, so
   * switching from MP4 to WebM lands on that container's own default (Opus) instead of carrying AAC
   * into a container that cannot hold it.
   */
  let audioCodec = $state<AudioCodec>('aac');

  /**
   * How each audio codec is LABELLED and explained.
   *
   * A table rather than a title ternary: the control shows raw codec ids otherwise, and `PCM_S16LE`
   * is a mouthful nobody chooses deliberately. `pcm` is labelled by what it IS (uncompressed) because
   * that is the reason to pick it.
   */
  const AUDIO_INFO: Record<AudioCodec, { label: string; note: string }> = {
    aac: { label: 'AAC', note: 'The standard MP4 audio codec — universally accepted' },
    opus: { label: 'Opus', note: 'The current WebM standard (RFC 7845) and the best quality per bit' },
    vorbis: { label: 'Vorbis', note: 'Older editors that predate Opus read Vorbis but not Opus' },
    mp3: { label: 'MP3', note: 'Universally playable, but an old lossy codec — pick it only for compatibility' },
    flac: { label: 'FLAC', note: 'Lossless and compressed. No bitrate to choose — it is whatever the source needs' },
    pcm_s16le: { label: 'PCM 16', note: 'Uncompressed 16-bit — a perfect copy of the source, and very large' },
    pcm_s24le: { label: 'PCM 24', note: 'Uncompressed 24-bit — for sources mastered above 16-bit, and larger still' },
    // Never reaches the control (the options list excludes it), but the table must be total: a
    // missing key would be a runtime error on the one codec whose label is least likely to be tested.
    none: { label: 'None', note: 'No audio track' },
  };

  const audioOptions = $derived(AUDIO_CODECS.filter((c) => c !== 'none' && CONTAINER_AUDIO_MATRIX[pair.container].includes(c)));

  /** The selected clip's duration in seconds, for the encode-time estimate. */
  const clipSeconds = $derived.by(() => {
    const c = selected?.clip;
    return c ? Math.max(0, Math.round(c.endTime - c.startTime)) : 0;
  });

  /**
   * The crop preview's image, from the server's own thumbnail route.
   *
   * Keyed on the clip AND its start second: the endpoint extracts at `at`, so the frame shown is the
   * frame the export begins on. Null when no clip is selected, which is when the fallback icon is
   * the honest thing to show.
   */
  const previewSrc = $derived(
    selected ? `/api/clips/${selected.clip.id}/thumbnail?at=${selected.clip.startTime}` : null,
  );
  /**
   * Reset when the clip changes: `onerror` is per-element, so a failure on one clip must not
   * suppress the image for the next one.
   */
  let previewFailed = $state(false);
  $effect(() => {
    void previewSrc;
    previewFailed = false;
  });

  /**
   * NOTE: there is deliberately NO pre-run encode-time estimate.
   *
   * The old one divided the clip's duration by a speed measured on the AUTHOR's machine, which is a
   * property of that machine rather than of the encoder — it quoted 6.2x to someone whose GPU would
   * never reach it. Nothing honest can be said before the encode starts, so nothing is said. Once it
   * IS running, the batch panel shows an ETA measured from the run's own progress.
   */

  /** Save the current controls as a named preset. */
  async function savePreset() {
    const name = presetName.trim();
    if (!name) return;
    const id = `preset-${name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40)}-${Date.now().toString(36)}`;
    await apiClient.savePreset({ id, name, profile: buildProfile() });
    presetName = '';
    showSavePreset = false;
    await queryClient.invalidateQueries({ queryKey: ['presets'] });
    activePresetId = id;
    presetTouched = false;
  }

  async function deletePreset(id: string) {
    presetError = null;
    try {
      await apiClient.deletePreset(id);
    } catch (e) {
      // The server refuses a seeded delete (409) and that refusal is the policy; surface its own
      // words rather than a generic failure, since it explains why nothing happened.
      presetError = e instanceof Error ? e.message : 'Could not delete the preset';
      return;
    }
    /**
     * Deleting the SELECTED preset falls back to the FIRST one.
     *
     * Not to null: an unselected state is what made every control unreachable, and there is no
     * meaningful "no preset" when the controls must still hold values. Setting the id (rather than
     * leaning on a `presets[0]` fallback) keeps the selection explicit so the list highlight agrees
     * with what the controls show.
     */
    if (activePresetId === id) {
      const next = presets.find((p) => p.id !== id) ?? null;
      if (next) applyPreset(next);
    }
    await queryClient.invalidateQueries({ queryKey: ['presets'] });
  }

  /**
   * Save the current settings under a new name.
   *
   * Distinct from Save: a copy is the user's own preset even when it was cloned from a seeded one, so
   * it is created with `user` origin and becomes deletable — which is the only way to keep the app's
   * defaults intact while still letting someone fork one.
   */
  async function duplicatePreset() {
    const src = activePreset;
    if (!src) return;
    presetError = null;
    const id = `preset-${src.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 30)}-${Date.now().toString(36)}`;
    try {
      await apiClient.savePreset({ id, name: `${src.name} copy`, profile: buildProfile() });
      await queryClient.invalidateQueries({ queryKey: ['presets'] });
      activePresetId = id;
      presetTouched = false;
    } catch (e) {
      presetError = e instanceof Error ? e.message : 'Could not duplicate the preset';
    }
  }

  let showSavePreset = $state(false);
  /** The seeded presets, which are not the user's to delete. */
  const DEFAULT_PRESET_IDS = new Set([
    'preset-landscape-169',
    'preset-tiktok-916',
    'preset-shorts-916-vp9',
    'preset-archive-169',
    'preset-archive-mkv',
  ]);
  let presetName = $state('');

  // ── Naming template preview (P1-2) ──
  /**
   * The facts a filename is rendered from. Built once so the Filename preview and the export list's
   * per-row filenames cannot disagree: they are the same renderer over the same facts.
   */
  function filenameFactsFor(item: typeof selected): FilenameFacts | null {
    if (!item) return null;
    return {
      channel: null,
      // The SAME precedence the rest of the app displays: the user's own name, then the engine's
      // axis, then nothing. Resolved here rather than in the renderer because the renderer draws a
      // template and does not decide what a clip is called.
      //
      // Read through `nameOf` so a rename in the Name field is reflected in the filename preview
      // immediately, without waiting for the round trip.
      name: nameOf(item.clip) || null,
      startTime: item.clip.startTime,
      streamTitle: item.streamTitle,
    };
  }

  const sampleName = $derived.by(() => {
    const facts = filenameFactsFor(selected);
    return facts ? renderFilenameTemplate(nameTemplate, facts) : '';
  });

  /** The filename each queued item WILL produce, for the list's own rows. */
  const filenameForItem = $derived.by(() => {
    const out = new Map<string, string>();
    for (const item of acceptedClips) {
      const facts = filenameFactsFor(item);
      if (facts) out.set(item.clipId, renderFilenameTemplate(nameTemplate, facts));
    }
    return out;
  });

  /**
   * The clip's NAME, editable on this page as well as in the preview.
   *
   * Only the field being edited lives in local state; the source of truth stays the query cache, so a
   * rename made in the preview is reflected here on the next read. Committed on blur and on Enter,
   * never per keystroke — every character would otherwise be a PATCH.
   */
  let nameDraft = $state('');
  let namesFor = $state<Record<string, string>>({});
  /**
   * Which clip the draft was seeded from.
   *
   * Seeding on the CLIP ID rather than on the clip object is what stops a background refetch from
   * overwriting text the user is mid-way through typing: the query cache fires on unrelated
   * invalidations, and re-seeding on every one of those would erase a name being entered.
   */
  let seededForId: string | null = null;

  $effect(() => {
    const id = selected?.clip.id ?? null;
    if (id !== seededForId) {
      seededForId = id;
      nameDraft = selected ? nameOf(selected.clip) : '';
    }
  });

  /**
   * The name shown: whatever is being typed, else the persisted value, else the row's own label.
   *
   * The label term is the fallback the owner chose: an unnamed clip's field starts from the SAME
   * word its row already shows (`manual`/`clip`) rather than sitting empty. An empty field on a page
   * whose whole job is naming the output reads as broken, and it made "the name is not populated"
   * indistinguishable from "this clip has no name". `title` first, then the engine's `axis` — the
   * SAME precedence the rest of the app displays.
   */
  function nameOf(clip: Clip): string {
    return namesFor[clip.id] ?? clip.title ?? clip.axis ?? 'manual';
  }

  function renameSelected(value: string) {
    if (!selected) return;
    const clip = selected.clip;
    const trimmed = value.trim();
    // A BLANK NAME IS A NO-OP — it neither saves nor asks the server anything.
    //
    // The server refuses an empty title by NAME (null is how a name is cleared), so sending one was
    // an HTTP 500 shown raw in the UI, on the single most likely action: select the field, clear it,
    // press Enter. Nothing is written and the field is restored to the stored value, so what the user
    // sees is the truth. Clearing a name back to unnamed is a deliberate act with its own route
    // (`title: null`), not something a stray backspace can do.
    if (trimmed.length === 0) {
      nameDraft = nameOf(clip);
      return;
    }
    if (trimmed === (clip.title ?? '')) {
      nameDraft = trimmed;
      return;
    }
    // Optimistic, so the field and the filename preview do not flicker back to the old value while
    // the request is in flight. The cache is the real source; this map only bridges the gap.
    namesFor = { ...namesFor, [clip.id]: trimmed };
    renameMutation.mutate({ clipId: clip.id, title: trimmed });
  }

  const renameMutation = createMutation(() => ({
    mutationFn: ({ clipId, title }: { clipId: string; title: string }) =>
      apiClient.updateClip(clipId, { title }),
    onSuccess: () => {
      // Both, because the name is what the export list renders a filename from and what the clip list
      // displays. A rename that is not announced leaves the other surfaces stale.
      queryClient.invalidateQueries({ queryKey: ['export-list'] });
      queryClient.invalidateQueries({ queryKey: ['clips'] });
    },
    onError: (err, vars) => {
      console.error('renameClip failed:', err);
      // Drop the optimistic value so the field shows what the server actually holds.
      const { [vars.clipId]: _dropped, ...rest } = namesFor;
      namesFor = rest;
    },
  }));

  /**
   * "Export this clip" runs on the SAME durable queue the batch does.
   *
   * It used to POST `/api/clips/:id/export`, which awaits the whole encode and only then answers:
   * no progress, no ETA, no cancel, and a button that looks inert for the length of an encode. The
   * queue is the mechanism that already reports all three, and it takes an explicit `clipIds` — one
   * clip is just the smallest batch. The endpoint stays for a client that wants the synchronous
   * result, but the UI no longer uses it.
   *
   * `clipIds` is EXPLICIT so this is a deliberate re-send: it bypasses the "skip what is already
   * exported" rule that export-all obeys, which is what the button means.
   */
  const exportMutation = createMutation(() => ({
    mutationFn: (input: { clipId: string }) =>
      apiClient.enqueueExports({
        profile: buildProfile(),
        outputDir: null,
        filename: null,
        clipIds: [input.clipId],
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ['export-queue'] });
      // The route clears the re-sent clip's `exported` mark, so the clip lists are stale.
      queryClient.invalidateQueries({ queryKey: ['clips'] });
    },
  }));

  function handleExport() {
    if (!selected) return;
    exportMutation.mutate({ clipId: selected.clip.id });
  }

  /** The profile the export controls currently describe. */
  function buildProfile(): ExportProfile {
    return {
      container: pair.container,
      videoCodec: codec,
      audioCodec,
      maxHeight: null,
      encoder: encoderChoice,
      encoderName: encoderEncoderName,
      options: {
        // Clamped on the way out as well: the export is the last place a value outside the useful
        // band can be caught, and an unencodable request is refused by name rather than degraded.
        quality: clampQuality(codec, quality),
        maxBitrateKbps: forceBitrate ? bitrateKbps : null,
      },
      aspectRatio,
      captions: {
        enabled: captionsEnabled,
        preset: captionPreset,
        position: captionPosition,
        fontSize: captionFontSize,
        backgroundOpacity: captionBgOpacity,
      },
      nameTemplate,
    };
  }

  /**
   * Export the WHOLE list: enqueue every item, then watch it run.
   *
   * This is the batch the owner asked for — "all items in the export list are enqueued" — and it is
   * durable, so a restart mid-batch resumes instead of losing the request.
   */
  const enqueueAllMutation = createMutation(() => ({
    // A RENDERED filename per clip, not the template.
    //
    // The server renders the template itself now (and that is the authority), but sending the raw
    // template here was a bug with a silent outcome: when the server trusted this value it wrote the
    // literal `{date}-{channel}-{name}-{ts}`, so every export in the batch got the SAME name and they
    // overwrote one another. The batch is per-clip, so the template cannot be resolved to one string
    // for all of them anyway — each clip's own facts produce its own name.
    // NO `filename`: the TEMPLATE travels in the profile and the server renders it per clip.
    //
    // This used to send the SELECTED clip's rendered name. The server treats an incoming `filename`
    // as a template (it has to — that is what the field means on the single-clip route), and a
    // rendered name has no tokens left, so it rendered VERBATIM for every clip in the batch: one
    // clip's name was stamped across the whole run, and the collision suffix `-2`/`-3` was the only
    // thing telling the files apart. `profile.nameTemplate` is per-clip by construction, so leaving
    // `filename` unset is what makes each item get its own name.
    mutationFn: () => apiClient.enqueueExports({
      profile: buildProfile(),
      outputDir: null,
      filename: null,
    }),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['export-queue'] });
      // The batch route clears every re-sent clip's `exported` mark, so the clip lists are stale.
      queryClient.invalidateQueries({ queryKey: ['clips'] });
      // Say WHY rows marked `exported` did not run, rather than letting them look broken.
      batchNote = (res.skipped ?? 0) > 0
        ? `Queued ${res.enqueued} — skipped ${res.skipped} already exported.`
        : null;
    },
  }));

  /** Stop the incomplete items and delete the partial artifacts they left. */
  const cancelAllMutation = createMutation(() => ({
    mutationFn: () => apiClient.cancelExports(),
    onSuccess: (res) => {
      queryClient.invalidateQueries({ queryKey: ['export-queue'] });
      cancelNote = res.deletedArtifacts > 0
        ? `Cancelled ${res.cancelled} — removed ${res.deletedArtifacts} partial file${res.deletedArtifacts === 1 ? '' : 's'}.`
        : `Cancelled ${res.cancelled}.`;
    },
  }));

  const removeMutation = createMutation(() => ({
    mutationFn: (clipId: string) => apiClient.removeFromExportList(clipId),
    onSuccess: () => {
      // BOTH caches. Removing a row clears the clip's `exported` mark on the server, so the clips
      // cache is now stale too — refetching only the list would leave the badge showing whatever it
      // held before the removal.
      queryClient.invalidateQueries({ queryKey: ['export-list'] });
      queryClient.invalidateQueries({ queryKey: ['clips'] });
    },
  }));

  let cancelNote = $state<string | null>(null);
  let batchNote = $state<string | null>(null);

  /** Elapsed / remaining as a compact clock, for the stats line. */
  function fmtDur(sec: number | null): string {
    if (sec === null || !Number.isFinite(sec) || sec < 0) return '--';
    const s = Math.round(sec);
    if (s < 60) return `${s}s`;
    const m = Math.floor(s / 60);
    const r = s % 60;
    if (m < 60) return `${m}m ${String(r).padStart(2, '0')}s`;
    return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
  }

  const batch = $derived(queue ?? null);
  const elapsedSec = $derived(
    batch?.startedAt ? Math.max(0, (Date.now() - new Date(batch.startedAt).getTime()) / 1000) : null,
  );
  const hasActive = $derived((batch?.counts.queued ?? 0) + (batch?.counts.running ?? 0) > 0);

  /**
   * The Format control. These ARE the encoder presets — each fixes a container, a video codec and the
   * legal audio codecs at once.
   *
   * Order is deliberate: the two MP4 entries first (the formats almost every consumer accepts), then
   * MKV H.264, then the two WebM entries. MKV sits third rather than last because it is the direct
   * sibling of the MP4 pair — same H.264 codec, a container that takes it without the MP4 wrapper —
   * so the H.264 family reads as one group instead of being split by the WebM pair. The order is
   * mirrored by `EXPORT_FORMATS` in `shared/types.ts`; `export-page.test.mjs` asserts the two agree.
   */
  const formats: { value: ExportFormat; label: string }[] = [
    { value: 'mp4_h264', label: 'MP4 H.264' },
    { value: 'mp4_h265', label: 'MP4 H.265' },
    { value: 'mkv_h264', label: 'MKV H.264' },
    { value: 'webm_vp9', label: 'WebM VP9' },
    { value: 'webm_av1', label: 'WebM AV1' },
  ];

  const ratios: { value: AspectRatio; label: string }[] = [
    { value: '16:9', label: '16:9' },
    { value: '9:16', label: '9:16' },
    { value: '1:1', label: '1:1' },
  ];

  function fmtTime(sec: number): string {
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    const s = Math.floor(sec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
</script>

<div class="flex h-full" use:fadeIn role="region" aria-label="Export">
  <!-- Left: THE EXPORT LIST (durable references the user chose on the Review page) -->
  <aside class="flex w-80 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface" aria-label="Clips queued for export">
    <h2 class="sticky top-0 z-10 border-b border-border bg-surface px-4 py-3 font-display text-sm font-medium text-ash uppercase tracking-wider">
      Export list · {entries.length}
    </h2>

    <!--
      The batch panel: a progress bar and its statistics, present as long as THIS batch has anything
      to report. It lives at the top of the list because that is what the user watches after pressing
      Export — and it shows TOTALS across the whole batch, so the bar does not restart at each file.

      It CLOSES when the batch finishes: a finished run leaving a 100% bar pinned above the list is
      the "progress container should close" complaint, and nothing is lost by closing it — each row
      below still carries its own `exported` / `failed` / `cancelled` state, and `counts.total` is
      zero once no item is pending, so the next export starts from zero rather than continuing this
      bar's percentage.
    -->
    {#if batch && batch.counts.total > 0}
      <div class="flex flex-col gap-2 border-b border-border bg-surface-2/40 px-4 py-3" aria-live="polite">
        <div class="flex items-center justify-between font-mono text-[11px] text-ash">
          <span class="uppercase tracking-wider">
            {#if hasActive}{batch.running ? 'Exporting' : 'Starting'}{:else}Batch{/if}
          </span>
          <span class="text-ink">{(batch.percent * 100).toFixed(0)}%</span>
        </div>

        <!-- The bar: batch completion, so it only ever advances. -->
        <div class="h-1.5 w-full overflow-hidden rounded-full bg-border" role="progressbar"
             aria-valuenow={Math.round(batch.percent * 100)} aria-valuemin="0" aria-valuemax="100">
          <div
            class="h-full rounded-full bg-accent transition-[width] duration-300 ease-out"
            style="width: {Math.max(batch.percent > 0 ? 2 : 0, batch.percent * 100)}%"
          ></div>
        </div>

        <!-- Statistics: read from the server's own counts, never re-counted in the browser. -->
        <div class="flex flex-wrap gap-x-3 gap-y-0.5 font-mono text-[10px] text-ash-dim">
          <span>{batch.counts.completed}/{batch.counts.total} done</span>
          {#if batch.counts.running > 0}<span class="text-accent">{batch.counts.running} running</span>{/if}
          {#if batch.counts.queued > 0}<span>{batch.counts.queued} queued</span>{/if}
          {#if batch.counts.failed > 0}<span class="text-error">{batch.counts.failed} failed</span>{/if}
          {#if batch.counts.cancelled > 0}<span>{batch.counts.cancelled} cancelled</span>{/if}
          {#if elapsedSec !== null && hasActive}<span>· {fmtDur(elapsedSec)} elapsed</span>{/if}
          {#if batch.etaSec !== null && hasActive && batch.counts.queued > 0}
            <span>· ~{fmtDur(batch.etaSec)} left</span>
          {/if}
        </div>

        <!--
          The item in flight, named and individually measured. The batch bar alone cannot say WHICH
          file is moving, and "it has been at 40% for two minutes" is only alarming or fine depending
          on that.
        -->
        {#if batch.running}
          {@const item = batch.items.find((i) => i.clipId === batch.running)}
          {#if item}
            <div class="flex flex-col gap-1">
              <div class="flex items-center justify-between font-mono text-[10px]">
                <span class="truncate text-ash-dim">{item.label}</span>
                <span class="text-ash-dim">{item.phase ?? 'working'} · {(item.percent * 100).toFixed(0)}%</span>
              </div>
              <div class="h-0.5 w-full overflow-hidden rounded-full bg-border">
                <div class="h-full rounded-full bg-ink/60 transition-[width] duration-300"
                     style="width: {(item.percent * 100).toFixed(1)}%"></div>
              </div>
            </div>
          {/if}
        {/if}

        <div class="flex items-center gap-2 pt-1">
          <button
            class="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-ash transition-colors hover:border-border-strong hover:text-ink disabled:cursor-not-allowed disabled:opacity-40"
            onclick={() => cancelAllMutation.mutate()}
            disabled={!hasActive || cancelAllMutation.isPending}
            title="Stop the unfinished exports and delete their partial files. Finished exports are kept."
          >
            Cancel unfinished
          </button>
          {#if cancelNote}<span class="font-mono text-[10px] text-ash-dim">{cancelNote}</span>{/if}
          {#if batchNote}<span class="font-mono text-[10px] text-ash-dim">{batchNote}</span>{/if}
        </div>
      </div>
    {/if}

    {#if entries.length === 0}
      <div class="flex flex-1 items-center justify-center p-6 text-center text-xs text-ash-dim">
        Nothing queued for export. Review a stream and press Export on a clip.
      </div>
    {:else}
      <div class="flex flex-col p-2">
        {#each acceptedClips as item (item.clipId)}
          {@const job = jobsByClip.get(item.clipId)}
          <div
            class="relative flex items-stretch rounded-md transition-colors
            {selected?.clip.id === item.clip.id ? 'bg-surface-2' : 'hover:bg-surface-2/50'}"
          >
            <button
              class="flex flex-1 flex-col gap-0.5 px-3 py-2 text-left"
              onclick={() => (selectedClipId = item.clip.id)}
            >
              {#if selected?.clip.id === item.clip.id}
                <span class="absolute left-0 top-1/2 h-6 w-0.5 -translate-y-1/2 rounded-full bg-accent"></span>
              {/if}
              <div class="flex items-center gap-2">
                <!--
                  The clip's name, with its OWN casing. This span used to carry `uppercase`, which made
                  every name render as caps: a clip called `take one TWO` displayed as `TAKE ONE TWO`,
                  so a case-sensitive name looked like it had been flattened. The stored value was
                  always right — only the CSS was lying.

                  Read through `nameOf` so a rename made in the Name field shows here immediately
                  rather than waiting for the round trip.
                -->
                <span class="font-mono text-[10px] text-accent">{nameOf(item.clip) || 'manual'}</span>
                <!-- The clip's own duration, to the RIGHT of the name, so the row says how long the
                     file it produces will be without opening the clip. -->
                <span class="font-mono text-[10px] text-ash-dim">
                  {Math.max(0, Math.round(item.clip.endTime - item.clip.startTime))}s
                </span>
                <!--
                  Per-item export state. A clip that already produced a file says so, and a failure
                  says WHY — the batch's aggregate counts cannot carry that.
                -->
                {#if job?.status === 'completed'}
                  <span class="ml-auto font-mono text-[10px] text-success">exported</span>
                {:else if job?.status === 'running'}
                  <span class="ml-auto font-mono text-[10px] text-accent">{(job.percent * 100).toFixed(0)}%</span>
                {:else if job?.status === 'queued'}
                  <span class="ml-auto font-mono text-[10px] text-ash-dim">#{job.position}</span>
                {:else if job?.status === 'failed'}
                  <span class="ml-auto font-mono text-[10px] text-error" title={job.error ?? ''}>failed</span>
                {:else if job?.status === 'cancelled'}
                  <span class="ml-auto font-mono text-[10px] text-ash-dim">cancelled</span>
                {/if}
              </div>
              <!--
                The FILENAME this item will produce, not the stream's name. It is the same renderer
                the Filename section previews, so editing the template is visible here immediately —
                and the stream it came from is the small line below rather than the headline.
              -->
              <span class="truncate font-mono text-xs text-ash" title={filenameForItem.get(item.clipId) ?? ''}>
                {filenameForItem.get(item.clipId) || item.clip.title || item.clip.axis || 'clip'}
              </span>
              <!--
                The VOD's name is deliberately NOT here: it is long, identical on every row, and
                repeated N times in a narrow column it wraps and pushes the times out of view. It is
                stated ONCE, at the top of the main content, which is where the preview page states it.
                A row carries only what differs between rows: the filename and the time range.
              -->
              <span class="truncate font-mono text-[10px] text-ash-dim">
                {fmtTime(item.clip.startTime)} → {fmtTime(item.clip.endTime)}
              </span>
            </button>
            <!--
              ALWAYS visible, never hover-revealed. A control that appears only under the pointer
              does not exist until you already know it is there — the row has to be found by
              hovering it to discover it can be removed. It stays dim so it does not compete with
              the filename, and brightens on hover.
            -->
            <button
              class="px-2 font-mono text-[11px] text-ash-dim transition-colors hover:text-error"
              onclick={() => removeMutation.mutate(item.clipId)}
              title="Remove from the export list (the clip itself is untouched)"
              aria-label="Remove from the export list"
            >
              ✕
            </button>
          </div>
        {/each}

        <!-- A reference whose clip is gone is REPORTED, not hidden: the count above still includes it. -->
        {#each unavailable as entry (entry.clipId)}
          <div class="flex items-center justify-between rounded-md px-3 py-2 font-mono text-[10px] text-error">
            <span class="truncate">{entry.streamTitle} · clip unavailable</span>
            <button
              class="px-1 text-ash-dim hover:text-ink"
              onclick={() => removeMutation.mutate(entry.clipId)}
              aria-label="Remove the unavailable entry"
            >✕</button>
          </div>
        {/each}
      </div>
    {/if}

    <!--
      Export all — at the BOTTOM OF THE LIST, because the list is what it acts on.

      It used to sit inside the configuration column beside "Export this clip", which put two
      differently-scoped actions next to each other with nothing saying which was which: one exports
      the clip you selected, the other queues every clip below. Placing it under the list makes the
      scope visual.
    -->
    <div class="mt-auto flex flex-col gap-1.5 border-t border-border p-3">
      <button
        class="flex w-full items-center justify-center gap-1.5 rounded-md bg-accent px-4 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-hover disabled:opacity-50"
        onclick={() => enqueueAllMutation.mutate()}
        disabled={entries.length === 0 || enqueueAllMutation.isPending || hasActive}
      >
        <Icon name="upload" size={15} />
        {#if enqueueAllMutation.isPending}Queueing...
        {:else if hasActive}Batch running
        {:else}Export all{/if}
      </button>
      <span class="text-center font-mono text-[10px] text-ash-dim">
        {entries.length} clip{entries.length === 1 ? '' : 's'} · queued one at a time · survives a restart
      </span>
      {#if enqueueAllMutation.isError}
        <span class="font-mono text-[10px] text-error">{enqueueAllMutation.error?.message ?? 'Could not queue'}</span>
      {/if}
    </div>
  </aside>

  <!-- Center: export configuration -->
  <div class="flex flex-1 flex-col overflow-y-auto p-6">
    <div class="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <!--
        The header row: the page's title on the left, and EXPORT THIS CLIP on the right — where the
        primary action for the page belongs, and where it is reachable without scrolling past the
        configuration. The clip's own label (name · start · duration) sits beside it as the button's
        subject, so the button says what it will act on.
      -->
      <!--
        The VOD's own name, stated ONCE at the top of the content — the same place the preview page
        states it. It used to repeat on every export-list row (below), where its length wrapped the
        row and pushed the clip's times out of view, and where it said nothing new: every clip in this
        page comes from one stream, so it is the same string N times.
      -->
      {#if selected?.streamTitle}
        <div class="flex items-baseline gap-2">
          <span class="font-display text-base font-medium text-ink" title={selected.streamTitle}>
            {selected.streamTitle}
          </span>
        </div>
      {/if}
      <div class="flex items-center justify-between gap-4">
        <h1 class="font-display text-xl font-medium">Export</h1>
        <div class="flex items-center gap-3">
          {#if selected}
            <div class="flex flex-col items-end gap-0.5">
              {#if exportMutation.isError}
                <span class="font-mono text-[10px] text-error">{exportMutation.error?.message ?? 'Could not queue'}</span>
              {:else if exportMutation.isSuccess}
                <!-- Queued, NOT exported: the encode has not run yet, and the per-row state in the
                     queue panel is what reports it. Claiming `exported` here was the same lie the
                     mark rules exist to prevent. -->
                <span class="font-mono text-[10px] text-accent">queued</span>
              {/if}
              <span class="font-mono text-[10px] text-ash-dim">
                {selected.clip.title ?? selected.clip.axis ?? 'manual'} · {(selected.clip.endTime - selected.clip.startTime).toFixed(0)}s
              </span>
            </div>
            <button
              class="flex shrink-0 items-center gap-1.5 rounded-md border border-border bg-surface-2 px-5 py-2.5 text-sm font-medium text-ink transition-colors hover:border-border-strong disabled:opacity-50"
              onclick={handleExport}
              disabled={exportMutation.isPending}
              title="Export this clip now, on its own"
            >
              <Icon name="upload" size={15} />
              {exportMutation.isPending ? 'Exporting...' : 'Export this clip'}
            </button>
          {/if}
        </div>
      </div>

      <!-- P2: the empty-state prompt remains, but the CONTROLS below no longer wait for a clip:
           a preset, a format and a filename are choices about the output, not about any one clip.
           Gating them on `selected` is what made the page look broken before a clip was picked. -->
      {#if !selected}
          <div class="flex flex-1 flex-col items-center justify-center gap-2 py-20 text-center">
            <Icon name="upload" size={32} class="text-ash-dim" />
            <p class="text-sm text-ash-dim">Select a clip on the left, or review a stream first.</p>
          </div>
      {/if}
        <!--
          The clip's NAME, above the filename it feeds.

          Above, not beside: the name is an INPUT to the filename template — `{name}` renders it — so
          reading top-to-bottom gives you cause then effect. It is the same free text the preview page
          edits, saved through the same route, and it is what identifies the clip in the library, so it
          is editable from both surfaces rather than only from the one that created it.

          The `title` attribute states the token with HTML ENTITIES (`&#123;name&#125;`), not as
          `{name}`. A bare `{name}` in an attribute is an EXPRESSION, and `name` resolved to the DOM
          global `window.name` — which type-checks, because that global exists in the browser types.
          SSR then threw `ReferenceError: name is not defined` on a FULL page load, so `GET /export`
          answered 500 and SvelteKit replaced the page's CONTENT while the app shell survived: the
          reported symptom, and the reason client-side navigation was unaffected (the server has no
          `window`). Only this attribute is entity-escaped; the `{#each FILENAME_TOKENS}` loop below
          renders the same tokens legitimately via template interpolation.
        -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Name</h2>
          <input
            type="text"
            bind:value={nameDraft}
            onblur={() => renameSelected(nameDraft)}
            onkeydown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
              if (e.key === 'Escape') nameDraft = selected ? nameOf(selected.clip) : '';
            }}
            class="rounded-md border border-border bg-surface-2 px-3 py-2 text-sm text-ink focus:border-accent focus:outline-none"
            placeholder="unnamed clip"
            spellcheck="false"
            autocapitalize="off"
            autocomplete="off"
            aria-label="Clip name"
            title="Clip name — Enter to save, Escape to cancel. Renders as &#123;name&#125; in the filename."
          />
        </section>
        <!-- Output naming (P1-2): template with live preview -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Filename</h2>
          <input
            type="text"
            bind:value={nameTemplate}
            oninput={() => presetTouched = true}
            class="rounded-md border border-border bg-surface-2 px-3 py-2 font-mono text-sm text-ink focus:border-accent focus:outline-none"
            aria-label="Filename template"
          />
          <div class="flex flex-wrap gap-x-3 gap-y-1 font-mono text-[10px] text-ash-dim">
            {#each FILENAME_TOKENS as token}
              <span>{`{${token}}`}</span>
            {/each}
          </div>
          <!-- The extension follows the SELECTED FORMAT: it was hardcoded `.mp4`, which labelled a
               WebM or MKV export as an MP4 in the preview while the file itself was named correctly. -->
          <p class="font-mono text-xs text-success">{sampleName}{extension}</p>
        </section>
        <!--
          PRESETS — a LIST CONTAINER, not badges.

          Badges implied the presets were tags on the settings rather than saved profiles the user can
          manage. A list with its own actions row makes the model explicit: pick one to apply it, and
          save / duplicate / delete live UNDERNEATH the thing they act on.

          Nothing here is clip-dependent — a preset describes how to encode, not what — so this is
          rendered whether or not a clip is selected (see the surrounding structure).
        -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Preset</h2>
          <div class="flex flex-col overflow-hidden rounded-md border border-border">
            {#if presetsQuery.isPending}
              <div class="px-3 py-2 font-mono text-[11px] text-ash-dim">Loading presets…</div>
            {:else if presets.length === 0}
              <!-- A database with no presets at all: the seeded ones are inserted by the container, so
                   this means they were never seeded. Say so rather than showing an empty box. -->
              <div class="px-3 py-2 font-mono text-[11px] text-error">
                No presets saved. Re-saving the app's defaults should restore them.
              </div>
            {:else}
              {#each presets as p (p.id)}
                <button
                  class="flex items-center justify-between gap-2 border-b border-border px-3 py-2 text-left
                  last:border-b-0 {activePresetId === p.id
                    ? 'bg-surface-2 text-accent'
                    : 'text-ash hover:bg-surface-2/50 hover:text-ink'}"
                  onclick={() => { presetTouched = false; applyPreset(p); }}
                >
                  <span class="flex items-center gap-2 truncate text-sm">
                    {#if activePresetId === p.id && !presetTouched}
                      <span class="h-1.5 w-1.5 shrink-0 rounded-full bg-accent"></span>
                    {:else}
                      <span class="h-1.5 w-1.5 shrink-0"></span>
                    {/if}
                    {p.name}
                  </span>
                  <span class="shrink-0 font-mono text-[10px] text-ash-dim">
                    {p.profile.videoCodec.toUpperCase()} · {p.profile.aspectRatio}
                    {#if p.origin === 'seeded'}<span class="text-ash-dim/70"> · built-in</span>{/if}
                  </span>
                </button>
              {/each}
            {/if}

            <!--
              The actions row, UNDER the list it acts on. `customized` belongs here rather than in the
              list because it describes the CONTROLS, not any one preset: an edited preset is no longer
              that preset.
            -->
            <div class="flex flex-wrap items-center gap-1.5 border-t border-border bg-surface-2/30 px-3 py-2">
              {#if presetTouched && activePreset}
                <span class="font-mono text-[10px] text-accent">
                  {activePreset.name} edited
                </span>
                <button
                  class="rounded-md border border-border px-2.5 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
                  onclick={revertToPreset}
                  title="Discard the edits and go back to the saved preset"
                >Revert</button>
              {/if}
              {#if showSavePreset}
                <div class="flex flex-1 items-center gap-1">
                  <input
                    class="w-40 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
                    placeholder="Preset name"
                    bind:value={presetName}
                    onkeydown={(e) => { if (e.key === 'Enter') savePreset(); if (e.key === 'Escape') showSavePreset = false; }}
                  />
                  <button
                    class="rounded-md border border-accent px-2.5 py-1 text-xs text-accent transition-colors hover:bg-accent hover:text-white disabled:opacity-40"
                    onclick={savePreset}
                    disabled={!presetName.trim()}
                  >Save</button>
                  <button
                    class="rounded-md border border-border px-2 py-1 text-xs text-ash-dim hover:text-ink"
                    onclick={() => (showSavePreset = false)}
                  >Cancel</button>
                </div>
              {:else}
                <button
                  class="rounded-md border border-border px-2.5 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
                  onclick={() => { presetName = activePreset ? `${activePreset.name} copy` : ''; showSavePreset = true; }}
                  title="Save the current settings as a new preset"
                >Save as…</button>
                {#if activePreset}
                  <button
                    class="rounded-md border border-border px-2.5 py-1 text-xs text-ash transition-colors hover:border-border-strong hover:text-ink"
                    onclick={duplicatePreset}
                    title="Save a copy of this preset"
                  >Duplicate</button>
                {/if}
                <!--
                  Delete is shown ONLY for presets the server says are the user's. The server refuses a
                  seeded delete independently (409), so this is the affordance, not the policy.
                -->
                {#if activePreset && activePreset.origin === 'user'}
                  <button
                    class="rounded-md border border-border px-2.5 py-1 text-xs text-ash-dim transition-colors hover:border-error hover:text-error"
                    onclick={() => deletePreset(activePreset!.id)}
                    title="Delete this preset"
                  >Delete</button>
                {/if}
              {/if}
              {#if presetError}
                <span class="font-mono text-[10px] text-error">{presetError}</span>
              {/if}
            </div>
          </div>
        </section>
        <div class="grid grid-cols-2 gap-6">
          <!-- Format & aspect -->
          <section class="flex flex-col gap-2">
            <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Format</h2>
            <div class="flex gap-2">
              {#each formats as f}
                <button
                  class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
                  {format === f.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => changeFormat(f.value)}
                >
                  {f.label}
                </button>
              {/each}
            </div>
            <div class="mt-2 flex gap-2">
              {#each ratios as r}
                <button
                  class="rounded-md border px-2.5 py-1.5 text-xs transition-colors
                  {aspectRatio === r.value ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => { aspectRatio = r.value; presetTouched = true; }}
                >
                  {r.label}
                </button>
              {/each}
            </div>
          </section>
        <!-- Captions -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Captions</h2>
          <div class="flex flex-col gap-2 rounded-md border border-border bg-surface p-3">
            <span class="flex items-center gap-2 font-mono text-xs text-ash">
              <input
                type="checkbox"
                checked={captionsEnabled}
                onchange={(e) => { captionsEnabled = e.currentTarget.checked; presetTouched = true; }}
                class="accent-accent"
              />
              Burn in captions
            </span>
            {#if captionsEnabled}
              <div class="ml-6 flex flex-wrap items-center gap-3">
                {#each ['bold-white', 'yellow', 'custom'] as style}
                  <button
                    class="rounded px-2 py-1 font-mono text-xs transition-colors
                    {captionPreset === style ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                    onclick={() => { captionPreset = style as CaptionStyle['preset']; presetTouched = true; }}
                  >
                    {style}
                  </button>
                {/each}
                <span class="text-ash-dim">·</span>
                {#each ['bottom', 'top'] as pos}
                  <button
                    class="rounded px-2 py-1 font-mono text-xs transition-colors
                    {captionPosition === pos ? 'text-accent' : 'text-ash-dim hover:text-ash'}"
                    onclick={() => { captionPosition = pos as CaptionStyle['position']; presetTouched = true; }}
                  >
                    {pos}
                  </button>
                {/each}
                <span class="text-ash-dim">·</span>
                <input type="range" min="24" max="96" bind:value={captionFontSize} class="w-24 accent-accent" oninput={() => presetTouched = true} />
                <span class="font-mono text-xs text-ash">{captionFontSize}px</span>
              </div>
            {/if}
          </div>
        </section>
        <!-- Crop preview (P0-9). Gated on a clip because the FRAME is clip-specific; every other
             section above is a choice about the output and does not wait for one. -->
        <section class="flex flex-col gap-2">
          <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Preview</h2>
          {#if selected}
            <div class="flex items-center justify-center rounded-md border border-border bg-foundation p-3">
              <div
                class="relative overflow-hidden rounded bg-surface-2"
                style="aspect-ratio: {aspectRatio.replace(':', '/')}; {aspectRatio === '16:9' ? 'width: 100%;' : 'height: 160px;'}"
              >
                <!--
                  The REAL frame, cropped the way the export will crop it. The thumbnail endpoint
                  extracts at the clip's own start second, so this is what the first frame of the
                  export looks like rather than a stand-in.
                -->
                {#if previewSrc && !previewFailed}
                  <img
                    src={previewSrc}
                    alt="Frame at the clip's start"
                    class="absolute inset-0 h-full w-full object-cover"
                    onerror={() => (previewFailed = true)}
                  />
                {:else}
                  <!-- Fallback only: the endpoint 404s when no source is readable, and the crop is
                       meaningless without the clip anyway. -->
                  <div class="absolute inset-0 flex items-center justify-center">
                    <Icon name="film" size={20} class="text-ash-dim" />
                  </div>
                {/if}
                {#if captionsEnabled}
                  <div
                    class="absolute inset-x-2 rounded-sm bg-black px-1 py-0.5 text-center font-mono text-[9px] text-white"
                    style="{captionPosition === 'bottom' ? 'bottom: 8%' : 'top: 8%'}; opacity: {0.4 + captionBgOpacity * 0.6}; font-size: {Math.max(8, captionFontSize / 6)}px"
                  >
                    caption preview
                  </div>
                {/if}
              </div>
            </div>
          {:else}
            <p class="font-mono text-[10px] text-ash-dim">Select a clip to preview its frame.</p>
          {/if}
        </section>
        <!--
          ENCODER — advanced. Quality, bitrate and the encoder itself are the settings most users
          never touch and the ones most likely to be misread (a CRF number means nothing without the
          band it lives in). Collapsed by default so the top-down order stays Filename, Preset,
          Format: what the file IS first, how it is written second.
        -->
        <section class="flex flex-col gap-2">
          <button
            class="flex items-center gap-2 self-start font-mono text-xs uppercase tracking-wider text-ash transition-colors hover:text-ink"
            onclick={() => (showAdvanced = !showAdvanced)}
            aria-expanded={showAdvanced}
          >
            <span class="inline-block transition-transform {showAdvanced ? 'rotate-90' : ''}">›</span>
            Advanced
            <span class="text-ash-dim normal-case">
              {codec.toUpperCase()} · {quality} · {encoderEncoderName ? encoderEncoderName : (encoderChoice === 'software' ? 'CPU' : 'auto')}
            </span>
          </button>
          {#if showAdvanced}
          <!--
            ENCODER SETTINGS — quality and bitrate, which are per codec because the scales differ.
            This block is what makes the choices visible rather than derived behind the user's back.
          -->
          <section class="flex flex-col gap-3 rounded-md border border-border bg-surface-2/30 p-4">
            <h2 class="font-mono text-xs uppercase tracking-wider text-ash">Encoder · {codec.toUpperCase()}</h2>

            <!--
              Encoder: the machine's OWN VERIFIED list, not a fixed CPU/GPU pair.
              The list is the host's (nvenc, AMD VAAPI, Intel QSV, software), each entry verified by a
              real encode, and labelled by vendor the way OBS labels them. `Default` is the measured
              per-codec choice, so the list never forces a decision on someone who has none.
            -->
            <div class="flex flex-wrap items-center gap-1.5">
              {#if encodersQuery.isPending}
                <span class="font-mono text-[10px] text-ash-dim">Detecting encoders…</span>
              {:else if encoderOptions.length === 0}
                <!-- The list came back empty: an ffmpeg without even a software encoder. Say so rather
                     than offering nothing and leaving the export unexplained. -->
                <span class="font-mono text-[10px] text-error">
                  No usable video encoder found on this machine — ffmpeg reported none.
                </span>
              {:else}
                <button
                  class="rounded-md border px-2.5 py-1 text-xs transition-colors
                  {encoderEncoderName === null ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                  onclick={() => { encoderEncoderName = null; presetTouched = true; }}
                  title="The measured default for this codec"
                >Default ({autoEncoder === 'software' ? 'CPU' : 'GPU'})</button>
                {#each encoderOptions as opt (opt.encoder)}
                  <button
                    class="rounded-md border px-2.5 py-1 text-xs transition-colors
                    {encoderEncoderName === opt.encoder ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                    onclick={() => {
                      encoderEncoderName = opt.encoder;
                      encoderChoice = opt.software ? 'software' : 'hardware';
                      presetTouched = true;
                    }}
                  >{opt.label}</button>
                {/each}
              {/if}
            </div>

            <!--
              Quality. The tier buttons are ONE-SHOT SETTERS, not a mode: each writes a quality AND the
              measured bitrate for it, then reads unselected again. Nothing here is highlighted, because
              nothing here is a current selection — the numbers below are the state.
            -->
            <div class="flex flex-col gap-1.5">
              <span class="font-mono text-[10px] uppercase tracking-wider text-ash-dim">Quality</span>
              <div class="flex flex-wrap items-center gap-2">
                {#each QUALITY_TIERS as tier (tier)}
                  <button
                    class="rounded-md border border-border px-2.5 py-1 text-xs capitalize text-ash transition-colors hover:border-border-strong hover:text-ink"
                    onclick={() => applyTier(tier as QualityTier)}
                    title="{Math.round(TIER_FRACTION[tier as QualityTier] * 100)}% of this codec's useful band — sets quality and bitrate"
                  >{tier}</button>
                {/each}
              </div>
              <!--
                The VALUE and its control on ONE line: the number input sits at the START of the bar so
                the two describe the same thing, and the band's useful range is the annotation beside
                them rather than a paragraph below. The old layout put the input in a row of its own and
                the text under the bar, which is what overflowed this container.
              -->
              <div class="flex items-center gap-2">
                <input
                  type="number"
                  class="w-16 shrink-0 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
                  bind:value={quality}
                  min={band.best}
                  max={band.worst}
                  oninput={onManualQuality}
                  aria-label="Quality value"
                />
                <input
                  type="range"
                  class="min-w-0 flex-1 accent-[var(--accent)]"
                  bind:value={quality}
                  min={band.best}
                  max={band.worst}
                  oninput={onManualQuality}
                  aria-label="Quality"
                />
                <span class="shrink-0 font-mono text-[10px] text-ash-dim">{band.best}…{band.worst}</span>
              </div>
            </div>

            <!--
              Force Bitrate. Off means the SOURCE video's own bitrate is used, which is only possible at
              all when the output format matches the source's codec — a transcode cannot reuse it, so in
              that case the toggle is hidden, force is ON, and the field is shown with a sensible value.
            -->
            <div class="flex flex-col gap-1.5">
              {#if sourceMatchesOutput}
                <label class="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={forceBitrate}
                    onchange={(e) => { forceBitrate = e.currentTarget.checked; presetTouched = true; }}
                  />
                  <span class="font-mono text-[10px] uppercase tracking-wider text-ash-dim">Force bitrate</span>
                </label>
              {:else}
                <!-- Hidden, not merely disabled: there is no "original bitrate" to fall back to when the
                     codec changes, so offering the toggle would offer a choice that does not exist. -->
                <span class="font-mono text-[10px] uppercase tracking-wider text-ash-dim">Force bitrate</span>
              {/if}
              {#if forceBitrate}
                <div class="flex items-center gap-2">
                  <input
                    type="number"
                    class="w-24 rounded-md border border-border bg-surface px-2 py-1 font-mono text-xs text-ink outline-none focus:border-accent"
                    bind:value={bitrateKbps}
                    min="200"
                    step="100"
                    oninput={() => (presetTouched = true)}
                    aria-label="Bitrate kbps"
                  />
                  <span class="font-mono text-[10px] text-ash-dim">kbps</span>
                  <button
                    class="rounded-md border border-border px-2 py-1 font-mono text-[10px] text-ash-dim hover:text-ink"
                    onclick={() => { bitrateKbps = sensibleBitrateKbps(codec, sourceWidth, sourceHeight, sourceFps); presetTouched = true; }}
                    title="A measured starting point for this codec at this resolution"
                  >suggest</button>
                </div>
              {:else}
                <span class="font-mono text-[10px] text-ash-dim">
                  {#if sourceMedia?.bitrateKbps}
                    {sourceMedia.bitrateKbps.toLocaleString()} kbps from the source
                  {:else}
                    from the source
                  {/if}
                </span>
              {/if}
            </div>

            <!--
              Audio codec. A RADIO, like the format and the encoder: its value IS the state.

              Only the codecs the CURRENT container can hold are offered, because the pairing is a
              property of the container and not a preference — MP4 takes AAC, WebM takes Opus or
              Vorbis, and offering an illegal pair would only produce a refusal at export time.
            -->
            <div class="flex flex-col gap-1.5">
              <span class="font-mono text-[10px] uppercase tracking-wider text-ash-dim">Audio</span>
              <div class="flex flex-wrap items-center gap-1.5">
                {#each audioOptions as a (a)}
                  <button
                    class="rounded-md border px-2.5 py-1 text-xs uppercase transition-colors
                    {audioCodec === a ? 'border-accent text-accent' : 'border-border text-ash hover:text-ink'}"
                    onclick={() => { audioCodec = a; presetTouched = true; }}
                    title={AUDIO_INFO[a].note}
                  >{AUDIO_INFO[a].label}</button>
                {/each}
              </div>
            </div>
          </section>
          {/if}
        </section>
        </div>
    </div>
  </div>
</div>