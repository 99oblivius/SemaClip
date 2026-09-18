/**
 * Reading a child's stdout must not LOSE bytes, and `output()` must still work.
 *
 * ── THE BUG THIS GUARDS ─────────────────────────────────────────────────────────
 * The Windows piped-stdin path was rebuilt on `Deno.Command`, whose stdout/stderr are web
 * streams rather than node EventEmitters. A web stream takes exactly ONE reader, and the
 * naive port let two consumers race for it: an internal collector (feeding `output()`) and
 * the caller's own `for await`. They STOLE CHUNKS FROM EACH OTHER.
 *
 * On a real download this corrupted the fMP4 box parser's input in a way that looked like a
 * successful download: the mp4 was written (1.1GB, correct duration) but the `.fragments`
 * sidecar came out as `head 1277` and NOTHING ELSE — so the media route had no map of the
 * file and seeking/scrubbing could not work. The first run produced exactly that 10-byte
 * index; after giving the collector sole ownership of the reader it produced 1650 spans.
 *
 * The lesson is the assertion, not the story: a consumer that reads the stream must receive
 * EVERY byte the child wrote. A byte-counting test is what makes that checkable, and it
 * fails against the racing implementation because the collector swallowed half the output.
 */
import { assertEquals } from "@std/assert";
import { spawnChild, spawnWithDenoCommand } from "@/adapters/outbound/process/spawn.ts";

/** Writes a known number of bytes to stdout and exits. */
function emitter(): string[] {
  if (Deno.build.os === "windows") {
    // A deterministic byte count: 100 lines of 50 chars = 5000 + newlines.
    return ["/c", "for /L %i in (1,1,100) do @echo 0123456789012345678901234567890123456789012345678"];
  }
  return ["-c", "for i in $(seq 1 100); do echo 0123456789012345678901234567890123456789012345678; done"];
}

Deno.test("a consumer reading stdout receives every byte the child wrote", async () => {
  // The DENO path explicitly: on Linux `spawnChild` routes a piped stdin to node, so going
  // through the public entry point would test the wrong implementation here (measured: the
  // racing version passed this test until it was pointed at the channel directly).
  const child = spawnWithDenoCommand(Deno.build.os === "windows" ? "cmd.exe" : "sh", {
    args: emitter(),
    stdin: "piped",
    stdout: "piped",
    stderr: "piped",
  });

  // Feed something so the piped path is taken (that is the path under test on Windows).
  const writer = child.stdin!.getWriter();
  await writer.write(new TextEncoder().encode("x"));
  writer.releaseLock();
  await child.stdin!.close();

  let read = 0;
  if (child.stdout) {
    for await (const part of child.stdout) read += part.byteLength;
  }
  const status = await child.status;

  assertEquals(status.success, true, "the child should exit cleanly");
  // 100 lines x (48 chars + CRLF on Windows / LF elsewhere). Assert a floor rather than an
  // exact count so the test does not encode platform newline differences: the failure this
  // guards against lost ROUGHLY HALF the bytes, so a floor catches it without being brittle.
  const floor = 100 * 48;
  assertEquals(
    read >= floor,
    true,
    `the consumer must receive every byte the child wrote: got ${read}, expected at least ${floor}. ` +
      `A shortfall means something else is also reading this stream (the collector racing ` +
      `the consumer for the single web-stream reader).`,
  );
});

Deno.test("output() still returns the full output when nobody reads the stream", async () => {
  // The collector must keep the bytes when there is no consumer — this is the case that
  // made the two concerns share a reader in the first place.
  const child = spawnWithDenoCommand(Deno.build.os === "windows" ? "cmd.exe" : "sh", {
    args: emitter(),
    stdout: "piped",
    stderr: "piped",
  });
  const out = await child.output();
  assertEquals(out.success, true);
  const text = new TextDecoder().decode(out.stdout);
  assertEquals(
    text.includes("0123456789"),
    true,
    `output() should collect stdout when unclaimed; got ${out.stdout.byteLength} bytes`,
  );
});
