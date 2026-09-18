/**
 * One place that runs external processes.
 *
 * ── ON WINDOWS, A PIPED STDIN USES Deno.Command. NOTHING ELSE DOES. ───────────
 * `node:child_process` DEADLOCKS on Windows once more than ~1MB is written to a child's
 * stdin: the write neither resolves nor rejects, and the event loop stops running entirely,
 * so the process cannot log, serve HTTP, or notice its own timeout. Measured in the target
 * VM with the app's own helper, 3.3MB of mpegts into the managed ffmpeg:
 *
 *   node:child_process    HUNG — no result after 12s, and the loop's own 250ms heartbeat
 *                         never fired once (the loop was blocked, not merely waiting)
 *   Deno.Command          RESOLVED in 52ms, muxed 3,138,113 bytes, exit 0
 *
 * same data, same binary, same no-console (GUI) parent. Below the threshold both work,
 * which is why this survived so long: `ffmpeg -version` and 1MB writes are fine, and only a
 * real download crosses it. The field symptom is exactly this file's opposite concern —
 * a download that stops after "spawning ffmpeg" with the child alive and no error.
 *
 * ── THE CONSOLE TRADEOFF, STATED PLAINLY ──────────────────────────────────────
 * `Deno.Command` has no windowsHide: its CommandOptions has no such field (verified against
 * the runtime's own types), and passing one is SILENTLY IGNORED. `node:child_process` does
 * honour `windowsHide: true` (CREATE_NO_WINDOW, denoland/deno#34627). So the piped-stdin
 * path buys a working download at the cost of the console-hiding flag, and the non-piped
 * paths (the majority, including every short-lived probe) keep it.
 *
 * That trade is deliberate and is the only arrangement that works: a hidden console is
 * worthless on a download that never completes. Whether a console actually becomes VISIBLE
 * could not be measured here — the test VM's non-interactive window station reports no
 * visible window even for a deliberately unhidden spawn — so treat "no terminal flash" as
 * EXPECTED but UNVERIFIED on the piped path and confirm it on a real desktop.
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
function concat(chunks: (Buffer | Uint8Array)[]): Uint8Array {
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
/**
 * The Windows piped-stdin path, built on `Deno.Command`.
 *
 * Only used when a caller will FEED the child (opts.stdin === "piped") on Windows, because
 * that is the exact configuration `node:child_process` deadlocks in. Everything else keeps
 * the node path, and therefore keeps `windowsHide`.
 *
 * Semantics are matched to the node path deliberately:
 *   - stdout/stderr become the same ByteStream facade (Deno's real streams are adapted)
 *   - `output()` resolves, never rejects
 *   - an ENOENT resolves as a failed result rather than throwing
 */
