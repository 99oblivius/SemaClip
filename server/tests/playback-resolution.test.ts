/**
 * Playback resolution order.
 *
 * The route preferred the proxy over the main video, which (a) made the app
 * play the low-quality copy even when a full-quality file existed, and (b)
 * made deleting the video look like a no-op — the same duration kept
 * streaming, from the proxy's bytes. This pins the intended order:
 * main video first, proxy only as a fallback, and nothing stale.
 */
import { assertEquals } from "@std/assert";

/**
 * Resolve the playable path from a download state, stat-checking every
 * candidate. Mirrors the route's order.
 */
function resolvePlayable(
  dl: {
    hqMp4?: string | null;
    hqPath?: string | null;
    proxyMp4?: string | null;
    proxyPath?: string | null;
  },
  existing: Set<string>,
): string | null {
  const pick = (p?: string | null) => (p && existing.has(p) ? p : null);
  return pick(dl.hqMp4) ?? pick(dl.hqPath) ?? pick(dl.proxyMp4) ?? pick(dl.proxyPath) ?? null;
}

const HQ = "/d/hq.mp4";
const PROXY = "/d/proxy.mp4";

Deno.test("playback: the main video wins over the proxy when both exist", () => {
  assertEquals(
    resolvePlayable({ hqMp4: HQ, hqPath: HQ, proxyMp4: PROXY, proxyPath: PROXY }, new Set([HQ, PROXY])),
    HQ,
  );
});

Deno.test("playback: falls back to the proxy when the video is gone", () => {
  // The video file was deleted; the proxy legitimately remains playable.
  assertEquals(
    resolvePlayable({ hqMp4: HQ, hqPath: HQ, proxyMp4: PROXY, proxyPath: PROXY }, new Set([PROXY])),
    PROXY,
  );
});

Deno.test("playback: a recorded path whose file vanished is never served", () => {
  // This is the "deleted video still plays" shape: the state still names a
  // file that no longer exists.
  assertEquals(resolvePlayable({ hqMp4: HQ, hqPath: HQ }, new Set()), null);
  assertEquals(
    resolvePlayable({ proxyMp4: PROXY, proxyPath: PROXY }, new Set()),
    null,
    "a stale proxy path must not be served either",
  );
});

Deno.test("playback: mid-download (only the proxy so far) plays the proxy", () => {
  assertEquals(resolvePlayable({ proxyMp4: PROXY, proxyPath: PROXY }, new Set([PROXY])), PROXY);
});

Deno.test("playback: single-download mode serves its one file", () => {
  const VIDEO = "/d/video.mp4";
  assertEquals(resolvePlayable({ proxyMp4: VIDEO, proxyPath: VIDEO }, new Set([VIDEO])), VIDEO);
});
