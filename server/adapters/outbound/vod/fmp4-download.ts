/**
 * Streaming fMP4 download of an HLS playlist.
 *
 * Fetched chunks pipe into a long-lived ffmpeg (`-c copy -bsf:a
 * aac_adtstoasc -movflags frag_keyframe+empty_moov+default_base_moof`) whose
 * stdout is the growing media file. A tee between ffmpeg and the file feeds
 * `Fmp4BoxParser`, so the fragment index is built from the bytes actually
 * written — no second pass, no remux, no twin.
 *
 * Why a long-lived ffmpeg rather than one process per chunk: the muxer owns
 * the `moov` init segment and the fragment sequence numbers, so restarting
 * it per chunk would emit a new init segment into the middle of the file.
 *
 * Cancel is honest: the ffmpeg child is killed, its partial output is kept
 * (resume re-muxes from the last complete fragment), and the error propagates.
 */
import { Fmp4BoxParser, serializeIndex, type FragmentIndex, type FragmentSpan } from "./fmp4.ts";
import { spawnChild } from "@/adapters/outbound/process/spawn.ts";
import { fetchWithTimeout, MEDIA_TIMEOUT_MS, CHUNK_TIMEOUT_MS } from "@/adapters/outbound/net/fetch-timeout.ts";

export interface Fmp4DownloadProgress {
  downloadedSec: number;
  totalSec: number;
  bytes: number;
  percent: number;
}

export interface Fmp4DownloadOptions {
  onProgress: (p: Fmp4DownloadProgress) => void;
  /** Fired for each completed fragment with its byte span. */
  onFragment?: ((span: FragmentSpan) => void) | undefined;
  signal?: AbortSignal | undefined;
  lookahead?: number;
  /** Resume: seconds already muxed into the output file. Chunks fully below
   *  this point are skipped. */
  resumeSec?: number;
  /** Resolved by resolveToolPaths — never a bare name in a packaged build. */
  ffmpegPath: string;
  /**
   * Sidecar path for the fragment index. Written INCREMENTALLY as fragments
   * complete — the media route reads it to clamp Range responses to a
   * complete fragment, so a stale/absent file means mid-download playback
   * is served past the frontier and dies with PIPELINE_ERROR_DECODE.
   */
  indexPath?: string | undefined;
}

const CHUNK_RETRY_ATTEMPTS = 6;

async function fetchWithRetry(url: string, signal?: AbortSignal, label = ""): Promise<Response> {
  let lastErr: unknown = null;
  const host = (() => {
    try { return new URL(url).host; } catch { return "?"; }
  })();
  for (let attempt = 0; attempt < CHUNK_RETRY_ATTEMPTS; attempt++) {
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    const t0 = performance.now();
    try {
      const res = await fetchWithTimeout(url, signal ? { signal } : {}, CHUNK_TIMEOUT_MS);
      if (res.ok) {
        if (attempt > 0) {
          console.log(`[fmp4] chunk ${label} ok on attempt ${attempt + 1} (${host})`);
        }
        return res;
      }
      lastErr = new Error(`chunk fetch ${res.status}: ${url}`);
      // The single most useful line for a CDN refusal: WHICH status, and the host.
      console.warn(`[fmp4] chunk ${label} HTTP ${res.status} from ${host} — ${url.slice(0, 120)}`);
      // 4xx other than 429 will not heal — fail fast.
      if (res.status < 500 && res.status !== 429) throw lastErr;
    } catch (err) {
      if (signal?.aborted) throw err;
      lastErr = err;
      const ms = Math.round(performance.now() - t0);
      // Named, timed, and attributed: a stall with no line is what made this look frozen.
      console.warn(
        `[fmp4] chunk ${label} attempt ${attempt + 1}/${CHUNK_RETRY_ATTEMPTS} failed after ${ms}ms ` +
          `(${err instanceof Error ? err.name : "?"}: ${err instanceof Error ? err.message : err})`,
      );
    }
    const backoffMs = Math.min(32_000, 1000 * 2 ** attempt);
    await new Promise((r) => setTimeout(r, backoffMs));
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

function parseMediaPlaylist(text: string, base: string): { url: string; durationSec: number }[] {
  const chunks: { url: string; durationSec: number }[] = [];
  let pendingDuration: number | null = null;
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.slice(8).split(",")[0] ?? "");
      pendingDuration = Number.isFinite(dur) ? dur : null;
    } else if (line !== "" && !line.startsWith("#") && pendingDuration !== null) {
      const url = line.startsWith("http") ? line : new URL(line, base).href;
      chunks.push({ url, durationSec: pendingDuration });
      pendingDuration = null;
    }
  }
  return chunks;
}

/**
 * Downloads `playlistUrl` into `destPath` as a growing fragmented MP4.
 * Resolves with the fragment index when the whole playlist is muxed.
 */
