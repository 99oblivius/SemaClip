/**
 * Locates the console-hiding relay used for Windows spawns that need a working stdin.
 *
 * ── WHY A RELAY EXISTS AT ALL ───────────────────────────────────────────────────
 * Deno cannot spawn a Windows child with BOTH no console window and a writable stdin:
 *
 *   node:child_process   hides the console (windowsHide → CREATE_NO_WINDOW) but DEADLOCKS
 *                        once more than ~1MB is written to a child's stdin, taking the
 *                        event loop down with it (that was the download freeze).
 *   Deno.Command         writes reliably, but has NO console-hiding option — the field is
 *                        absent from its types and unknown fields are silently ignored —
 *                        so a console-subsystem child such as ffmpeg allocates its own
 *                        console and Windows shows a blank cmd window for its lifetime
 *                        (what the owner sees during every download).
 *
 * Wrapping in `conhost.exe --headless` hides the console but BREAKS stdio: the child's output
 * fell from 1,343,689B to 90B for the same 1.67MB input, twice. So the relay is a small Go
 * binary that spawns the real command with CREATE_NO_WINDOW and proxies stdio, built in the
 * same CI step as the updater (`tools/hidewin`).
 *
 * ── WHY IT IS OPTIONAL ──────────────────────────────────────────────────────────
 * A dev run (`deno run main.ts`) has no built relay, and no console can appear on Linux. So
 * this is best-effort: when the relay is absent the caller spawns the command directly, which
 * is exactly today's behaviour. A missing relay costs a console window, never a download.
 */

let cached: string | null | undefined;

function candidatePaths(): string[] {
  const out: string[] = [];
  const env = Deno.env.get("SEMACLIP_HIDEWIN");
  if (env) out.push(env);

  const exe = Deno.execPath();
  const exeDir = exe.includes("/") || exe.includes("\\")
    ? exe.slice(0, Math.max(exe.lastIndexOf("/"), exe.lastIndexOf("\\")))
    : "";
  const suffix = Deno.build.os === "windows" ? ".exe" : "";

  // Alongside the running binary, which is where the build places it next to the payload.
  if (exeDir) out.push(`${exeDir}${Deno.build.os === "windows" ? "\\" : "/"}hidewin${suffix}`);
  // The working directory, for a `deno desktop` run from the repo.
  out.push(`${Deno.cwd()}${Deno.build.os === "windows" ? "\\" : "/"}hidewin${suffix}`);
  // The repo's build output, for dev runs whose cwd is elsewhere in the tree.
  out.push(`${Deno.cwd()}${Deno.build.os === "windows" ? "\\" : "/"}tools/hidewin/hidewin${suffix}`);
  return out;
}

/** The relay path, or null when there is none (or none is needed). */
export function hideConsoleRelay(): string | null {
  if (cached !== undefined) return cached;
  // Windows-only: every other platform has no console window to hide, and adding a
  // process per spawn everywhere else would be pure cost.
  if (Deno.build.os !== "windows") {
    cached = null;
    return null;
  }
  for (const path of candidatePaths()) {
    try {
      if (Deno.statSync(path).isFile) {
        cached = path;
        return cached;
      }
    } catch {
      // Try the next candidate.
    }
  }
  cached = null;
  return null;
}

/** Test seam: forget the cached answer. */
export function resetHideConsoleRelayCache(): void {
  cached = undefined;
}
