/**
 * The spawn helper must behave EXACTLY like Deno.Command did, or the 23 converted
 * call sites break in ways their tests may not reach. Each assertion here mirrors a
 * pattern actually used in this codebase.
 */
import { assert, assertEquals } from "@std/assert";
import { run, runStatus, spawnChild } from "@/adapters/outbound/process/spawn.ts";

Deno.test("run: captures stdout as Uint8Array (callers TextDecoder it)", async () => {
  const r = await run("echo", { args: ["hello"] });
  assert(r.success);
  assertEquals(r.code, 0);
  assert(r.stdout instanceof Uint8Array);
  assertEquals(new TextDecoder().decode(r.stdout).trim(), "hello");
});

Deno.test("run: non-zero exit RESOLVES with success=false (never rejects)", async () => {
  // ffmpeg/ffprobe failures are read from stderr and thrown as app errors, so a
  // rejected promise here would become an unhandled rejection instead.
  const r = await run("sh", { args: ["-c", "echo boom >&2; exit 3"] });
  assertEquals(r.success, false);
  assertEquals(r.code, 3);
  assertEquals(new TextDecoder().decode(r.stderr).trim(), "boom");
});

Deno.test("run: a missing binary is a failed result, not a throw", async () => {
  // The ffmpeg resolver probes for binaries that may not exist.
  const r = await run("/definitely/not/a/binary", {});
  assertEquals(r.success, false);
  assertEquals(r.code, -1);
  assert(new TextDecoder().decode(r.stderr).length > 0);
});

Deno.test("run: stdout and stderr are separate channels", async () => {
  const r = await run("sh", { args: ["-c", "echo out; echo err >&2"] });
  assertEquals(new TextDecoder().decode(r.stdout).trim(), "out");
  assertEquals(new TextDecoder().decode(r.stderr).trim(), "err");
});

Deno.test("run: arguments with spaces survive verbatim", async () => {
  // Media paths in the data dir routinely contain spaces.
  const r = await run("sh", { args: ["-c", "printf '%s' \"$1\"", "_", "/tmp/a b/c d.mp4"] });
  assertEquals(new TextDecoder().decode(r.stdout), "/tmp/a b/c d.mp4");
});

Deno.test("run: binary output is not corrupted (ffmpeg writes to pipes)", async () => {
  // The bytes are emitted by DENO, not by a shell. `sh -c "printf '\\xff...'"` looked
  // equivalent but tested the SHELL, not the pipe: /bin/sh is bash on Arch and DASH on
  // the Ubuntu runner, and dash's printf does not interpret \xNN — it printed the escape
  // text literally, so CI saw 16 bytes where this machine saw 4. A test about binary-safe
  // pipes must not depend on which shell happens to be installed.
  const r = await run(Deno.execPath(), {
    args: ["eval", "Deno.stdout.writeSync(new Uint8Array([0xff, 0xfe, 0x00, 0x01]))"],
  });
  assertEquals(r.stdout.length, 4, "the pipe must carry exactly the bytes written");
  assertEquals([...r.stdout], [0xff, 0xfe, 0x00, 0x01], "and not corrupt them");
});

Deno.test("run: cwd is honoured", async () => {
  const dir = await Deno.makeTempDir();
  const r = await run("pwd", { cwd: dir });
  // macOS/Arch both resolve the symlinked temp path, so compare endings.
  assert(new TextDecoder().decode(r.stdout).trim().endsWith(dir.replace(/^\/private/, "")));
});

Deno.test("run: env is passed through", async () => {
  const r = await run("sh", { args: ["-c", "printf '%s' \"$MY_VAR\""], env: { MY_VAR: "abc" } });
  assertEquals(new TextDecoder().decode(r.stdout), "abc");
});

Deno.test("run: a child cannot hang waiting for stdin", async () => {
  // stdin defaults to closed, so `cat` exits immediately instead of blocking a job
  // forever (a real hazard for an automated pipeline).
  const r = await run("cat", {});
  assert(r.success);
  assertEquals(r.stdout.length, 0);
});

Deno.test("run: respects an abort signal", async () => {
  // The download pipeline cancels ffmpeg this way.
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 100);
  const r = await run("sleep", { args: ["30"], signal: ac.signal });
  assertEquals(r.success, false);
});

Deno.test("runStatus: reports success without collecting output", async () => {
  const ok = await runStatus("true", {});
  assert(ok.success);
  assertEquals(ok.code, 0);
  const bad = await runStatus("sh", { args: ["-c", "exit 4"] });
  assertEquals(bad.success, false);
  assertEquals(bad.code, 4);
});

Deno.test("runStatus: a missing binary reports failure", async () => {
  const r = await runStatus("/nope/nope", {});
  assertEquals(r.success, false);
});

// ── ChildHandle: the surfaces added for the long-running call sites ────────────