export async function downloadFmp4(
  playlistUrl: string,
  destPath: string,
  opts: Fmp4DownloadOptions,
): Promise<FragmentIndex> {
  const playlistRes = await fetchWithTimeout(playlistUrl);
  if (!playlistRes.ok) throw new Error(`playlist fetch ${playlistRes.status}: ${playlistUrl}`);
  const chunks = parseMediaPlaylist(await playlistRes.text(), playlistUrl);
  if (chunks.length === 0) throw new Error("Media playlist has no chunks");
  console.log(`[fmp4] playlist ok: ${chunks.length} chunks, first=${chunks[0]!.url}`);

  const totalSec = chunks.reduce((s, c) => s + c.durationSec, 0);
  const resumeSec = Math.max(0, opts.resumeSec ?? 0);
  // First chunk not fully covered by the resumed prefix. The muxer re-emits
  // from the next fragment boundary, so a straddling chunk re-downloads.
  let skippedSec = 0;
  let firstIndex = 0;
  while (firstIndex < chunks.length && skippedSec + chunks[firstIndex]!.durationSec <= resumeSec + 1e-6) {
    skippedSec += chunks[firstIndex]!.durationSec;
    firstIndex++;
  }

  // The init segment is written once, at the start; on resume the file
  // already holds it plus fragments, so ffmpeg must APPEND its fragments
  // after the existing ones. A fresh muxer cannot do that — so a resume
  // re-muxes the whole file from the first fragment (see `resume` note in
  // references/growing-media-formats.md): correctness over cleverness.
  const resuming = firstIndex > 0 && resumeSec > 0;
  const dest = await Deno.open(destPath, {
    write: true,
    create: true,
    append: false,
    truncate: true,
  });

  const parser = new Fmp4BoxParser();
  parser.onFragment = opts.onFragment;
  let bytes = 0;
  let downloadedSec = 0;
  let lastReportAt = 0;

  // Incremental index sidecar. Rewritten atomically (tmp + rename) on each
  // new fragment so the media route never reads a half-written index.
  const indexWriter = opts.indexPath
    ? (() => {
      const path = opts.indexPath!;
      const tmp = `${path}.tmp`;
      let pending = false;
      const flush = async () => {
        if (pending) return;
        pending = true;
        try {
          await Deno.writeTextFile(tmp, serializeIndex(parser.index));
          await Deno.rename(tmp, path);
        } catch {
          // Best-effort: a missing index degrades clamping, never the download.
        } finally {
          pending = false;
        }
      };
      return { flush };
    })()
    : null;
  parser.onFragment = (span) => {
    opts.onFragment?.(span);
    void indexWriter?.flush();
  };

  console.log(`[fmp4] spawning ffmpeg: ${opts.ffmpegPath} dest=${destPath}`);
  const ffmpeg = spawnChild(opts.ffmpegPath, {
    args: [
      "-hide_banner", "-loglevel", "error",
      "-f", "mpegts", "-i", "pipe:0",
      "-c", "copy",
      "-bsf:a", "aac_adtstoasc",
      "-movflags", "+frag_keyframe+empty_moov+default_base_moof",
      "-f", "mp4", "pipe:1",
    ],
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  // Drain ffmpeg stderr so a mux failure is visible instead of hanging.
  let stderrTail = "";
  const stderrDone = (async () => {
    const dec = new TextDecoder();
    if (!ffmpeg.stderr) return;
    for await (const part of ffmpeg.stderr) {
      const text = dec.decode(part, { stream: true });
      stderrTail = (stderrTail + text).slice(-2000);
      // `-loglevel error` is quiet while a stall is happening, so anything ffmpeg says
      // is signal — previously it was buffered and only shown if the run FAILED, which
      // meant a hang reported nothing at all.
      const line = text.trim();
      if (line) console.log(`[fmp4] ffmpeg stderr: ${line.slice(0, 300)}`);
    }
  })();

  // The freeze was isolated to the gap between "spawning ffmpeg" and "first muxed
  // bytes", which is exactly where chunk fetching happens — so name every step of it.
  let firstWriteLogged = false;
  const writeChunk = async (data: Uint8Array): Promise<void> => {
    // stdin is piped by construction above; the guard makes that explicit rather
    // than an unchecked assertion.
    const writer = ffmpeg.stdin?.getWriter();
    if (!writer) return;
    try {
      // A WRITE TO A CHILD'S STDIN CAN BLOCK FOR EVER, and this used to be a bare await.
      // When the pipe buffer fills and ffmpeg stops consuming — a wedged process, a
      // stalled codec, a pipe that never drains — `writer.write` never resolves, so the
      // download emits no further log line and no error. That is indistinguishable from
      // the reported freeze: ffmpeg alive, nothing happening, nothing said.
      //
      // The timeout turns it into a named failure, and the message says WHICH side stalled
      // (a full pipe means the consumer is not reading).
      const WRITE_TIMEOUT_MS = 30_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(
            `ffmpeg stopped consuming stdin: writing ${data.byteLength}B did not complete in ` +
              `${WRITE_TIMEOUT_MS}ms (the pipe is full, so the muxer is wedged)`,
          )),
          WRITE_TIMEOUT_MS,
        );
      });
      try {
        await Promise.race([writer.write(data), timeout]);
      } finally {
        clearTimeout(timer);
      }
      if (!firstWriteLogged) {
        firstWriteLogged = true;
        console.log(`[fmp4] first chunk written to ffmpeg stdin (${data.byteLength}B)`);
      }
    } finally {
      writer.releaseLock();
    }
  };

  /** Pump ffmpeg stdout into the file + parser. */
  const pump = (async () => {
    if (!ffmpeg.stdout) throw new Error("ffmpeg stdout was not piped — cannot capture the muxed mp4");
    let sawFirst = false;
    // ffmpeg must emit its init segment quickly once it has input. If it has produced
    // NOTHING 30s in, it is not muxing, and waiting longer only hides the problem.
    const firstByteDeadline = setTimeout(() => {
      if (!sawFirst) {
        console.error(
          "[fmp4] ffmpeg produced NO output within 30s of starting — it is not muxing. " +
            "Check the ffmpeg stderr lines above and that the managed binary runs (`ffmpeg -version`).",
        );
      }
    }, 30_000);
    for await (const part of ffmpeg.stdout) {
      if (!sawFirst) {
        clearTimeout(firstByteDeadline);
        // Proof the child actually started and produced output. If a freeze happens with
        // this line missing, ffmpeg never ran; if it is present, the stall is downstream.
        sawFirst = true;
        console.log(`[fmp4] first muxed bytes from ffmpeg (${part.byteLength}B)`);
      }
      const slice = part instanceof Uint8Array ? part : new Uint8Array(part);
      await dest.write(slice);
      bytes += slice.byteLength;
      parser.push(slice);
      const now = performance.now();
      if (now - lastReportAt > 500) {
        lastReportAt = now;
        opts.onProgress({
          downloadedSec,
          totalSec,
          bytes,
          percent: totalSec > 0 ? downloadedSec / totalSec : 0,
        });
      }
    }
  })();

  try {
    const inFlight = new Map<number, Promise<{ index: number; data: Uint8Array }>>();
    const reorder = new Map<number, { index: number; data: Uint8Array }>();
    const lookahead = Math.max(1, opts.lookahead ?? 3);
    let nextFetch = firstIndex;
    let nextWrite = firstIndex;

    const fetchOne = (index: number) =>
      fetchWithRetry(chunks[index]!.url, opts.signal, `${index + 1}/${chunks.length}`).then(async (res) => ({
        index,
        data: new Uint8Array(await res.arrayBuffer()),
      }));

    while (nextWrite < chunks.length) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      while (nextFetch < chunks.length && inFlight.size < lookahead) {
        const i = nextFetch++;
        inFlight.set(i, fetchOne(i));
      }
      const winner = await Promise.race([...inFlight.entries()].map(([i, p]) => p.then(() => i)));
      const done = (await inFlight.get(winner!))!;
      inFlight.delete(winner!);
      reorder.set(done.index, done);
      while (reorder.has(nextWrite)) {
        const ready = reorder.get(nextWrite)!;
        reorder.delete(nextWrite);
        await writeChunk(ready.data);
        if (nextWrite % 10 === 0) {
          console.log(
            `[fmp4] progress: ${nextWrite}/${chunks.length} chunks written, ` +
              `${(bytes / 1048576).toFixed(1)}MB muxed`,
          );
        }
        downloadedSec += chunks[ready.index]!.durationSec;
        opts.onProgress({
          downloadedSec,
          totalSec,
          bytes,
          percent: totalSec > 0 ? downloadedSec / totalSec : 0,
        });
        nextWrite++;
      }
    }
    // Close stdin so ffmpeg flushes its final fragment and exits.
    await ffmpeg.stdin?.close().catch(() => {});
    await pump;
    await stderrDone;
    const status = await ffmpeg.status;
    if (!status.success) {
      throw new Error(`ffmpeg mux failed (${status.code}): ${stderrTail.trim() || "no stderr"}`);
    }
    await indexWriter?.flush();
    void resuming;
    return parser.index;
  } catch (err) {
    console.error(`[fmp4] failed: ${err instanceof Error ? err.message : err}`);
    // Cancel: kill the muxer and keep the partial file (resume re-muxes).
    try {
      ffmpeg.kill("SIGKILL");
    } catch {
      // already gone
    }
    await pump.catch(() => {});
    await stderrDone.catch(() => {});
    throw err;
  } finally {
    try {
      dest.close();
    } catch {
      // already closed
    }
  }
}
