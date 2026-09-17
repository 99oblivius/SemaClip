/**
 * One place that runs external processes.
 *
 * ── WHY THIS EXISTS ───────────────────────────────────────────────────────────
 * On Windows every child process inherits the parent's console, so each ffmpeg,
 * whisper or tar invocation flashes a console window. For a GUI app whose whole
 * premise is background work, that is unacceptable — the user reported "downloading
 * about anything opens a terminal each time".
 *
 * ── WHY node:child_process AND NOT Deno.Command ───────────────────────────────
 * `Deno.Command` has NO option to suppress the child console: its CommandOptions
 * has no windowsHide/creationFlags field (verified against the runtime's own types).
 * Worse, passing `windowsHide` to it is SILENTLY IGNORED — it neither errors nor
 * takes effect (verified), which is the worst possible behaviour for a fix.
 *
 * Deno's `node:child_process` polyfill DOES honour `windowsHide: true`, mapping it to
 * CREATE_NO_WINDOW on CreateProcessW (denoland/deno#34627, fixed 2026-05-31, and the
 * underlying spawn logic already applied the flag). So the node polyfill is the
 * supported route, not a workaround.
 *
 * ── WHY A WRAPPER RATHER THAN 23 EDITS ────────────────────────────────────────
 * There are 23 `Deno.Command` call sites across 12 files. Editing each one means 23
 * chances to forget the flag, and the next call site added would forget it again.
 * Everything goes through here instead, so "no console on Windows" is a property of
 * the codebase rather than a habit.
 *
 * ── SEMANTICS HELD IDENTICAL TO Deno.Command ──────────────────────────────────
 * Call sites were converted mechanically, so this preserves what they relied on:
 *   - `output()` resolves (never rejects) with { success, code, stdout, stderr }
 *   - stdout/stderr are Uint8Array, exactly as Deno.Command returns them — callers
 *     decode with TextDecoder and some slice the bytes
 *   - `status()` resolves with { success, code }
 *   - stdin defaults to "null" so a child can never block waiting for input
 *   - an ENOENT is reported as a normal failed result, not a rejected promise
 */
import { spawn } from "node:child_process";

export interface RunOptions {
  args?: string[];
  cwd?: string | URL;
  env?: Record<string, string>;
  /**
   * "null" (default) closes stdin so a child can never block waiting for input.
   * "inherit" passes the parent's. "piped" exposes a writable stream on the handle
   * (`stdin`) — required by the two callers that FEED a child: ffmpeg muxing the
   * download stream, and the Python engine reading IPC commands.
   */
  stdin?: "null" | "inherit" | "piped";
  stdout?: "piped" | "null" | "inherit";
  stderr?: "piped" | "null" | "inherit";
  signal?: AbortSignal | undefined;
}

export interface RunOutput {
  success: boolean;
  code: number;
  stdout: Uint8Array;
  stderr: Uint8Array;
}

export interface RunStatus {
  success: boolean;
  code: number;
}

/** Maps a Deno-style stdio mode onto the node child_process equivalent. */
function stdio(mode: "piped" | "null" | "inherit" | undefined): "pipe" | "ignore" | "inherit" {
  if (mode === "inherit") return "inherit";
  if (mode === "null") return "ignore";
  return "pipe"; // "piped" and the default
}

/** Builds the child_process options shared by both entry points. */
function launchOptions(cmd: string, opts: RunOptions) {
  return {
    // The WHOLE POINT: without this, Windows opens a console for every child.
    windowsHide: true,

    cwd: opts.cwd === undefined ? undefined : String(opts.cwd),
    env: opts.env,
    stdio: [
      opts.stdin === "inherit" ? "inherit" : opts.stdin === "piped" ? "pipe" : "ignore",
      // An explicit "null"/"inherit" wins over collecting: otherwise a caller that
      // asked for no stdout would still receive a stream (measured).
      opts.stdout === "null" || opts.stdout === "inherit" ? stdio(opts.stdout) : "pipe",
      opts.stderr === "null" || opts.stderr === "inherit" ? stdio(opts.stderr) : "pipe",
    ] as ["inherit" | "ignore" | "pipe", "inherit" | "ignore" | "pipe", "inherit" | "ignore" | "pipe"],
    signal: opts.signal,
  };
}

/**
 * Runs a command to completion and collects its output.
 *
 * Resolves for a non-zero exit (check `.success`) and for a spawn failure (ENOENT),
 * because Deno.Command's `.output()` does the same and callers already branch on
 * `.success`. Rejecting would turn a missing tool into an unhandled exception.
 */
