/**
 * A log FILE, because console output is invisible in a packaged desktop app.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
 * Every diagnostic in this server goes through `console.*`. Under `deno run` that is a
 * terminal; in a `deno desktop` build there is NO console attached, so on Windows a
 * packaged app's entire diagnostic output was written to nowhere. The owner reported
 * three failures and could not send a single line of evidence, which turned every fix
 * into a guess — and guesses are what produced three rounds of wrong answers.
 *
 * So: everything the app logs is appended to a file next to its data, and the file is
 * also servable over HTTP (GET /api/log) so it can be read from the UI without knowing
 * any paths.
 *
 * ── DESIGN ──────────────────────────────────────────────────────────────────────
 * - Bounded: the file is trimmed to the last N bytes when it exceeds a cap, so a
 *   long-running download cannot fill the user's disk.
 * - Synchronous-ish: appends are queued and flushed in order, so interleaved lines from
 *   different subsystems never reorder. Volume is low (one line per request/phase), so
 *   this is not a performance concern on the download path.
 * - Never throws into the caller: a logging failure must not break the app it observes.
 * - Installed BEFORE anything else runs, so startup failures are captured too.
 */

const MAX_BYTES = 2 * 1024 * 1024; // 2MB of tail is plenty for one bug report
const TRIM_TO = 1024 * 1024;

let logPath: string | null = null;
let writeQueue: Promise<void> = Promise.resolve();
let installed = false;

/** The file this process logs to, or null when logging is disabled. */
export function logFilePath(): string | null {
  return logPath;
}

function stamp(): string {
  // Local ISO-ish: sortable, and readable without a timezone lookup.
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:` +
    `${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function format(args: unknown[]): string {
  return args.map((a) => {
    if (typeof a === "string") return a;
    if (a instanceof Error) return `${a.name}: ${a.message}\n${a.stack ?? ""}`;
    try {
      return JSON.stringify(a);
    } catch {
      return String(a);
    }
  }).join(" ");
}

/** Append one line. Best-effort: a failure is swallowed, never thrown. */
export function logLine(level: string, args: unknown[]): void {
  if (!logPath) return;
  const line = `${stamp()} [${level}] ${format(args)}\n`;
  writeQueue = writeQueue.then(async () => {
    try {
      // Create on first write rather than at install time: the data dir may not exist
      // yet when this is installed.
      await Deno.writeTextFile(logPath!, line, { append: true, create: true });
      const stat = await Deno.stat(logPath!);
      if (stat.size > MAX_BYTES) {
        const text = await Deno.readTextFile(logPath!);
        await Deno.writeTextFile(logPath!, `--- trimmed ---\n${text.slice(-TRIM_TO)}`);
      }
    } catch {
      // Never propagate: logging must not be able to break the app.
    }
  });
}

/** The tail of the log, for GET /api/log. */
export async function readLogTail(maxBytes = 200_000): Promise<string> {
  if (!logPath) return "(file logging is not enabled)";
  try {
    const text = await Deno.readTextFile(logPath);
    return text.length > maxBytes ? `...${text.slice(-maxBytes)}` : text;
  } catch (err) {
    return `(no log file at ${logPath}: ${err instanceof Error ? err.message : err})`;
  }
}

/**
 * Sends `console.*` to the file as well as the terminal, and captures uncaught errors.
 *
 * The originals are kept: under `deno run` the terminal output is still useful, and CI
 * asserts against it.
 */
export function installFileLogging(dataDir: string): string {
  if (installed) return logPath ?? "";
  installed = true;
  logPath = `${dataDir.replace(/[\\/]+$/, "")}${Deno.build.os === "windows" ? "\\" : "/"}SemaClip.log`;

  const realLog = console.log.bind(console);
  const realWarn = console.warn.bind(console);
  const realError = console.error.bind(console);

  console.log = (...a: unknown[]) => {
    realLog(...a);
    logLine("info", a);
  };
  console.warn = (...a: unknown[]) => {
    realWarn(...a);
    logLine("warn", a);
  };
  console.error = (...a: unknown[]) => {
    realError(...a);
    logLine("error", a);
  };

  // A crash must leave a trace: the whole point is that a packaged app has nowhere to
  // print one, and a silent exit is indistinguishable from a hang.
  globalThis.addEventListener("error", (e) => {
    logLine("uncaught", [(e as ErrorEvent).error ?? (e as ErrorEvent).message]);
  });
  globalThis.addEventListener("unhandledrejection", (e) => {
    logLine("unhandled-rejection", [(e as PromiseRejectionEvent).reason]);
  });

  logLine("info", [
    `=== SemaClip starting === os=${Deno.build.os} version=${
      (Deno as { desktopVersion?: string | null }).desktopVersion ?? "dev"
    } dataDir=${dataDir}`,
  ]);
  logLine("info", [`log file: ${logPath}`]);
  return logPath;
}
