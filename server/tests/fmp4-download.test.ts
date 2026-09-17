/**
 * fMP4 download integration — the real path: a real HLS playlist served
 * over HTTP, fetched, muxed by real ffmpeg, into a growing file.
 *
 * The synthetic parser tests prove the index maths; this proves the whole
 * chain produces a PLAYABLE file with correct fragment boundaries, which is
 * what the media route clamps to.
 */
import { assert, assertEquals } from "@std/assert";
import { downloadFmp4 } from "@/adapters/outbound/vod/fmp4-download.ts";

/** Build a real HLS VOD (TS segments + media playlist) with ffmpeg. */
async function makeHlsFixture(dir: string, seconds = 20): Promise<string> {
  const src = `${dir}/src.ts`;
  const gen = new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
           "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-g", "60",
           "-c:a", "aac", "-f", "mpegts", src, "-y"],
    stdout: "null", stderr: "null",
  });
  const genRes = await gen.output();
  assertEquals(genRes.success, true, "HLS fixture source generation failed");

  const seg = `${dir}/seg%03d.ts`;
  const split = new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-i", src, "-c", "copy", "-f", "segment",
           "-segment_time", "4", "-segment_format", "mpegts", seg, "-y"],
    stdout: "null", stderr: "null",
  });
  const splitRes = await split.output();
  assertEquals(splitRes.success, true, "HLS segmenting failed");

  // Media playlist describing the segments (ffmpeg also writes one, but
  // building it here keeps the fixture independent of muxer flags).
  const segs: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith("seg") && entry.name.endsWith(".ts")) segs.push(entry.name);
  }
  segs.sort();
  assert(segs.length > 1, "expected multiple segments");
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:5", "#EXT-X-MEDIA-SEQUENCE:0"];
  for (const s of segs) lines.push("#EXTINF:4.000000,", s);
  lines.push("#EXT-X-ENDLIST");
  await Deno.writeTextFile(`${dir}/index.m3u8`, lines.join("\n") + "\n");
  return `${dir}/index.m3u8`;
}

/** Serve `dir` over HTTP on an ephemeral port. */
function serve(dir: string): { url: string; stop: () => Promise<void> } {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const name = new URL(req.url).pathname.replace(/^\//, "");
    try {
      const body = await Deno.readFile(`${dir}/${name}`);
      const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
      return new Response(body, { headers: { "Content-Type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  const port = (server.addr as Deno.NetAddr).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
}

Deno.test("downloadFmp4: muxes a real HLS VOD into one playable fMP4", async () => {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-fmp4dl-" });
  try {
    const playlistPath = await makeHlsFixture(dir);
    const srv = serve(dir);
    const out = `${dir}/proxy.mp4`;
    const progress: number[] = [];
    try {
      const index = await downloadFmp4(`${srv.url}/${playlistPath.split("/").pop()}`, out, {
        ffmpegPath: "ffmpeg",
        onProgress: (p) => progress.push(p.percent),
      });
      // The index must describe the file ffmpeg actually produced.
      assert(index.headEnd > 0, "no init segment found");
      assert(index.fragments.length > 0, "no fragments indexed");
      // Every fragment span must be inside the file and non-overlapping.
      const size = (await Deno.stat(out)).size;
      let prevEnd = index.headEnd;
      for (const f of index.fragments) {
        assertEquals(f.start, prevEnd, "fragment spans are not contiguous");
        assert(f.end > f.start, "empty fragment span");
        assert(f.end <= size, `fragment end ${f.end} past file size ${size}`);
        prevEnd = f.end;
      }
      // Playable: ffprobe must read real duration from the growing file.
      const probe = new Deno.Command("ffprobe", {
        args: ["-v", "quiet", "-print_format", "json", "-show_format", out],
        stdout: "piped", stderr: "null",
      });
      const probeRes = await probe.output();
      const info = JSON.parse(new TextDecoder().decode(probeRes.stdout));
      const duration = parseFloat(info.format?.duration ?? "0");
      assert(duration > 15, `ffprobe read duration ${duration}, expected ~20s`);
      // Progress must be monotonic and reach ~1.
      for (let i = 1; i < progress.length; i++) {
        assert(progress[i]! >= progress[i - 1]! - 1e-9, "progress went backwards");
      }
      assert(progress[progress.length - 1]! > 0.95, `final progress ${progress[progress.length - 1]}`);
    } finally {
      await srv.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

Deno.test("downloadFmp4: cancel keeps a partial file with only COMPLETE fragments", async () => {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-fmp4cancel-" });
  try {
    const playlistPath = await makeHlsFixture(dir, 60);
    const srv = serve(dir);
    const out = `${dir}/proxy.mp4`;
    const controller = new AbortController();
    const spans: { start: number; end: number }[] = [];
    try {
      const dl = downloadFmp4(`${srv.url}/${playlistPath.split("/").pop()}`, out, {
        signal: controller.signal,
        ffmpegPath: "ffmpeg",
        onProgress: (p) => {
          if (p.percent > 0.2) controller.abort();
        },
        onFragment: (s) => spans.push(s),
      });
      let threw = false;
      try {
        await dl;
      } catch {
        threw = true;
      }
      assertEquals(threw, true, "aborted download resolved instead of throwing");
      assert(spans.length > 0, "no fragments completed before cancel");

      // Every span reported must be a complete, contiguous, in-file fragment.
      const size = (await Deno.stat(out)).size;
      assert(size > 0, "partial file was not kept");
      let prevEnd: number | null = null;
      for (const s of spans) {
        assert(s.end > s.start, "empty fragment span");
        assert(s.end <= size, `reported fragment end ${s.end} past partial file size ${size}`);
        if (prevEnd !== null) assertEquals(s.start, prevEnd, "reported spans not contiguous");
        prevEnd = s.end;
      }
      // The partial file's own head is complete (moov present) — that is
      // what makes a cancelled download resumable rather than garbage.
      const head = new Uint8Array(await Deno.readFile(out));
      const moovAt = (() => {
        const needle = new TextEncoder().encode("moov");
        for (let i = 0; i + 4 <= head.length; i++) {
          if (head[i] === needle[0] && head[i + 1] === needle[1] &&
              head[i + 2] === needle[2] && head[i + 3] === needle[3]) return i;
        }
        return -1;
      })();
      assert(moovAt > 0, "partial file has no moov init segment");
    } finally {
      await srv.stop();
    }
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