export function run(cmd: string, opts: RunOptions = {}): Promise<RunOutput> {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(cmd, opts.args ?? [], launchOptions(cmd, opts));
    } catch (err) {
      // spawn() throws synchronously for a malformed command.
      const msg = new TextEncoder().encode(err instanceof Error ? err.message : String(err));
      resolve({ success: false, code: -1, stdout: new Uint8Array(), stderr: msg });
      return;
    }

    const out: Buffer[] = [];
    const errs: Buffer[] = [];
    child.stdout?.on("data", (d: Buffer) => out.push(d));
    child.stderr?.on("data", (d: Buffer) => errs.push(d));

    child.on("error", (err: Error) => {
      // ENOENT and friends: report like a failed run rather than throwing.
      errs.push(Buffer.from(err.message));
      resolve({ success: false, code: -1, stdout: new Uint8Array(), stderr: concat(errs) });
    });

    child.on("close", (code: number | null) => {
      const c = code ?? -1;
      resolve({ success: c === 0, code: c, stdout: concat(out), stderr: concat(errs) });
    });
  });
}

/**
 * Runs a command to completion, discarding output.
 *
 * A separate entry point rather than `run()` with the streams ignored: piping a long
 * ffmpeg run only to throw the bytes away costs memory for nothing.
 */
export function runStatus(cmd: string, opts: RunOptions = {}): Promise<RunStatus> {
  return new Promise((resolve) => {
    let child;
    try {
      // Discard output: nothing reads it, and piping a long ffmpeg run only to drop
      // the bytes costs memory for nothing.
      child = spawn(cmd, opts.args ?? [], launchOptions(cmd, { ...opts, stdout: "null", stderr: "null" }));
    } catch {
      resolve({ success: false, code: -1 });
      return;
    }
    child.on("error", () => resolve({ success: false, code: -1 }));
    child.on("close", (code: number | null) => {
      const c = code ?? -1;
      resolve({ success: c === 0, code: c });
    });
  });
}

/** Concatenates collected chunks into the Uint8Array shape callers expect. */
function concat(chunks: Buffer[]): Uint8Array {
  if (chunks.length === 0) return new Uint8Array();
  if (chunks.length === 1) return new Uint8Array(chunks[0]!);
  return new Uint8Array(Buffer.concat(chunks));
}

/** The subset of Deno.ChildProcess that this codebase actually uses. */
export interface ChildHandle {
  /** Resolves when the child exits — Deno.Command's `.status` is a promise. */
  status: Promise<RunStatus>;
  /** Deno-style: throws if the signal cannot be delivered. */
  kill(signal?: string): void;
  pid: number | undefined;
  /**
   * Live stdout/stderr, shaped like Deno.ChildProcess's streams.
   *
   * The ffmpeg adapter reads stderr as it arrives to keep a rolling tail for error
   * reporting, so a promise-only facade would force that code to buffer everything.
   * null when the stream was not piped.
   */
  stdout: ByteStream | null;
  stderr: ByteStream | null;
  /**
   * Collected output, resolving when the child exits.
   *
   * Deno.ChildProcess had this and call sites rely on it: TwitchDlAdapter streams
   * stderr live for progress AND collects stdout for the result. Without it here the
   * only way to get both would be to spawn the command twice.
   */
  output(): Promise<RunOutput>;
  /**
   * Writable stdin, present only when `stdin: "piped"` was requested. Shaped like the
   * Deno.ChildProcess stream the call sites use (write/close).
   */
  stdin: {
    write(chunk: Uint8Array): Promise<number>;
    close(): Promise<void>;
    getWriter(): {
      write(chunk: Uint8Array): Promise<void>;
      releaseLock(): void;
    };
  } | null;
}

/**
 * The reader interface Deno.ChildProcess exposed, which the ffmpeg adapter uses.
 *
 * node's streams are NOT web ReadableStreams (they have `.on("data")`, not
 * `getReader()`), so a node stream cannot simply be handed over — measured: doing so
 * threw `child.stderr?.getReader is not a function` and killed every export.
 */
export interface ByteStream {
  getReader(): {
    read(): Promise<{ done: boolean; value: Uint8Array | undefined }>;
    releaseLock?(): void;
  };
  /** `for await (const part of stream)` — used by the fMP4 muxer. */
  [Symbol.asyncIterator](): AsyncIterator<Uint8Array>;
}