/** Exported for tests: the Windows piped-stdin path, exercisable on any platform. */
export function spawnWithDenoCommand(cmd: string, opts: RunOptions): ChildHandle {
  const command = new Deno.Command(cmd, {
    args: opts.args ?? [],
    ...(opts.cwd ? { cwd: opts.cwd } : {}),
    ...(opts.env ? { env: opts.env } : {}),
    stdin: opts.stdin ?? "null",
    stdout: opts.stdout === "null" || opts.stdout === "inherit" ? opts.stdout : "piped",
    stderr: opts.stderr === "null" || opts.stderr === "inherit" ? opts.stderr : "piped",
  });

  let child: Deno.ChildProcess;
  try {
    child = command.spawn();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`spawn failed: ${cmd} — ${message}`);
    const failed = { success: false, code: -1 };
    return {
      status: Promise.resolve(failed),
      pid: undefined,
      kill() {},
      stdout: null,
      stderr: null,
      output: () => Promise.resolve({ ...failed, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      stdin: null,
    };
  }

  // ── ONE READER, ONE OWNER, AND A QUEUE IN FRONT ──────────────────────────────
  // A ReadableStream takes exactly one reader, and TWO consumers must not race for it. The
  // node path got this free (node streams are EventEmitters: every listener sees every
  // chunk), so a naive port let the internal collector and the caller's `for await` share
  // the reader and STEAL CHUNKS FROM EACH OTHER. On a real download that silently corrupted
  // the fMP4 box parser's input — the download completed, but the fragment index came out
  // empty (10 bytes: a moov offset and no fragments), so the media could not be scrubbed.
  //
  // So: the collector owns the reader and ALWAYS drains it into a queue. Claiming swaps what
  // happens to queued bytes (kept for `output()` vs. handed to the consumer) and nothing
  // races, because there is still only one reader.
  const makeChannel = (stream: ReadableStream<Uint8Array> | null, isOut: boolean) => {
    if (!stream) {
      return {
        facade: null as ByteStream | null,
        collect: async () => {},
        buffered: () => [] as Uint8Array[],
      };
    }
    const reader = stream.getReader();
    const queue: Uint8Array[] = [];
    const collected: Uint8Array[] = [];
    const waiters: (() => void)[] = [];
    let done = false;
    let error: Error | null = null;
    let claimed = false;
    const wake = () => {
      for (const w of waiters.splice(0)) w();
    };

    const collect = async () => {
      try {
        for (;;) {
          const { done: d, value } = await reader.read();
          if (d) {
            done = true;
            wake();
            return;
          }
          if (!value) continue;
          queue.push(value);
          // Only the unclaimed channel keeps a copy for `output()`.
          if (!claimed) collected.push(value);
          wake();
        }
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        done = true;
        wake();
      }
    };

    const next = async (): Promise<{ done: boolean; value: Uint8Array | undefined }> => {
      for (;;) {
        const value = queue.shift();
        if (value) return { done: false, value };
        if (error) throw error;
        if (done) return { done: true, value: undefined };
        await new Promise<void>((r) => waiters.push(r));
      }
    };

    const facade: ByteStream = {
      getReader() {
        claimed = true;
        // Drop the pre-claim copies: the consumer is reading live now, so they are dead
        // weight and keeping them would double every byte.
        collected.length = 0;
        return {
          read: next,
          releaseLock: () => { /* the collector owns the reader for the child's lifetime */ },
        };
      },
      [Symbol.asyncIterator](): AsyncIterator<Uint8Array> {
        claimed = true;
        return {
          async next() {
            const { done: d, value } = await next();
            return d ? { done: true as const, value: undefined } : { done: false as const, value: value! };
          },
        };
      },
    };

    return {
      facade,
      collect,
      buffered: () => collected,
      claimed: () => claimed,
    };
  };

  const outCh = makeChannel(child.stdout, true);
  const errCh = makeChannel(child.stderr, false);
  outCh.collect().catch(() => {});
  errCh.collect().catch(() => {});

  const status: Promise<RunStatus> = child.status.then((st) => ({ success: st.success, code: st.code }))
    .catch(() => ({ success: false, code: -1 }));

  return {
    status,
    pid: child.pid,
    kill() {
      try { child.kill(); } catch { /* already exited */ }
    },
    stdout: outCh.facade,
    stderr: errCh.facade,
    async output(): Promise<RunOutput> {
      const st = await status;
      return { success: st.success, code: st.code, stdout: concat(outCh.buffered()), stderr: concat(errCh.buffered()) };
    },
    stdin: opts.stdin === "piped"
      ? {
          async write(chunk: Uint8Array): Promise<number> {
            const w = child.stdin.getWriter();
            try {
              await w.write(chunk);
            } finally {
              w.releaseLock();
            }
            return chunk.length;
          },
          async close(): Promise<void> {
            try { await child.stdin.close(); } catch { /* already closed */ }
          },
          getWriter() {
            const w = child.stdin.getWriter();
            return {
              write(chunk: Uint8Array): Promise<void> { return w.write(chunk); },
              releaseLock() { try { w.releaseLock(); } catch { /* ok */ } },
            };
          },
        }
      : null,
  };
}

export function spawnChild(cmd: string, opts: RunOptions = {}): ChildHandle {
  // On Windows a PIPED STDIN must not go through node:child_process: writing more than
  // ~1MB deadlocks it and blocks the event loop (measured — see the file header). Feed the
  // child with the runtime's own API instead; every other spawn keeps windowsHide.
  if (Deno.build.os === "windows" && opts.stdin === "piped") {
    return spawnWithDenoCommand(cmd, opts);
  }

  // `run()` wraps its spawn because spawn() throws synchronously for a malformed command
  // or a missing binary. This entry point did not, so a machine with no ffmpeg on PATH
  // got an exception thrown out of a download instead of a clean reported failure — on a
  // GUI build that surfaces as a download that never starts, with no message.
  let child;
  try {
    child = spawn(cmd, opts.args ?? [], launchOptions(cmd, opts));
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`spawn failed: ${cmd} — ${message}`);
    const failed = { success: false, code: -1 };
    return {
      status: Promise.resolve(failed),
      pid: undefined,
      kill() {},
      stdout: null,
      stderr: null,
      output: () => Promise.resolve({ ...failed, stdout: new Uint8Array(), stderr: new Uint8Array() }),
      stdin: null,
    };
  }

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
