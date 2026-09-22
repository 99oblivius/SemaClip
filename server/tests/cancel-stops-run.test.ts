/**
 * Cancelling a download must STOP it, and a cancel must not come back from the dead.
 *
 * ── WHAT THE OWNER REPORTED ───────────────────────────────────────────────────────────────────
 * "Cancelling a download deletes the proxy and chat as well and does not actually stop
 * downloading — the backend still shows progress and chunks being written without ever stopping
 * and the `.fragment` file growing. Even deleting the project doesn't stop the downloading."
 *
 * ── TWO DEFECTS ───────────────────────────────────────────────────────────────────────────────
 * 1. "Cancel" is wired to `DELETE /download`, which SWEEPS the artifact directory. So the partial
 *    download is destroyed — not what a Cancel may do. Cancel means stop; discard means delete.
 * 2. The reason it looked like nothing stopped: `deleteDownload` resets the state at T, but the
 *    aborted run is still unwinding and its own `finalize()` writes the RUN's state at T+delta,
 *    resurrecting `phase`, the part counters and the paths just cleared. Then
 *    `markRunLive(id, false)` drops the RAM copy, so the next read comes off DISK and serves the
 *    resurrected state — progress that "never stops" arriving.
 *
 * ── WHY THE EXISTING TESTS MISSED IT ──────────────────────────────────────────────────────────
 * `cancel-download.test.ts` covers the per-piece path in isolation; the whole-download path had
 * no test that aborted a run and then read the state back. Two probes here, deliberately separate,
 * because they answer different questions:
 *   A. Does an abort actually stop the WRITES? (real ffmpeg, real throttled HTTP, measured size)
 *   B. Does the cancelled run write its state back over the reset? (ordering, at the orchestrator)
 */
import { assert, assertEquals } from "@std/assert";
import { downloadFmp4 } from "@/adapters/outbound/vod/fmp4-download.ts";
import { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";

/** Real media, then segmented — the fixture the fmp4 downloader actually consumes. */
async function makeHlsFixture(dir: string, seconds = 240): Promise<string> {
  const src = `${dir}/src.ts`;
  const gen = new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-f", "lavfi", "-i", "testsrc2=size=320x180:rate=30",
           "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000",
           "-t", String(seconds), "-c:v", "libx264", "-preset", "ultrafast", "-g", "60",
           "-c:a", "aac", "-f", "mpegts", src, "-y"],
    stdout: "null", stderr: "null",
  });
  assertEquals((await gen.output()).success, true, "fixture source failed");

  const split = new Deno.Command("ffmpeg", {
    args: ["-v", "error", "-i", src, "-c", "copy", "-f", "segment",
           "-segment_time", "2", "-segment_format", "mpegts", `${dir}/seg%04d.ts`, "-y"],
    stdout: "null", stderr: "null",
  });
  assertEquals((await split.output()).success, true, "fixture segmenting failed");

  const segs: string[] = [];
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name.startsWith("seg") && entry.name.endsWith(".ts")) segs.push(entry.name);
  }
  segs.sort();
  assert(segs.length > 5, `expected several segments, got ${segs.length}`);
  const lines = ["#EXTM3U", "#EXT-X-VERSION:3", "#EXT-X-TARGETDURATION:4", "#EXT-X-MEDIA-SEQUENCE:0"];
  for (const s of segs) lines.push("#EXTINF:2.000000,", s);
  lines.push("#EXT-X-ENDLIST");
  await Deno.writeTextFile(`${dir}/index.m3u8`, lines.join("\n") + "\n");
  return `${dir}/index.m3u8`;
}

/**
 * Serve the fixture at a THROTTLED rate.
 *
 * Throttling is load-bearing: the probe is only meaningful while the transfer is STILL RUNNING
 * when the abort lands. A local unthrottled server finishes before the abort can arrive, which is
 * how a test like this passes against broken code.
 */
