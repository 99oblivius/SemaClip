/**
 * A child fed through `spawnChild` must survive more than one pipe buffer of input.
 *
 * ── THE BUG THIS GUARDS ─────────────────────────────────────────────────────────
 * `spawnChild` used `node:child_process` for every spawn, for its `windowsHide` support.
 * On Windows that polyfill DEADLOCKS once more than ~1MB is written to a child's stdin:
 * the write neither resolves nor rejects and the event loop stops running entirely, so the
 * process can no longer log, serve HTTP, or fire its own timeouts. Measured in the target
 * Windows VM with these very helpers, 3.3MB of mpegts into the app's managed ffmpeg:
 *
 *   node:child_process   HUNG — no result after 12s, and a 250ms heartbeat never fired
 *   Deno.Command         RESOLVED in 52ms, byte-identical output, exit 0
 *
 * The field symptom was a download that stopped right after "[fmp4] spawning ffmpeg" with
 * ffmpeg alive and no error, and an unreachable backend.
 *
 * ── WHY THE SIZE MATTERS AND 64KB WOULD NOT ─────────────────────────────────────
 * Everything below the pipe buffer works, on both paths — `ffmpeg -version`, 4KB writes,
 * even 1MB. A test that writes a small buffer therefore passes against the broken code and
 * proves nothing, which is exactly how this survived several fix attempts. The payload here
 * is deliberately OVER the threshold, and the assertion is that the write SETTLES and the
 * child produces output, both of which the deadlocking path fails.
 *
 * Run on Linux this passes on either implementation (the polyfill is Windows-only), so it
 * is a guard against regressing the routing, not a local reproduction. The reproduction is
 * recorded in the commit that fixed it.
 */
import { assert, assertEquals } from "@std/assert";
import { spawnChild } from "@/adapters/outbound/process/spawn.ts";

/** A command that reads stdin and echoes a count, available on every platform. */
function catCmd(): string {
  return Deno.build.os === "windows" ? "findstr.exe" : "cat";
}

Deno.test("a piped child accepts MORE than one pipe buffer of input", async () => {
  // 8MB: far past the ~1MB threshold where the node path deadlocks on Windows, and past the
  // default pipe buffer on any platform.
  const payload = new Uint8Array(8 * 1024 * 1024);
  for (let i = 0; i < payload.length; i += 4096) payload[i] = 65 + (i % 26);

  // On Windows, findstr without a pattern echoes each input line; `cat` does the same via
  // pass-through. Either way a deadlocked write leaves this promise unsettled.
  const args = Deno.build.os === "windows" ? ["/R", "^"] : [];
  const child = spawnChild(catCmd(), { args, stdin: "piped", stdout: "piped", stderr: "piped" });

  let outBytes = 0;
  let errText = "";
  const drain = (async () => {
    if (!child.stdout) return;
    for await (const part of child.stdout) outBytes += part.byteLength;
  })();
  const drainErr = (async () => {
    if (!child.stderr) return;
    for await (const part of child.stderr) errText += new TextDecoder().decode(part);
  })();

  const writer = child.stdin?.getWriter();
  assert(writer, "stdin should be piped");

  // A bounded race: if the write never settles this fails with a clear message instead of
  // hanging the suite forever.
  const WRITE_BUDGET_MS = 20_000;
  let settled = false;
  const timedOut = new Promise<never>((_, reject) => {
    setTimeout(() => {
      if (!settled) reject(new Error(
        `writing ${payload.byteLength} bytes to a child's stdin did not settle within ` +
          `${WRITE_BUDGET_MS}ms — the write is deadlocked (this is the Windows ` +
          `node:child_process failure: the event loop stops, so timeouts cannot fire either)`,
      ));
    }, WRITE_BUDGET_MS);
  });

  // Write in the SAME shape the downloader uses: chunked, awaiting each write.
  const CHUNK = 256 * 1024;
  const writeAll = (async () => {
    for (let off = 0; off < payload.length; off += CHUNK) {
      await writer!.write(payload.subarray(off, Math.min(off + CHUNK, payload.length)));
    }
    settled = true;
  })();

  await Promise.race([writeAll, timedOut]);

  try { writer!.releaseLock(); } catch { /* ok */ }
  await child.stdin!.close();
  const status = await child.status;
  await Promise.race([drain, drainErr, new Promise((r) => setTimeout(r, 5000))]);

  assertEquals(status.success, true, `child should exit cleanly; stderr=${errText.slice(0, 300)}`);
  assert(
    outBytes > 0,
    `the child should have produced output after receiving ${payload.byteLength} bytes; ` +
      `got ${outBytes} bytes (stderr=${errText.slice(0, 300)})`,
  );
});

Deno.test("stdin still works below the threshold too", async () => {
  // The small-write path must keep working: this is what the app does for short commands and
  // what every prior probe used to "verify" the broken implementation.
  const child = spawnChild(catCmd(), {
    args: Deno.build.os === "windows" ? ["/R", "^"] : [],
    stdin: "piped", stdout: "piped", stderr: "piped",
  });
  const writer = child.stdin!.getWriter();
  await writer.write(new TextEncoder().encode("hello\n"));
  writer.releaseLock();
  await child.stdin!.close();
  const status = await child.status;
  assertEquals(status.success, true);
});
