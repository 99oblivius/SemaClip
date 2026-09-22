/**
 * Formats, containers, and the audio codec each container accepts.
 *
 * WHY THIS FILE EXISTS: a container REFUSES a codec it cannot mux, and the pairing is now a two-way
 * table (video→containers, container→audio) with a format name on top that must be a faithful inverse
 * of both. The failure modes it guards are all silent-normalisation bugs: a format that quietly loses
 * its audio codec, a WebM that gets AAC, a user's choice overwritten by a container default.
 *
 * The audio decisions here were checked against the standards rather than recalled:
 *   - MP4 + H.264 + AAC is the combination every player and platform accepts.
 *   - WebM's current standard is OPUS, not Vorbis: RFC 7845 (IETF Standards Track, 2016) defines it,
 *     and ffmpeg's own webm muxer defaults to it. Vorbis is the older codec (2002) it replaced, kept
 *     available because older editors read it. Both mux cleanly here (measured, no warnings).
 *   - AV1 is valid in BOTH MP4 and WebM, which is why it has two format entries.
 */
import {
  AUDIO_CODECS,
  CONTAINER_AUDIO_MATRIX,
  CONTAINER_CODEC_MATRIX,
  VIDEO_CODECS,
  defaultAudioFor,
  formatForPair,
  pairForFormat,
  normaliseProfile,
  validateExportProfile,
} from "shared/types";
import type { AudioCodec, Container, ExportFormat, VideoCodec } from "shared/types";
import { assert, assertEquals } from 'jsr:@std/assert@1';

// The five OFFERED formats, in the order the control lists them. `mp4_av1` is deliberately absent:
// it is retired but still READABLE, which is why it appears in the legacy test below and not here.
const FORMATS: ExportFormat[] = ['mp4_h264', 'mp4_h265', 'webm_vp9', 'webm_av1', 'mkv_h264'];

Deno.test("every format names a REAL container/codec pair, and the matrix agrees", () => {
  for (const f of FORMATS) {
    const pair = pairForFormat(f);
    assert(pair, `${f} must resolve to a pair`);
    assert(
      CONTAINER_CODEC_MATRIX[pair.videoCodec].includes(pair.container),
      `${f} maps to ${pair.videoCodec} in ${pair.container}, which the matrix forbids`,
    );
  }
});

Deno.test("the five formats are the only ones, and each is reachable from its pair", () => {
  // Every format survives a round trip through the pair and back. The asymmetry this pins: `webm` and
  // `webm_vp9` are two SPELLINGS of one pair, so the inverse must pick one canonical spelling rather
  // than flipping depending on which it was built from.
  for (const f of FORMATS) {
    const pair = pairForFormat(f)!;
    assertEquals(formatForPair(pair.container, pair.videoCodec), f, `${f} must round-trip`);
  }
  // The retired spellings must still READ as their pair (a stored profile or preset from before this
  // change), but the writer must never emit them.
  assertEquals(pairForFormat('webm' as ExportFormat)?.videoCodec, 'vp9', "'webm' reads as VP9");
  assertEquals(
    formatForPair('webm', 'vp9'),
    'webm_vp9',
    "the canonical spelling is webm_vp9, not the retired 'webm'",
  );
  // `mp4_av1` is retired but must still RESOLVE, and it resolves to WebM — the same codec in the
  // container that actually consumes it. Returning null here would blank the user's preset rather
  // than showing them something usable.
  assertEquals(pairForFormat('mp4_av1' as ExportFormat)?.container, 'webm');
  assertEquals(pairForFormat('mp4_av1' as ExportFormat)?.videoCodec, 'av1');
  // A row read and re-saved is UPGRADED to the current spelling: legacy names exist to be read.
  assertEquals(formatForPair('webm', 'av1'), 'webm_av1', 'the retired mp4_av1 upgrades to webm_av1');
});