Deno.test("spawnChild: exposes exit status and collected output together", async () => {
  // TwitchDlAdapter streams stderr live AND reads collected stdout from the SAME
  // child. Spawning twice to get both would run the command twice.
  const { spawnChild } = await import("@/adapters/outbound/process/spawn.ts");
  const child = spawnChild("sh", { args: ["-c", "echo hi; echo warn >&2"], stdout: "piped", stderr: "piped" });
  const [status, out] = await Promise.all([child.status, child.output()]);
  assert(status.success);
  assertEquals(new TextDecoder().decode(out.stdout).trim(), "hi");
  assertEquals(new TextDecoder().decode(out.stderr).trim(), "warn");
});

Deno.test("spawnChild: streams are nullable when not piped", async () => {
  const { spawnChild } = await import("@/adapters/outbound/process/spawn.ts");
  const child = spawnChild("true", { stdout: "null", stderr: "null" });
  assertEquals(child.stdout, null);
  assertEquals(child.stderr, null);
  await child.status;
});

Deno.test("spawnChild: stdout can be iterated (the fMP4 muxer pattern)", async () => {
  const { spawnChild } = await import("@/adapters/outbound/process/spawn.ts");
  const child = spawnChild("sh", { args: ["-c", "printf 'a\\nb\\n'"], stdout: "piped" });
  const chunks: string[] = [];
  assert(child.stdout);
  for await (const part of child.stdout) chunks.push(new TextDecoder().decode(part));
  await child.status;
  assertEquals(chunks.join(""), "a\nb\n");
});

Deno.test("spawnChild: piped stdin can be written and closed", async () => {
  // The Python IPC engine and the ffmpeg muxer both feed a child through stdin.
  const { spawnChild } = await import("@/adapters/outbound/process/spawn.ts");
  const child = spawnChild("cat", { stdin: "piped", stdout: "piped" });
  const writer = child.stdin?.getWriter();
  assert(writer, "stdin should be available when piped");
  await writer.write(new TextEncoder().encode("ping\n"));
  await child.stdin!.close();
  const out = await child.output();
  assertEquals(new TextDecoder().decode(out.stdout), "ping\n");
});

Deno.test("spawnChild: stdin is null by default so a child cannot block", async () => {
  const { spawnChild } = await import("@/adapters/outbound/process/spawn.ts");
  const child = spawnChild("cat", { stdout: "piped" });
  assertEquals(child.stdin, null);
  const status = await child.status;
  assert(status.success);
});

Deno.test("run: forwards an abort signal mid-run", async () => {
  const ac = new AbortController();
  setTimeout(() => ac.abort(), 80);
  const r = await run("sleep", { args: ["30"], signal: ac.signal });
  assertEquals(r.success, false);
});

// ── Claimed streams must not be duplicated in memory ──────────────────────────
// The reported symptom: starting a download on Windows froze navigation and the app.
// Cause: spawnChild pushed every stdout chunk into a collector array while the fMP4
// muxer ALSO read the same stream via getReader(), so a multi-GB download held a second
// full copy in RAM. A claimed stream must stop collecting.

Deno.test("a CLAIMED stdout stream is not also buffered by the collector", async () => {
  // Emit a known number of bytes, fully consume them through the reader, then ask
  // output() — it must NOT return a second copy of what was already read.
  const bytes = 512 * 1024;
  const script = `const b = Buffer.alloc(65536, 7); for (let i = 0; i < ${bytes / 65536}; i++) process.stdout.write(b);`;
  const handle = spawnChild("node", { args: ["-e", script] });

  const reader = handle.stdout!.getReader();
  let read = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    read += value!.length;
  }
  assertEquals(read, bytes, "the consumer must receive every byte");

  const out = await handle.output();
  assertEquals(
    out.stdout.length,
    0,
    "a claimed stream must not ALSO be retained: duplicating a download in memory is " +
      "the freeze this test exists to prevent",
  );
});

Deno.test("an UNCLAIMED stream is still collected, so output() works as before", async () => {
  const handle = spawnChild("node", { args: ["-e", "process.stdout.write('collected')"] });
  const out = await handle.output();
  assertEquals(new TextDecoder().decode(out.stdout), "collected");
});

Deno.test("stderr keeps a live tail for error reporting when claimed", async () => {
  // The ffmpeg adapter reads stderr as it arrives AND reads the collected tail in its
  // thrown error. After a claim the collected copy is dropped, so the CALLER must keep
  // its own tail — assert the live stream still delivers everything.
  const script = "process.stderr.write('boom\\n'); process.exit(3)";
  const handle = spawnChild("node", { args: ["-e", script] });
  const reader = handle.stderr!.getReader();
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  assertEquals(text.includes("boom"), true);
  const st = await handle.status;
  assertEquals(st.code, 3);
});
