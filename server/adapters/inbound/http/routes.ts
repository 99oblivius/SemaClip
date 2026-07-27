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
  ExportClipUseCase,
  ManageQueueUseCase,
  SettingsUseCase,
} from "@/application/use-cases/mod.ts";
import type { Axis, StreamStatus } from "shared/types";
import type { EventBus } from "@/application/ports/outbound.ts";

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
  exportClip: ExportClipUseCase;
  manageQueue: ManageQueueUseCase;
  settings: SettingsUseCase;
  /** Cache dir for uploaded files. */
  uploadDir: string;
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

  // Upload a VOD file via multipart (for small/medium videos).
  // Large VODs should use import-file with a path instead.
  app.post("/api/streams/upload-vod", async (c) => {
    const form = await c.req.formData();
    const file = form.get("vod") as File | null;
    const title = (form.get("title") as string | null) ?? undefined;
    const streamer = (form.get("streamer") as string | null) ?? undefined;
    if (!file) return c.json({ error: "No 'vod' file in form data" }, 400);

    await Deno.mkdir(deps.uploadDir, { recursive: true });
    const vodPath = `${deps.uploadDir}/${file.name}`;
    await Deno.writeFile(vodPath, new Uint8Array(await file.arrayBuffer()));

    const result = await deps.importByFile.execute({
      vodPath,
      title: title ?? file.name.replace(/\.[^.]+$/, ""),
      ...(streamer !== undefined && { streamer }),
    });
    return c.json(result, 201);
  });

  // Upload a chat file and attach it to an existing stream.
  app.post("/api/streams/:id/upload-chat", async (c) => {
    const form = await c.req.formData();
    const file = form.get("chat") as File | null;
    if (!file) return c.json({ error: "No 'chat' file in form data" }, 400);

    await Deno.mkdir(deps.uploadDir, { recursive: true });
    const chatPath = `${deps.uploadDir}/${file.name}`;
    await Deno.writeFile(chatPath, new Uint8Array(await file.arrayBuffer()));

    const stream = await deps.attachChat.execute(c.req.param("id"), chatPath);
    return c.json(stream, 200);
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
      const raw = await Deno.readTextFile(stream.chatPath);
      const data = JSON.parse(raw);
      const comments = Array.isArray(data) ? data : data.comments ?? [];
      // Bucket messages by content_offset_seconds.
      const duration = stream.duration ?? Math.max(
        ...comments.map((m: { content_offset_seconds?: number }) => m.content_offset_seconds ?? 0),
        0,
      );
      const bucketCount = Math.max(1, Math.ceil(duration));
      const buckets = new Array(bucketCount).fill(0);
      for (const msg of comments) {
        const sec = Math.floor(msg.content_offset_seconds ?? 0);
        if (sec >= 0 && sec < bucketCount) buckets[sec]++;
      }
      return c.json({ duration, density: buckets });
    } catch {
      return c.json({ error: "Cannot read chat file" }, 500);
    }
  });

  // ── Seek-aware streaming waveform (SSE) ──
  // Each peak batch carries {firstIndex, startTime, peaks} so the frontend
  // knows WHERE on the timeline to place the data (regardless of arrival order).
  // Accepts ?around=<seconds> to prioritize decoding near the seek point.

  const TARGET_PEAKS = 2000;
  const SAMPLE_RATE = 8000;
  const BATCH_SIZE = 10; // small first-batch latency (~1s), 200 total SSE events

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
    const peakTime = totalSamples / TARGET_PEAKS; // seconds per peak

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
      try { await proc.status; } catch { /* ok */ }
    }
  }

  app.get("/api/streams/:id/waveform", (c) => {
    const streamId = c.req.param("id");
    const around = parseFloat(c.req.query("around") ?? "0") || 0;

    const body = new ReadableStream({
      async start(controller) {
        const encoder = new TextEncoder();
        const send = (data: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        };

        try {
          const stream = await deps.getStream.execute(streamId);
          if (!stream || !stream.vodPath) {
            send({ error: "Video not available" });
            controller.close();
            return;
          }

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
            controller.close();
            return;
          }
          send({ duration, totalPeaks: TARGET_PEAKS });

          // 2. Compute peaks per bucket and priority region.
          const samplesPerPeak = Math.max(1, Math.floor((duration * SAMPLE_RATE) / TARGET_PEAKS));
          const peakTime = duration / TARGET_PEAKS;
          const aroundIndex = Math.max(0, Math.min(TARGET_PEAKS - 1, Math.floor((around / duration) * TARGET_PEAKS)));

          // 3. Stream priority region (from aroundIndex to end) first.
          for await (const batch of streamPeaks(
            stream.vodPath,
            aroundIndex * peakTime, // start time in seconds
            null,                    // to end of file
            aroundIndex,
            samplesPerPeak,
          )) {
            if (controller.desiredSize === null) break; // client disconnected
            send(batch);
          }

          // 4. Then stream the beginning (0 to aroundIndex), filling the gap.
          if (aroundIndex > 0) {
            for await (const batch of streamPeaks(
              stream.vodPath,
              0,
              aroundIndex * peakTime,
              0,
              samplesPerPeak,
            )) {
              if (controller.desiredSize === null) break;
              send(batch);
            }
          }

          send({ done: true });
        } catch (e) {
          send({ error: `Waveform streaming failed: ${e}` });
        } finally {
          controller.close();
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
  app.get("/api/settings", (c) => c.json(deps.settings.get()));
  app.put("/api/settings", async (c) => {
    const body = await c.req.json();
    return c.json(deps.settings.update(body));
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
