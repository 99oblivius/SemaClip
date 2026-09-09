import { Hono } from "hono";
import { wsHandler } from "@/adapters/inbound/ws/handler.ts";
import type {
  ImportStreamByFileUseCase,
  ImportStreamByUrlUseCase,
  ListStreamsUseCase,
  GetStreamUseCase,
  DeleteStreamUseCase,
  UpdateStreamUseCase,
  AttachChatUseCase,
  StartJobUseCase,
  CancelJobUseCase,
  ListJobsUseCase,
  ListClipsUseCase,
  GetClipUseCase,
  RejectClipUseCase,
  UpdateClipUseCase,
  ExportClipUseCase,
  ManageQueueUseCase,
  SettingsUseCase,
} from "@/application/use-cases/mod.ts";
import type { Axis, StreamStatus } from "shared/types";
import type { EventBus, StreamMetadataRepository, StreamStorage } from "@/application/ports/outbound.ts";

export interface HttpDeps {
  importByFile: ImportStreamByFileUseCase;
  importByUrl: ImportStreamByUrlUseCase;
  listStreams: ListStreamsUseCase;
  getStream: GetStreamUseCase;
  deleteStream: DeleteStreamUseCase;
  updateStream: UpdateStreamUseCase;
  attachChat: AttachChatUseCase;
  startJob: StartJobUseCase;
  cancelJob: CancelJobUseCase;
  listJobs: ListJobsUseCase;
  listClips: ListClipsUseCase;
  getClip: GetClipUseCase;
  rejectClip: RejectClipUseCase;
  updateClip: UpdateClipUseCase;
  exportClip: ExportClipUseCase;
  manageQueue: ManageQueueUseCase;
  settings: SettingsUseCase;
  metadata: StreamMetadataRepository;
  storage: StreamStorage;
}

// ── In-memory chat cache ──
// Parsing a multi-MB chat JSON on every paginated request is the main
// bottleneck. Cache the parsed + mapped messages by file path + mtime.
const chatCache = new Map<string, { mtime: number; msgs: { t: number; user: string; body: string }[] }>();

async function loadChat(chatPath: string): Promise<{ t: number; user: string; body: string }[]> {
  const stat = await Deno.stat(chatPath);
  const mtime = stat.mtime?.getTime() ?? 0;
  const cached = chatCache.get(chatPath);
  if (cached && cached.mtime === mtime) return cached.msgs;
  const raw = await Deno.readTextFile(chatPath);
  const data = JSON.parse(raw);
  const comments: Array<{ content_offset_seconds: number; commenter?: { display_name: string }; message?: { body: string } }> =
    Array.isArray(data) ? data : data.comments ?? [];
  const msgs = comments
    .map((m) => ({ t: m.content_offset_seconds ?? 0, user: m.commenter?.display_name ?? "unknown", body: m.message?.body ?? "" }))
    .sort((a, b) => a.t - b.t);
  chatCache.set(chatPath, { mtime, msgs });
  return msgs;
}

/** Domain errors → HTTP status codes. */
function errorStatus(msg: string): 400 | 404 | 500 {
  if (/not found|not available/i.test(msg)) return 404;
  if (/already terminal|can only reorder|invalid|unsupported|not yet downloaded/i.test(msg)) return 400;
  return 500;
}