function serveSlow(dir: string, bytesPerSec = 30_000): { url: string; stop: () => Promise<void> } {
  const server = Deno.serve({ port: 0, hostname: "127.0.0.1", onListen: () => {} }, async (req) => {
    const name = new URL(req.url).pathname.replace(/^\//, "");
    try {
      const body = await Deno.readFile(`${dir}/${name}`);
      const type = name.endsWith(".m3u8") ? "application/vnd.apple.mpegurl" : "video/mp2t";
      if (name.endsWith(".m3u8")) return new Response(body, { headers: { "Content-Type": type } });
      const chunk = Math.max(1024, Math.floor(bytesPerSec / 10));
      // The drip MUST stop when the client goes away. Without a cancel handler the timer keeps
      // enqueuing into a closed controller, which throws an uncaught TypeError and takes the whole
      // test module down — a harness fault that masquerades as a failure of the code under test.
      const stream = new ReadableStream({
        start(controller) {
          let off = 0;
          let timer: ReturnType<typeof setTimeout> | undefined;
          let stopped = false;
          const stop = () => {
            stopped = true;
            if (timer !== undefined) clearTimeout(timer);
          };
          const tick = () => {
            if (stopped || req.signal.aborted) return stop();
            if (off >= body.length) {
              try {
                controller.close();
              } catch { /* already closed */ }
              return;
            }
            try {
              controller.enqueue(body.subarray(off, Math.min(off + chunk, body.length)));
            } catch {
              return stop();
            }
            off += chunk;
            timer = setTimeout(tick, 100);
          };
          req.signal.addEventListener("abort", stop, { once: true });
          tick();
        },
        cancel() {
          // Called when the consumer cancels: the flag above is set by the abort listener.
        },
      });
      return new Response(stream, { headers: { "Content-Type": type } });
    } catch {
      return new Response("not found", { status: 404 });
    }
  });
  const port = (server.addr as Deno.NetAddr).port;
  return { url: `http://127.0.0.1:${port}`, stop: () => server.shutdown() };
}

const sizeOf = (p: string) => Deno.stat(p).then((s) => s.size).catch(() => 0);

// ── PROBE A: the abort must stop the WRITES ──────────────────────────────────────────────────
Deno.test("A. an aborted fmp4 download STOPS writing — the file does not keep growing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-abortwrite-" });
  const srv = serveSlow(dir);
  try {
    const playlistName = (await makeHlsFixture(dir)).split("/").pop()!;
    const out = `${dir}/proxy.mp4`;
    const controller = new AbortController();
    let bytesAtAbort = 0;

    const dl = downloadFmp4(`${srv.url}/${playlistName}`, out, {
      signal: controller.signal,
      ffmpegPath: "ffmpeg",
      onProgress: (p) => {
        // Abort once the muxer is genuinely producing, not on the first callback.
        if (p.bytes > 200_000 && !controller.signal.aborted) {
          bytesAtAbort = p.bytes;
          controller.abort();
        }
      },
    });

    let threw = false;
    try {
      await dl;
    } catch {
      threw = true;
    }
    assertEquals(threw, true, "an aborted download RESOLVED instead of throwing");

    // THE ASSERTION THAT MATTERS: the .mp4 must be FROZEN. Sampling twice catches a writer that
    // is still draining ffmpeg's stdout into the file.
    const afterAbort = await sizeOf(out);
    await new Promise((r) => setTimeout(r, 2000));
    const settled = await sizeOf(out);
    assertEquals(
      settled,
      afterAbort,
      `the file KEPT GROWING after the abort (${bytesAtAbort} reported → ${afterAbort} → ${settled}). ` +
        "This is the owner's 'chunks being written without ever stopping'.",
    );
    assert(afterAbort > 0, "no partial file was kept at all (cancel may not discard the partial)");
  } finally {
    await srv.stop();
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});

