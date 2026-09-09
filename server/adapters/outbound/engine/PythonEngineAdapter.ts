import type { EnginePort } from "@/application/ports/outbound.ts";
import type { EngineEvent, EngineCommand } from "shared/types";
import { ENGINE_EVENT_TOPIC } from "@/application/ports/outbound.ts";
import type { EventBus } from "@/application/ports/outbound.ts";
import { parseEngineEvent } from "./validate.ts";

type EventHandler = (event: EngineEvent) => void;

/**
 * Manages the detection engine as a subprocess.
 * Newline-delimited JSON on stdin/stdout; runtime-validated on read.
 *
 * Lifecycle contract (v2 — see ARCHITECTURE.md §5.4):
 * - start() resolves only after the process exits (the use-case relies on
 *   this to scope its event subscription). A non-zero exit throws.
 * - stderr is drained continuously into a ring buffer; the last lines are
 *   retrievable for job diagnostics. Never piped-and-ignored (v1 deadlock).
 * - cancel() escalates: cancel line → grace → SIGTERM → SIGKILL.
 * - malformed stdout lines are dropped and counted, never crash the loop.
 * - the trailing partial line at EOF is parsed (v1 dropped it — the final
 *   event of a crashing engine was lost).
 */
export class PythonEngineAdapter implements EnginePort {
  private process: Deno.ChildProcess | null = null;
  private stdin: WritableStreamDefaultWriter<Uint8Array> | null = null;
  private readonly handlers = new Set<EventHandler>();
  private readerLoop: Promise<void> | null = null;
  private stderrLoop: Promise<void> | null = null;
  private readonly stderrRing: string[] = [];
  private protocolErrors = 0;
  private droppedEvents = 0;

  /** Ring buffer size for engine stderr diagnostics. */
  private static readonly STDERR_RING_SIZE = 50;

  constructor(
    private readonly engineBinaryPath: string,
    private readonly bus: EventBus,
    private readonly gpuDevice: number | null = null,
  ) {}

  isRunning(): boolean {
    return this.process !== null;
  }

  /** Last stderr lines — attach to job failure diagnostics. */
  lastStderrLines(): string[] {
    return [...this.stderrRing];
  }

  protocolErrorCount(): number {
    return this.protocolErrors;
  }

  async start(command: EngineCommand): Promise<void> {
    if (this.process) {
      throw new Error("Engine already running — cancel first");
    }

    const env: Record<string, string> = {};
    if (this.gpuDevice !== null) env["CUDA_VISIBLE_DEVICES"] = String(this.gpuDevice);

    const parts = this.engineBinaryPath.split(/\s+/);
    const cmd = parts[0] ?? this.engineBinaryPath;
    const preArgs = parts.slice(1);

    this.process = new Deno.Command(cmd, {
      args: [...preArgs, "--ipc"],
      stdin: "piped",
      stdout: "piped",
      stderr: "piped",
      env,
    }).spawn();

    this.stdin = this.process.stdin.getWriter();
    this.readerLoop = this.readEvents();
    this.stderrLoop = this.readStderr();

    await this.send(command);

    const status = await this.process.status;
    await this.cleanup();
    if (!status.success && status.code !== 0) {
      const tail = this.stderrRing.slice(-5).join(" | ");
      throw new Error(`Engine exited with code ${status.code}${tail ? ` — ${tail}` : ""}`);
    }
  }

  async cancel(): Promise<void> {
    if (!this.process) return;
    const GRACE_MS = 2000;
    const SIGTERM_MS = 5000;
    try {
      await this.send({ type: "cancel" });
      // Grace: cooperative cancel handled between pipeline stages.
      const exited = await Promise.race([
        this.process.status.then(() => true),
        new Promise<false>((r) => setTimeout(() => r(false), GRACE_MS)),
      ]);
      if (exited) return;
    } catch {
      // stdin closed (engine already dying) — fall through to signals.
    }
    // SIGTERM ladder, then SIGKILL — a model-loading engine may ignore TERM.
    try {
      this.process.kill("SIGTERM");
      await Promise.race([
        this.process.status,
        new Promise<void>((r) => setTimeout(r, SIGTERM_MS)),
      ]);
      if (this.isRunning()) this.process.kill("SIGKILL");
    } catch {
      // Already exited.
    } finally {
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

  private async readEvents(): Promise<void> {
    if (!this.process) return;
    const decoder = new TextDecoder();
    const reader = this.process.stdout.getReader();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            this.handleLine(line);
          }
        }
        if (done) break;
      }
      // Trailing partial line at EOF — the last words of a crashing engine.
      if (buffer.trim()) this.handleLine(buffer);
    } catch (err) {
      if (!(err instanceof Error && err.name === "Interrupted")) {
        console.error("Engine stdout read error:", err);
      }
    }
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    const parsed = parseEngineEvent(trimmed);
    if (parsed.ok) {
      this.dispatch(parsed.event);
    } else {
      this.protocolErrors++;
      console.error(`Engine: dropped non-conforming line (${parsed.reason}):`, trimmed.slice(0, 200));
    }
  }

  private async readStderr(): Promise<void> {
    if (!this.process) return;
    const reader = this.process.stderr.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (value) {
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            this.stderrRing.push(line.trim());
            if (this.stderrRing.length > PythonEngineAdapter.STDERR_RING_SIZE) this.stderrRing.shift();
          }
        }
        if (done) break;
      }
      if (buffer.trim()) this.stderrRing.push(buffer);
    } catch {
      // stderr closed — nothing more to drain.
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
    if (this.stderrLoop) {
      await this.stderrLoop.catch(() => {});
      this.stderrLoop = null;
    }
  }
}