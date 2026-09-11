/**
 * The delete-ripple regression, at the level it was actually observed.
 *
 * Measured before this work, in two-file mode while HQ was still running:
 * `DELETE /video` reported success and removed `proxy.mp4` — because the
 * legacy "vodPath inside the artifact dir" rule matched, and vodPath pointed
 * at whichever artifact completed first (the proxy). The proxy row then lost
 * its bytes and playback broke. These tests pin the identification rule.
 */
import { assert, assertEquals } from "@std/assert";

/** The video paths deleteVideo is allowed to touch, given state + record. */
function videoDeleteTargets(opts: {
  hqPath: string | null;
  hqMp4: string | null;
  includeProxy: boolean;
  dir: string | null;
  vodPath: string;
  existing: Set<string>;
}): string[] {
  const targets = new Set<string>();
  if (opts.hqPath) targets.add(opts.hqPath);
  if (opts.hqMp4) targets.add(opts.hqMp4);
  if (opts.dir && opts.includeProxy) {
    for (const name of ["hq.mp4", "hq.fragments", "hq.ts", "hq.chunks"]) {
      const p = `${opts.dir}/${name}`;
      if (opts.existing.has(p)) targets.add(p);
    }
  }
  // Legacy rule applies ONLY when there is no separate proxy file.
  if (!opts.includeProxy && opts.vodPath) targets.add(opts.vodPath);
  return [...targets];
}

const DIR = "/cache/vods/s1";
const PROXY = `${DIR}/proxy.mp4`;
const HQ = `${DIR}/hq.mp4`;

Deno.test("deleteVideo: two-file mode never targets the proxy, even when vodPath points at it", () => {
  // The exact observed failure: vodPath was the proxy because the proxy
  // finished first. The old path-scan deleted it.
  const targets = videoDeleteTargets({
    hqPath: HQ,
    hqMp4: HQ,
    includeProxy: true,
    dir: DIR,
    vodPath: PROXY, // <- the trap
    existing: new Set([PROXY, HQ, `${DIR}/hq.fragments`]),
  });
  assertEquals(targets.includes(PROXY), false, "the proxy must never be a video-delete target");
  assert(targets.includes(HQ), "the video itself must be targeted");
  assert(targets.includes(`${DIR}/hq.fragments`), "its fragment index goes with it");
});

Deno.test("deleteVideo: single-download mode targets its ONE file (no proxy exists)", () => {
  const targets = videoDeleteTargets({
    hqPath: null,
    hqMp4: null,
    includeProxy: false,
    dir: DIR,
    vodPath: `${DIR}/video.mp4`,
    existing: new Set([`${DIR}/video.mp4`]),
  });
  assertEquals(targets, [`${DIR}/video.mp4`]);
});

Deno.test("deleteVideo: with no video file present it targets nothing (honest no-op)", () => {
  const targets = videoDeleteTargets({
    hqPath: null,
    hqMp4: null,
    includeProxy: true,
    dir: DIR,
    vodPath: PROXY,
    existing: new Set([PROXY]), // only the proxy exists
  });
  assertEquals(targets, [], "deleting a video that does not exist must not touch the proxy");
});
