import type { EnginePort } from "@/application/ports/outbound.ts";
import type { EngineEvent, EngineCommand } from "shared/types";
import { ENGINE_EVENT_TOPIC } from "@/application/ports/outbound.ts";
import type { EventBus } from "@/application/ports/outbound.ts";

type EventHandler = (event: EngineEvent) => void;

/**
 * Manages the Python ML engine as a subprocess.
 * Communicates via newline-delimited JSON on stdin/stdout.
 * One engine process handles one job at a time.
 */
export class PythonEngineAdapter implements EnginePort {
  private process: Deno.ChildProcess | null = null;
  private stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly handlers = new Set<EventHandler>();
  private readerLoop: Promise<void> | null = null;

  constructor(
    private readonly engineBinaryPath: string,
    private readonly bus: EventBus,
    private readonly gpuDevice: number | null = null,
  ) {}

  isRunning(): boolean {
    return this.process !== null;
  }

  async start(command: EngineCommand): Promise<void> {
    if (this.process) {
      throw new Error("Engine already running — cancel first");
    }

    const env: Record<string, string> = {};
    if (this.gpuDevice !== null) env["CUDA_VISIBLE_DEVICES"] = String(this.gpuDevice);

    this.process = new Deno.Command(this.engineBinaryPath, {
      args: ["--ipc"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env,
    }).spawn();

    this.stdin = this.process.stdin.getWriter();
    this.readerLoop = this.readEvents();

    await this.send(command);
  }

  async cancel(): Promise<void> {
    if (!this.process) return;
    try {
      await this.send({ type: "cancel" });
      // Give the engine 2s to exit gracefully, then kill.
      await Promise.race([
        this.process.status,
        new Promise<void>((r) => setTimeout(r, 2000)),
      ]);
    } finally {
      try {
        this.process.kill("SIGTERM");
      } catch {
        // Already exited.
      }
      await this.cleanup();
    }
  }

  onEvent(handler: EventHandler): () => void {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  // ── Internals ──

  private async send(command: EngineCommand): Promise<void> {
    if (!this.stdin) throw new Error("Engine stdin not open");
    const line = JSON.stringify(command) + "\n";
    await this.stdin.write(new TextEncoder().encode(line));
  }

  /** Reads stdout line-by-line, parses JSON, dispatches to handlers + event bus. */
  private async readEvents(): Promise<void> {
    if (!this.process) return;
    const decoder = new TextDecoder();
    const reader = this.process.stdout.getReader();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as EngineEvent;
            this.dispatch(event);
          } catch (err) {
            console.error("Engine: malformed JSON line:", trimmed, err);
          }
        }
      }
    } catch (err) {
      if (!(err instanceof Error && err.name === "Interrupted")) {
        console.error("Engine stdout read error:", err);
      }
    }
  }

  private dispatch(event: EngineEvent): void {
    for (const h of this.handlers) {
      try {
        h(event);
      } catch (err) {
        console.error("Engine event handler error:", err);
      }
    }
    this.bus.publish(ENGINE_EVENT_TOPIC, event);
  }

  private async cleanup(): Promise<void> {
    try {
      this.stdin?.releaseLock();
    } catch {
      // Already released.
    }
    this.stdin = null;
    this.process = null;
    if (this.readerLoop) {
      await this.readerLoop.catch(() => {});
      this.readerLoop = null;
    }
  }
}
