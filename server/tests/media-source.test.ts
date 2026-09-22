/**
 * The playable-source rule: ONE ordering, and the folder-import case that makes it one.
 *
 * The reason this is a named function rather than a few lines inside a route handler is the
 * second consumer. The clip-thumbnail route needs the same file the player serves — a frame
 * drawn from a source the user is not watching is worse than no frame — and a
 * folder-imported project has media on disk with NO download artifacts, so the route's original
 * download-state-only rule reported "no media" for a project whose file was right there.
 */
import { assertEquals } from "@std/assert";
import { resolveMediaSource } from "@/application/view/download-view.ts";

const present = (paths: string[]) => (p: string) => paths.includes(p);

Deno.test("resolveMediaSource: the PROXY wins over the HQ file when both exist", async () => {
  // The proxy lands in a fraction of the time and scrubs cheaply, which is the whole reason it
  // is downloaded first. If HQ won here, review would decode the big file for no benefit.
  const got = await resolveMediaSource({
    proxyMp4: "/v/proxy.mp4",
    hqMp4: "/v/hq.mp4",
    present: present(["/v/proxy.mp4", "/v/hq.mp4"]),
  });
  assertEquals(got, "/v/proxy.mp4");
});

Deno.test("resolveMediaSource: an mp4 twin beats the raw .ts of the same part", async () => {
  // Chromium cannot demux raw MPEG-TS, so a .ts path is UNPLAYABLE — the twin is the playable
  // form of the same bytes. Ordering these wrong serves a file the browser renders as nothing.
  const got = await resolveMediaSource({
    proxyPath: "/v/proxy.ts",
    proxyMp4: "/v/proxy.mp4",
    present: present(["/v/proxy.ts", "/v/proxy.mp4"]),
  });
  assertEquals(got, "/v/proxy.mp4");
});

Deno.test("resolveMediaSource: a recorded-but-MISSING path is skipped, not returned", async () => {
  // Every candidate is stat-checked. Serving a path the DB remembers is exactly how "deleted"
  // media kept playing.
  const got = await resolveMediaSource({
    proxyMp4: "/v/gone.mp4",
    hqMp4: "/v/hq.mp4",
    present: present(["/v/hq.mp4"]),
  });
  assertEquals(got, "/v/hq.mp4");
});

Deno.test("resolveMediaSource: a FOLDER IMPORT resolves through vodPath (no download state)", async () => {
  // The case that forced this function to exist. A folder import records vodPath and
  // projectDir and has no download state whatsoever: every download-state field is undefined.
  const got = await resolveMediaSource({
    vodPath: "/media/imported/vod.mp4",
    present: present(["/media/imported/vod.mp4"]),
  });
  assertEquals(got, "/media/imported/vod.mp4");
});

Deno.test("resolveMediaSource: nothing on disk is an honest null, never a guess", async () => {
  const got = await resolveMediaSource({
    proxyMp4: "/v/proxy.mp4",
    vodPath: "/v/vod.mp4",
    present: () => false,
  });
  assertEquals(got, null);
});

Deno.test("resolveMediaSource: the HQ file is reachable when the proxy is gone", async () => {
  // Deleting the proxy must not make the project unplayable — and the export RENDER source is
  // the HQ file, so this ordering also keeps export working off a proxy-less project.
  const got = await resolveMediaSource({
    proxyMp4: "/v/proxy.mp4",
    proxyPath: "/v/proxy.ts",
    hqPath: "/v/hq.ts",
    present: present(["/v/hq.ts"]),
  });
  assertEquals(got, "/v/hq.ts");
});