import { Hono } from "hono";
import { wsHandler } from "@/adapters/inbound/ws/handler.ts";
import type {
  ImportStreamByFileUseCase,
  ImportStreamByUrlUseCase,
  ListStreamsUseCase,
  GetStreamUseCase,
  DeleteStreamUseCase,
  AttachChatUseCase,
  StartJobUseCase,
  CancelJobUseCase,
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
  attachChat: AttachChatUseCase;
  startJob: StartJobUseCase;
  cancelJob: CancelJobUseCase;
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

  // ── Jobs ──
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

  // ── Audio waveform peaks (downsampled RMS) for signal terrain ──
  // Uses ffprobe to get stream duration, then ffprobe to extract packets.
  // Returns ~2000 peaks spanning the full VOD.
  app.get("/api/streams/:id/waveform", async (c) => {
    const stream = await deps.getStream.execute(c.req.param("id"));
    if (!stream || !stream.vodPath) return c.json({ error: "Video not available" }, 404);
    try {
      // Get duration via ffprobe.
      const probe = new Deno.Command("ffprobe", {
        args: ["-v", "quiet", "-print_format", "json", "-show_format", stream.vodPath],
        stdout: "piped",
        stderr: "piped",
      });
      const probeOut = await probe.output();
      const info = JSON.parse(new TextDecoder().decode(probeOut.stdout));
      const duration = parseFloat(info.format?.duration ?? "0");
      if (!duration) return c.json({ error: "Cannot determine duration" }, 500);

      // Sample 2000 points across the file.
      const samples = 2000;
      const peaks: number[] = [];
      const step = duration / samples;
      const cmd = new Deno.Command("ffmpeg", {
        args: [
          "-i", stream.vodPath,
          "-vn",                    // no video
          "-ac", "1",               // mono
          "-ar", "8000",            // low sample rate for speed
          "-f", "f32le",            // 32-bit float little-endian
          "-",                      // stdout
        ],
        stdout: "piped",
        stderr: "null",
      });
      const out = await cmd.output();
      const pcm = new Float32Array(out.stdout.buffer, 0, Math.floor(out.stdout.length / 4));
      const samplesPerBucket = Math.max(1, Math.floor(pcm.length / samples));
      for (let i = 0; i < samples; i++) {
        let max = 0;
        const start = i * samplesPerBucket;
        const end = Math.min(start + samplesPerBucket, pcm.length);
        for (let j = start; j < end; j++) {
          const v = Math.abs(pcm[j] ?? 0);
          if (v > max) max = v;
        }
        peaks.push(max);
      }
      return c.json({ duration, peaks });
    } catch (e) {
      return c.json({ error: `Waveform extraction failed: ${e}` }, 500);
    }
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