/** Adapts a node Readable to the web-style reader the codebase expects. */
function toByteStream(
  source: NodeJS.ReadableStream | null,
  streamState: { onClaim?: () => void } = {},
): ByteStream | null {
  if (!source) return null;
  const queue: Uint8Array[] = [];
  let done = false;
  let error: Error | null = null;
  const waiters: (() => void)[] = [];
  const wake = () => {
    for (const w of waiters.splice(0)) w();
  };

  source.on("data", (chunk: Buffer | string) => {
    queue.push(typeof chunk === "string" ? new TextEncoder().encode(chunk) : new Uint8Array(chunk));
    wake();
  });
  source.on("end", () => {
    done = true;
    wake();
  });
  source.on("error", (e: Error) => {
    error = e;
    done = true;
    wake();
  });

  const makeReader = () => ({
    async read() {
      for (;;) {
        if (queue.length > 0) return { done: false, value: queue.shift()! };
        if (error) throw error;
        if (done) return { done: true, value: undefined };
        await new Promise<void>((r) => waiters.push(r));
      }
    },
  });

  const onClaim: () => void = (streamState as { onClaim?: () => void }).onClaim ?? (() => {});

  return {
    getReader() {
      // The consumer now owns this stream: stop collecting a copy of it.
      onClaim();
      return makeReader();
    },
    [Symbol.asyncIterator]() {
      onClaim();
      // One reader, iterated: a second reader would fight the first for chunks.
      const r = makeReader();
      return {
        async next() {
          const { done, value } = await r.read();
          return done ? { done: true as const, value: undefined } : { done: false as const, value: value! };
        },
      };
    },
  } as ByteStream;
}

/**
 * Starts a command WITHOUT waiting, for callers that hold the child (long ffmpeg
 * and whisper runs they need to cancel, or that stream their own output).
 *
 * Returns a facade shaped like the parts of `Deno.ChildProcess` in use here, so a
 * converted call site keeps its `.status` await and its `.kill()`.
 */
export function spawnChild(cmd: string, opts: RunOptions = {}): ChildHandle {
  const child = spawn(cmd, opts.args ?? [], launchOptions(cmd, opts));

  // ── UNBOUNDED BUFFERING: the freeze ────────────────────────────────────────
  // These collectors duplicate every byte the child writes. That is fine for a short
  // command, and catastrophic for the fMP4 muxer, whose STDOUT IS THE MUXED VIDEO: the
  // caller reads it through getReader() while this pushed the same bytes into an array
  // that nothing would ever read. A multi-GB download therefore grew a second copy of
  // itself in memory, which is what froze the UI and the download on Windows.
  //
  // A stream that a consumer CLAIMS (getReader or for-await) stops being collected, so
  // exactly one copy exists. Streams nobody claims keep the old behaviour, because
  // `output()` would otherwise return nothing.
  const out: Buffer[] = [];
  const errs: Buffer[] = [];
  let collectOut = true;
  let collectErr = true;
  let spawnError: Error | null = null;
  child.stdout?.on("data", (d: Buffer) => {
    if (collectOut) out.push(d);
  });
  child.stderr?.on("data", (d: Buffer) => {
    if (collectErr) errs.push(d);
  });
  child.on("error", (e: Error) => {
    spawnError = e;
  });

  const settled = new Promise<number>((resolve) => {
    child.on("error", () => resolve(-1));
    child.on("close", (code: number | null) => resolve(code ?? -1));
  });
  // Both the status and the output view hang off the same settlement, so a caller
  // awaiting either gets a consistent answer.
  const status: Promise<RunStatus> = settled.then((c) => ({ success: c === 0, code: c }));

  return {
    status,
    pid: child.pid,
    kill(signal?: string) {
      try {
        child.kill(signal as NodeJS.Signals | undefined);
      } catch {
        // Deno's kill throws on a dead child; callers already treat cancellation
        // best-effort (the download pipeline aborts and moves on).
      }
    },
    stdout: opts.stdout === "inherit"
      ? null
      : toByteStream(child.stdout, {
        onClaim: () => {
          collectOut = false;
          // Drop what was collected before the claim: the consumer is reading the live
          // stream, so the copy is dead weight.
          out.length = 0;
        },
      }),
    stderr: opts.stderr === "inherit"
      ? null
      : toByteStream(child.stderr, {
        onClaim: () => {
          collectErr = false;
          errs.length = 0;
        },
      }),
    async output(): Promise<RunOutput> {
      const code = await settled;
      if (spawnError) errs.push(Buffer.from((spawnError as Error).message));
      return { success: code === 0, code, stdout: concat(out), stderr: concat(errs) };
    },
    stdin: opts.stdin === "piped" && child.stdin
      ? {
          write(chunk: Uint8Array): Promise<number> {
            return new Promise((resolve, reject) => {
              child.stdin!.write(chunk, (err) => (err ? reject(err) : resolve(chunk.length)));
            });
          },
          close(): Promise<void> {
            return new Promise((resolve) => {
              child.stdin!.end(() => resolve());
            });
          },
          getWriter() {
            // Deno's writer writes and releases; back it with the same pipe.
            return {
              write(chunk: Uint8Array): Promise<void> {
                return new Promise((resolve, reject) => {
                  child.stdin!.write(chunk, (err) => (err ? reject(err) : resolve()));
                });
              },
              releaseLock() {
                // Nothing to release: the node stream is used directly.
              },
            };
          },
        }
      : null,
  };
}