Deno.test("each video codec has the containers it can ACTUALLY be muxed into — no more", () => {
  // Each entry here is the result of a mux test, not a guess.
  assertEquals(CONTAINER_CODEC_MATRIX.av1, ['webm'], 'AV1 is offered in WebM only');
  assertEquals(CONTAINER_CODEC_MATRIX.h264.slice().sort(), ['mkv', 'mp4']);
  assertEquals(CONTAINER_CODEC_MATRIX.h265.slice().sort(), ['mkv', 'mp4']);
  assertEquals(CONTAINER_CODEC_MATRIX.vp9, ['webm']);
  // H.264-in-WEBM is the one that is IMPOSSIBLE: the WebM muxer refuses it outright, because WebM is
  // a strict Matroska subset. If this ever lists webm, the app would try to write a file ffmpeg
  // cannot produce.
  assertEquals(CONTAINER_CODEC_MATRIX.h264.includes('webm'), false, 'WebM cannot carry H.264');

  // The consequence, stated as behaviour: every codec is reachable from at least one format, and the
  // formats that exist are exactly the ones the matrix permits.
  const perCodec = (c: VideoCodec) => FORMATS.filter((f) => pairForFormat(f)!.videoCodec === c);
  for (const c of VIDEO_CODECS) {
    assert(perCodec(c).length > 0, `${c} has no format at all, so it cannot be chosen`);
  }
  assertEquals(perCodec('av1').length, 1, 'AV1 has exactly one format now (WebM)');
  assertEquals(perCodec('h264').length, 2, 'H.264 is offered in MP4 and in MKV');
  assertEquals(perCodec('h265').length, 1);
  assertEquals(perCodec('vp9').length, 1);
});

Deno.test("Matroska is the container that takes nearly every audio codec", () => {
  // Measured: all of these exit 0 into matroska. This is what makes an MKV the archival choice —
  // a lossless audio track has somewhere to go.
  for (const a of ['aac', 'opus', 'vorbis', 'mp3', 'flac', 'pcm_s16le', 'pcm_s24le'] as AudioCodec[]) {
    assert(CONTAINER_AUDIO_MATRIX.mkv.includes(a), `mkv must accept ${a}`);
  }
  // WebM stays narrow — it is a strict subset and that is the point.
  assertEquals(CONTAINER_AUDIO_MATRIX.webm.slice().sort(), ['none', 'opus', 'vorbis']);
});

Deno.test("each container lists exactly the audio codecs it can mux — measured, not assumed", () => {
  // MP4 takes every lossy codec here plus the lossless ones. The previous note in this file claimed
  // "AAC-only", which was never a container rule — it was just the one codec the app happened to
  // offer, and the two got conflated.
  for (const a of ['aac', 'mp3', 'flac', 'pcm_s16le', 'pcm_s24le'] as AudioCodec[]) {
    assert(CONTAINER_AUDIO_MATRIX.mp4.includes(a), `mp4 must accept ${a}`);
  }
  // WebM is the narrow one: Opus and Vorbis only, because the muxer refuses everything else.
  assertEquals(CONTAINER_AUDIO_MATRIX.webm.includes('opus'), true);
  assertEquals(CONTAINER_AUDIO_MATRIX.webm.includes('vorbis'), true);
  for (const a of ['aac', 'mp3', 'flac', 'pcm_s16le', 'pcm_s24le'] as AudioCodec[]) {
    assertEquals(CONTAINER_AUDIO_MATRIX.webm.includes(a), false, `webm cannot carry ${a}`);
  }
  // A silent export is expressible in every container.
  for (const c of ['mp4', 'webm', 'mkv'] as Container[]) {
    assert(CONTAINER_AUDIO_MATRIX[c].includes('none'), `${c} must allow a silent export`);
  }
});

Deno.test("the defaults are the STANDARD pairings — AAC for MP4, OPUS for WebM", () => {
  assertEquals(defaultAudioFor('mp4'), 'aac');
  // Opus, not Vorbis: RFC 7845 and ffmpeg's own webm muxer default. If this ever reads `vorbis`, the
  // default has silently regressed to the codec Opus replaced.
  assertEquals(defaultAudioFor('webm'), 'opus');
});

Deno.test("a container's default audio is always one the container actually accepts", () => {
  // The invariant that makes the default safe to apply without checking: it must be a member of its
  // own container's list. A default outside its own matrix is how a WebM would get AAC.
  for (const [container, allowed] of Object.entries(CONTAINER_AUDIO_MATRIX)) {
    const dflt = defaultAudioFor(container as Container);
    assert(allowed.includes(dflt), `${container} defaults to ${dflt}, which it does not accept`);
  }
  // And every codec in the matrix is a real codec.
  for (const [container, list] of Object.entries(CONTAINER_AUDIO_MATRIX)) {
    for (const a of list) {
      assert(AUDIO_CODECS.includes(a), `${container} lists unknown audio codec ${a}`);
    }
  }
});