export function createApp(deps: HttpDeps, bus: EventBus): Hono {
  const app = new Hono();

  app.onError((err, c) => {
    const msg = err instanceof Error ? err.message : String(err);
    const status = errorStatus(msg);
    if (status === 500) console.error("Unhandled error:", err);
    return c.json({ error: msg }, status);
  });

  // ── Streams ──
  app.get("/api/streams", async (c) => {
    const status = c.req.query("status") as StreamStatus | undefined;
    return c.json(await deps.listStreams.execute(status));
  });

  app.get("/api/streams/:id", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream) return c.json({ error: "Stream not found" }, 404);
    return c.json(stream);
  });

  // Import VOD by local file path (for large pre-downloaded videos).
  app.post("/api/streams/import-file", async (c) => {
    const body = await c.req.json();
    const result = await deps.importByFile.execute(body);
    return c.json(result, 201);
  });

  // Import VOD by Twitch URL (auto-downloads video + chat).
  app.post("/api/streams/import-url", async (c) => {
    const body = await c.req.json();
    const result = await deps.importByUrl.execute(body);
    return c.json(result, 201);
  });



  // Attach chat by local file path (for pre-downloaded chat files).
  app.post("/api/streams/:id/attach-chat", async (c) => {
    const body = await c.req.json();
    if (!body?.chatPath) return c.json({ error: "chatPath required" }, 400);
    const stream = await deps.attachChat.execute(c.req.param("id"), body.chatPath as string);
    return c.json(stream, 200);
  });

  app.delete("/api/streams/:id", async (c) => {
    await deps.deleteStream.execute(c.req.param("id"));
    return c.json({ ok: true });
  });

  // Update stream metadata (title, streamer, game, vodPath, chatPath).
  app.patch("/api/streams/:id", async (c) => {
    const body = await c.req.json();
    const stream = await deps.updateStream.execute(c.req.param("id"), body);
    return c.json(stream);
  });

  // ── Jobs ──
  app.get("/api/jobs", async (c) => {
    return c.json(await deps.listJobs.execute());
  });

  app.post("/api/streams/:id/jobs", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const job = await deps.startJob.execute(c.req.param("id"), body.config);
    return c.json(job, 201);
  });

  app.post("/api/jobs/:id/cancel", async (c) => {
    const job = await deps.cancelJob.execute(c.req.param("id"));
    return c.json(job);
  });

  app.post("/api/queue/manage", async (c) => {
    const body = await c.req.json();
    const jobs = await deps.manageQueue.execute(body);
    return c.json(jobs);
  });

  // ── Clips ──
  app.get("/api/streams/:id/clips", async (c) => {
    const axisParam = c.req.query("axis");
    const rejectedParam = c.req.query("rejected");
    const filter: { axis?: Axis; rejected?: boolean } = {};
    if (axisParam) filter.axis = axisParam as Axis;
    if (rejectedParam !== undefined) filter.rejected = rejectedParam === "true";
    const clips = await deps.listClips.execute(c.req.param("id"), filter);
    return c.json(clips);
  });

  app.get("/api/clips/:id", async (c) => {
    const clip = await deps.getClip.execute(c.req.param("id"));
    if (!clip) return c.json({ error: "Clip not found" }, 404);
    return c.json(clip);
  });

  app.post("/api/clips/:id/reject", async (c) => {
    const clip = await deps.rejectClip.execute(c.req.param("id"));
    return c.json(clip);
  });

  // Persist review edits (trim endpoints).
  app.patch("/api/clips/:id", async (c) => {
    const body = await c.req.json();
    const patch: { startTime?: number; endTime?: number } = {};
    if (body.startTime !== undefined) patch.startTime = Number(body.startTime);
    if (body.endTime !== undefined) patch.endTime = Number(body.endTime);
    const clip = await deps.updateClip.execute(c.req.param("id"), patch);
    return c.json(clip);
  });

  app.post("/api/clips/:id/export", async (c) => {
    const body = await c.req.json();
    const result = await deps.exportClip.execute({ clipId: c.req.param("id"), ...body });
    return c.json(result, 201);
  });

  // ── Chat density (per-second message counts) for signal terrain ──
  app.get("/api/streams/:id/chat-density", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.chatPath) return c.json({ error: "Chat not available" }, 404);
    try {
      const msgs = await loadChat(stream.chatPath);
      const duration = stream.duration ?? Math.max(0, ...msgs.map((m) => m.t));
      const bucketCount = Math.max(1, Math.ceil(duration));
      const buckets = new Array(bucketCount).fill(0);
      for (const msg of msgs) {
        const sec = Math.floor(msg.t);
        if (sec >= 0 && sec < bucketCount) buckets[sec]++;
      }
      return c.json({ duration, density: buckets });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });

  // ── Chat messages (paginated, seek-aware) ──
  // Returns messages sorted by content_offset_seconds. Pagination via
  // ?offset=&limit= (default 100). ?around=<seconds> returns messages
  // centered on that timestamp (for initial load on seek).
  app.get("/api/streams/:id/chat", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.chatPath) return c.json({ error: "Chat not available" }, 404);
    try {
      const msgs = await loadChat(stream.chatPath);
      const limit = Math.min(500, parseInt(c.req.query("limit") ?? "100", 10));
      const around = c.req.query("around");

      if (around !== null && around !== undefined) {
        const aroundSec = parseFloat(around) || 0;
        let lo = 0, hi = msgs.length - 1;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (msgs[mid]!.t < aroundSec) lo = mid + 1;
          else hi = mid;
        }
        const start = Math.max(0, lo - Math.floor(limit / 2));
        const end = Math.min(msgs.length, start + limit);
        return c.json({ messages: msgs.slice(start, end), total: msgs.length, offset: start });
      }

      const offset = Math.max(0, parseInt(c.req.query("offset") ?? "0", 10));
      return c.json({ messages: msgs.slice(offset, offset + limit), total: msgs.length, offset });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });

  // ── Chat search ──
  app.get("/api/streams/:id/chat/search", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.chatPath) return c.json({ error: "Chat not available" }, 404);
    const q = c.req.query("q") ?? "";
    if (!q.trim()) return c.json({ results: [] });
    try {
      const msgs = await loadChat(stream.chatPath);
      const lower = q.toLowerCase();
      const results = msgs
        .filter((m) => m.body.toLowerCase().includes(lower))
        .slice(0, 200);
      return c.json({ results });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });
  // ── Seek-aware streaming waveform (SSE) ──
  // Each peak batch carries {firstIndex, startTime, peaks} so the frontend
  // knows WHERE on the timeline to place the data (regardless of arrival order).
  // Accepts ?around=<seconds> to prioritize decoding near the seek point.

  // One peak per second of audio — full resolution, no quantization at any zoom.
  // A 10h stream = 36000 peaks ≈ 352KB JSON, negligible. ~141KB as Float32 binary.
  const TARGET_PEAKS_PER_SEC = 1;
  const SAMPLE_RATE = 8000;
  const BATCH_SIZE = 50; // ~50s per batch, fewer SSE events

  /** Run ffmpeg for a time range, compute peaks, yield batches. */
  async function* streamPeaks(
    vodPath: string,
    startSec: number,
    durationSec: number | null, // null = to end of file
    firstIndex: number,
    totalSamples: number,
  ): AsyncGenerator<{ firstIndex: number; startTime: number; peaks: number[] }> {
    const args = [
      "-threads", "0",        // auto-detect CPU cores
      "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "f32le", "-",
    ];
    if (startSec > 0) args.unshift("-ss", String(startSec));
    if (durationSec !== null) args.unshift("-t", String(durationSec));
    args.unshift("-i", vodPath);

    const cmd = new Deno.Command("ffmpeg", { args, stdout: "piped", stderr: "null" });
    const proc = cmd.spawn();
    const reader = proc.stdout.getReader();

    let peakBuf: number[] = [];
    let acc = new Float32Array(0);
    let peakIdx = firstIndex;
    const peakTime = totalSamples / SAMPLE_RATE; // seconds per peak = samples ÷ samples/sec

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (value) {
          const incoming = new Float32Array(value.buffer, value.byteOffset, Math.floor(value.length / 4));
          const merged = new Float32Array(acc.length + incoming.length);
          merged.set(acc);
          merged.set(incoming, acc.length);
          acc = merged;

          while (acc.length >= totalSamples) {
            let max = 0;
            for (let i = 0; i < totalSamples; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
            peakBuf.push(max);
            acc = acc.slice(totalSamples);
          }
        }

        while (peakBuf.length >= BATCH_SIZE) {
          const batch = peakBuf.splice(0, BATCH_SIZE);
          const startTime = peakIdx * peakTime;
          peakIdx += BATCH_SIZE;
          yield { firstIndex: peakIdx - BATCH_SIZE, startTime, peaks: batch };
        }

        if (done) break;
      }

      // Flush remainder.
      if (acc.length > 0) {
        let max = 0;
        for (let i = 0; i < acc.length; i++) max = Math.max(max, Math.abs(acc[i] ?? 0));
        peakBuf.push(max);
      }
      if (peakBuf.length > 0) {
        const startTime = peakIdx * peakTime;
        peakIdx += peakBuf.length;
        yield { firstIndex: peakIdx - peakBuf.length, startTime, peaks: [...peakBuf] };
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ok */ }
      // Client disconnect must not leave a full-speed audio decode running to
      // EOF — kill the process, then reap it.
      try { proc.kill(); } catch { /* already exited */ }
      try { await proc.status; } catch { /* ok */ }
    }
  }

  app.get("/api/streams/:id/waveform", (c) => {
    const streamId = c.req.param("id");
    const around = parseFloat(c.req.query("around") ?? "0") || 0;

    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const send = (data: unknown) => {
          if (closed) return;
          try {
            controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
          } catch {
            // Controller already closed (client disconnected).
            closed = true;
          }
        };
        const close = () => {
          if (closed) return;
          closed = true;
          try { controller.close(); } catch { /* already closed */ }
        };

        try {
          const stream = await deps.getStream.execute(streamId);
          if (!stream || !stream.vodPath) {
            send({ error: "Video not available" });
            close();
            return;
          }

          // ── Cache check: if waveform was already computed, serve instantly. ──
          // Staleness: old caches had a fixed 2000 peaks. Per-second resolution
          // needs totalPeaks >= duration. If stale, fall through to recompute.
          const cached = await deps.metadata.get(streamId, "waveform");
          if (cached) {
            const cachePath = JSON.parse(cached).path;
            try {
              const raw = await Deno.readTextFile(cachePath);
              const cachedData = JSON.parse(raw) as { duration: number; totalPeaks: number; peaks: number[] };
              if (cachedData.totalPeaks < cachedData.duration) {
                // Stale low-res cache — recompute at per-second resolution.
                throw new Error("stale cache");
              }
              send({ duration: cachedData.duration, totalPeaks: cachedData.totalPeaks });
              for (let i = 0; i < cachedData.peaks.length; i += BATCH_SIZE) {
                if (closed) break;
                const slice = cachedData.peaks.slice(i, i + BATCH_SIZE);
                send({ firstIndex: i, startTime: (i / cachedData.peaks.length) * cachedData.duration, peaks: slice });
              }
              send({ done: true });
              close();
              return;
            } catch {
              // Cache file missing/corrupt/stale — fall through to recompute.
            }
          }

          // ── Cache miss: compute from ffmpeg. ──
          // 1. Get duration.
          const probe = new Deno.Command("ffprobe", {
            args: ["-v", "quiet", "-print_format", "json", "-show_format", stream.vodPath],
            stdout: "piped", stderr: "piped",
          });
          const probeOut = await probe.output();
          const info = JSON.parse(new TextDecoder().decode(probeOut.stdout));
          const duration = parseFloat(info.format?.duration ?? "0");
          if (!duration) {
            send({ error: "Cannot determine duration" });
            close();
            return;
          }
          const totalPeaks = Math.max(1, Math.ceil(duration * TARGET_PEAKS_PER_SEC));
          send({ duration, totalPeaks });

          // 2. Compute peaks per bucket and priority region.
          const samplesPerPeak = Math.max(1, Math.floor(SAMPLE_RATE / TARGET_PEAKS_PER_SEC));
          const peakTime = 1 / TARGET_PEAKS_PER_SEC; // seconds per peak
          const aroundIndex = Math.max(0, Math.min(totalPeaks - 1, Math.floor(around * TARGET_PEAKS_PER_SEC)));

          // Accumulate all peaks for caching.
          const allPeaks = new Array<number>(totalPeaks).fill(-1);

          // 3. Stream priority region (from aroundIndex to end) first.
          for await (const batch of streamPeaks(
            stream.vodPath,
            aroundIndex * peakTime,
            null,
            aroundIndex,
            samplesPerPeak,
          )) {
            if (closed) break;
            for (let i = 0; i < batch.peaks.length; i++) {
              allPeaks[batch.firstIndex + i] = batch.peaks[i]!;
            }
            send(batch);
          }

          // 4. Then stream the beginning (0 to aroundIndex), filling the gap.
          if (!closed && aroundIndex > 0) {
            for await (const batch of streamPeaks(
              stream.vodPath,
              0,
              aroundIndex * peakTime,
              0,
              samplesPerPeak,
            )) {
              if (closed) break;
              for (let i = 0; i < batch.peaks.length; i++) {
                allPeaks[batch.firstIndex + i] = batch.peaks[i]!;
              }
              send(batch);
            }
          }

          if (!closed) send({ done: true });

          // Only cache if we received all peaks (client didn't disconnect early).
          if (!closed && allPeaks.every((v) => v >= 0)) {
            await deps.storage.ensureStreamDirs(streamId);
            const cachePath = deps.storage.artifactPath(streamId, "waveform.json");
            await Deno.writeTextFile(cachePath, JSON.stringify({ duration, totalPeaks, peaks: allPeaks }));
            await deps.metadata.set(streamId, "waveform", JSON.stringify({ path: cachePath, duration, totalPeaks }));
          }
        } catch (e) {
          send({ error: `Waveform streaming failed: ${e}` });
        } finally {
          close();
        }
      },
    });

    return c.newResponse(body, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      },
    });
  });

  // ── Settings ──
  app.get("/api/settings", async (c) => c.json(await deps.settings.get()));
  app.put("/api/settings", async (c) => {
    const body = await c.req.json();
    return c.json(await deps.settings.update(body));
  });

  // ── System info ──
  // Detect available compute devices: NVIDIA GPUs via nvidia-smi + CPU.
  // The frontend renders these as a single device selector.
  // gpuDevice = null means "auto" (first available GPU, or CPU if none).
  // gpuDevice = -1 means "force CPU".
  app.get("/api/system/devices", async (c) => {
    const devices: { id: string; label: string; index: number | null; type: "gpu" | "cpu"; memoryMB: number }[] = [];

    // Detect NVIDIA GPUs.
    try {
      const cmd = new Deno.Command("nvidia-smi", {
        args: ["--query-gpu=index,name,memory.total", "--format=csv,noheader,nounits"],
        stdout: "piped", stderr: "null",
      });
      const out = await cmd.output();
      const text = new TextDecoder().decode(out.stdout).trim();
      if (text) {
        for (const line of text.split("\n")) {
          const [idx, name, mem] = line.split(",").map((s) => s.trim());
          const index = parseInt(idx ?? "0", 10);
          const memoryMB = parseInt(mem ?? "0", 10);
          devices.push({ id: `gpu-${index}`, label: name ?? "Unknown GPU", index, type: "gpu", memoryMB });
        }
      }
    } catch {
      // nvidia-smi not found — no NVIDIA driver or not in PATH.
    }

    // CPU is always available. Index -1 signals "use CPU" to the engine.
    const cpuCores = navigator.hardwareConcurrency ?? 0;
    devices.push({
      id: "cpu",
      label: `CPU${cpuCores > 0 ? ` (${cpuCores} cores)` : ""}`,
      index: -1,
      type: "cpu",
      memoryMB: 0,
    });

    return c.json(devices);
  });
  // ── Video file serving (range requests for <video>) ──
  app.get("/api/video/:streamId", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("streamId"));
    if (!stream || !stream.vodPath) return c.json({ error: "Video not available" }, 404);
    try {
      const stat = await Deno.stat(stream.vodPath);
      const range = c.req.header("range");
      if (range) {
        const m = /bytes=(\d*)-(\d*)/.exec(range);
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0;
          const end = m[2] ? parseInt(m[2], 10) : stat.size - 1;
          const file = await Deno.open(stream.vodPath, { read: true });
          await file.seek(start, Deno.SeekMode.Start);
          const buf = new Uint8Array(end - start + 1);
          await file.read(buf);
          file.close();
          c.header("Content-Range", `bytes ${start}-${end}/${stat.size}`);
          c.header("Accept-Ranges", "bytes");
          c.header("Content-Length", String(end - start + 1));
          return c.body(buf, 206);
        }
      }
      const file = await Deno.open(stream.vodPath, { read: true });
      c.header("Content-Length", String(stat.size));
      c.header("Accept-Ranges", "bytes");
      return c.body(file.readable);
    } catch {
      return c.json({ error: "Cannot read video file" }, 500);
    }
  });

  // ── WebSocket ──
  app.get("/ws", wsHandler(bus));

  return app;
}