// ── PROBE B: the cancelled run must not resurrect its state over a reset ──────────────────────
function harness() {
  const store = new Map<string, string>();
  const orch = new DownloadOrchestrator(
    {
      get: (_id: string, key: string) => Promise.resolve(store.get(key) ?? null),
      set: (_id: string, key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
    } as never,
    { ffmpeg: "ffmpeg", ffprobe: "ffprobe" } as never,
    null,
  );
  return { orch, store };
}

Deno.test("B. a cancelled run must NOT write its state back over the reset", async () => {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-abortstate-" });
  try {
    const { orch, store } = harness();
    const controller = new AbortController();

    // The slow runner stands in for `downloadFmp4`, honouring the same contract: keep writing
    // until the signal aborts, then throw without discarding the partial file. The defect under
    // test is the ORDERING of the reset against the run's unwind, which is independent of ffmpeg.
    let wroteBytes = 0;
    // `ImportStream.runProgressive` marks the run live around this call, and the marker is
    // LOAD-BEARING: without it `reconcile()` treats the run's own "running" phase as an orphan
    // from a crashed server and rewrites it to `failed: interrupted (server restart)`. The first
    // version of this probe omitted it and the run was killed off by its own reconciler.
    orch.markRunLive("s1", true);
    orch.net.chat = () => Promise.resolve(0);
    // The quality ladder this VOD would resolve to. Stubbed so the run proceeds to the fmp4
    // runner without reaching Twitch's usher.
    orch.net.qualities = () =>
      Promise.resolve([
        { name: "720p60", width: 1280, height: 720, fps: 60, bandwidth: 3_000_000, playlistUrl: "http://127.0.0.1/720.m3u8" },
      ]);
    orch.net.fmp4 = async (_url, destPath, o) => {
      const f = await Deno.open(destPath, { create: true, write: true, append: true });
      try {
        for (let i = 0; i < 400; i++) {
          if (o.signal?.aborted) throw new DOMException("Aborted", "AbortError");
          await f.write(new Uint8Array(4096));
          wroteBytes += 4096;
          o.onProgress({ downloadedSec: i * 0.5, totalSec: 200, bytes: wroteBytes, percent: i / 400 });
          await new Promise((r) => setTimeout(r, 10));
        }
      } finally {
        try {
          f.close();
        } catch { /* already closed */ }
      }
      return null;
    };

    const runPromise = orch.run({
      streamId: "s1",
      sourceUrl: "https://www.twitch.tv/videos/1",
      destDir: dir,
      slug: "proj",
      proxyHeightCap: 540,
      maxQualityHeight: null,
      includeProxy: false,
      signal: controller.signal,
    }).catch((err) => err as Error);

    // Bounded poll on the SIGNAL: wait for real progress before cancelling.
    const deadline = Date.now() + 30_000;
    let progressed = false;
    let lastSeen = "";
    while (Date.now() < deadline) {
      const st = await orch.getState("s1");
      lastSeen = `${st.phase} ${JSON.stringify(st.parts.map((p) => [p.kind, p.status, p.downloadedBytes, p.error]))}`;
      if (st.parts.some((p) => p.status === "running" && p.downloadedBytes > 0)) {
        progressed = true;
        break;
      }
      if (st.parts.some((p) => p.status === "failed")) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    assert(progressed, `the run never reported progress (last: ${lastSeen})`);

    // The delete happens WHILE the run is unwinding — exactly the real race.
    controller.abort();
    const settled = await orch.getState("s1");
    const idle = {
      ...settled,
      phase: "idle" as const,
      parts: [],
      overall: { percent: 0, etaSec: null },
      proxyPath: null,
      proxyMp4: null,
      hqPath: null,
      hqMp4: null,
      proxyFrontierSec: 0,
      videoFrontierSec: 0,
      chatPath: null,
      chatCount: 0,
    };
    await orch.setState("s1", idle);
    orch.markRunLive("s1", false); // drops the RAM copy: the next read comes off disk

    // Let the run's own finalize land, then read as the UI's next poll would.
    await runPromise;
    await new Promise((r) => setTimeout(r, 500));

    const afterReset = await orch.getState("s1");
    assertEquals(
      afterReset.phase,
      "idle",
      "the cancelled run WROTE ITS STATE BACK OVER the reset — which is how a cancelled download " +
        `reported progress again on the next read (parts: ${JSON.stringify(afterReset.parts.map((p) => [p.kind, p.status]))})`,
    );
    assertEquals(afterReset.parts.length, 0, "the reset was resurrected together with its counters");
    assertEquals(afterReset.proxyPath, null, "a cleared path came back");
    assert(
      (store.get("download_state") ?? "").includes('"idle"'),
      "the PERSISTED state is not idle, so the next read off disk resurrects the run",
    );
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
});