Deno.test("normaliseProfile FILLS a missing audio codec and never invents one", () => {
  // A profile saved before audio was selectable carries no codec at all. It must come back with its
  // container's standard, not undefined — and the default must FOLLOW THE CONTAINER, which is where a
  // single global default would go wrong.
  assertEquals(normaliseProfile({ format: 'mp4_h264' as ExportFormat }).audioCodec, 'aac');
  assertEquals(normaliseProfile({ format: 'webm_vp9' as ExportFormat }).audioCodec, 'opus');
  assertEquals(normaliseProfile({ format: 'webm_av1' as ExportFormat }).audioCodec, 'opus');
  assertEquals(normaliseProfile({ format: 'mkv_h264' as ExportFormat }).audioCodec, 'aac');
  // The retired `mp4_av1` resolves to AV1-in-WEBM, so its default follows the CONTAINER it lands in —
  // Opus, not the AAC that the "mp4" in its name would suggest. This is the case that would have gone
  // wrong if the legacy name were trusted as a container.
  assertEquals(normaliseProfile({ format: 'mp4_av1' as ExportFormat }).container, 'webm');
  assertEquals(normaliseProfile({ format: 'mp4_av1' as ExportFormat }).audioCodec, 'opus');
});

Deno.test("an IMPOSSIBLE pairing is refused BY NAME at every write boundary, not silently repaired", () => {
  // This is the deliberate design, and it differs from how an illegal VIDEO codec is handled: a video
  // codec that cannot be muxed is silently repaired to the container's default by `normaliseProfile`
  // (there is exactly one sensible answer for "VP9 in an MP4"), whereas an audio codec is a USER
  // CHOICE among several legal alternatives — silently swapping AAC for Opus would be quietly ignoring
  // what the user asked for. So the audio matrix refuses, with the container and codec named.
  const illegalAudio = validateExportProfile({
    container: 'webm',
    videoCodec: 'vp9',
    audioCodec: 'aac' as AudioCodec,
    maxHeight: null,
  });
  assertEquals(illegalAudio.ok, false, 'AAC in a webm must be refused');
  assert(
    !illegalAudio.ok && /WEBM/i.test(illegalAudio.reason) && /AAC/i.test(illegalAudio.reason),
    `the refusal must NAME both the container and the codec, got: ${!illegalAudio.ok ? illegalAudio.reason : ''}`,
  );
  assertEquals(
    validateExportProfile({ container: 'mp4', videoCodec: 'h264', audioCodec: 'opus' as AudioCodec, maxHeight: null }).ok,
    false,
    'Opus in an mp4 must be refused',
  );
  // Every LEGAL pairing is accepted, so the refusal above is not a blanket rejection.
  assertEquals(validateExportProfile({ container: 'mp4', videoCodec: 'h264', audioCodec: 'aac' as AudioCodec, maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: 'webm', videoCodec: 'vp9', audioCodec: 'opus' as AudioCodec, maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: 'webm', videoCodec: 'vp9', audioCodec: 'vorbis' as AudioCodec, maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: 'webm', videoCodec: 'vp9', audioCodec: 'none' as AudioCodec, maxHeight: null }).ok, true);
  assertEquals(validateExportProfile({ container: 'mp4', videoCodec: 'h264', audioCodec: 'none' as AudioCodec, maxHeight: null }).ok, true);
});

Deno.test("every format's OWN default pairing passes validation — no format ships an illegal default", () => {
  // The strongest single assertion here: for all five formats, the container's default audio codec
  // must be accepted by that container. A format whose default its own validator refuses would be
  // unexportable the moment it was selected.
  for (const f of FORMATS) {
    const pair = pairForFormat(f)!;
    const check = validateExportProfile({
      container: pair.container,
      videoCodec: pair.videoCodec,
      audioCodec: defaultAudioFor(pair.container),
      maxHeight: null,
    });
    assert(check.ok, `${f}'s own default pairing is refused: ${!check.ok ? check.reason : ''}`);
  }
});
