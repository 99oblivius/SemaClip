/**
 * The update download, as the owner asked for it: fetched WHILE THE APP IS OPEN, reporting progress,
 * and verified before anything may install it.
 *
 * ── WHY EACH CASE EXISTS ────────────────────────────────────────────────────────────────────────
 * "Did you make the download of the update happen while the client is still open?" — the failure mode
 * being guarded is a download that only starts after the app quits, which shows no progress and makes
 * the restart slow. The first case pins the behaviour; the rest guard the edges that a
 * happy-path test would miss: a truncated transfer, a wrong-length body, an absent content-length,
 * and a failure that must not leave a partial file behind for a later step to install.
 */
import { assert, assertEquals } from "@std/assert";
import { downloadVerified } from "@/adapters/outbound/platform/update-download.ts";

/** A tiny HTTP server for one test. Returns the base URL and a stop function. */
function serve(
  handler: (req: Request) => Response,
): { url: string; stop: () => Promise<void> } {
  const ac = new AbortController();
  const server = Deno.serve(
    { port: 0, hostname: "127.0.0.1", signal: ac.signal, onListen: () => {} },
    handler,
  );
  const { port } = server.addr as Deno.NetAddr;
  return {
    url: `http://127.0.0.1:${port}`,
    stop: async () => {
      ac.abort();
      await server.finished;
    },
  };
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const d = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

Deno.test("downloadVerified streams the payload and reports progress to completion", async () => {
  const body = new Uint8Array(64 * 1024).fill(7);
  const sum = await sha256Hex(body);
  const s = serve(() =>
    new Response(body, { headers: { "content-length": String(body.length) } })
  );
  const dest = await Deno.makeTempFile();

  const seen: number[] = [];
  const res = await downloadVerified(`${s.url}/payload`, dest, sum, {
    onProgress: (p) => seen.push(p.fraction ?? -1),
    intervalMs: 0,
  });

  assertEquals(res.ok, true, res.error ?? "");
  assertEquals(res.bytes, body.length);
  assertEquals(res.sha256, sum);
  assert(seen.length > 0, "progress must be reported at least once");
  // Monotonic: a progress bar that goes backwards is a bug the user sees immediately.
  for (let i = 1; i < seen.length; i++) assert(seen[i] >= seen[i - 1], `progress went backwards: ${seen}`);
  assertEquals(seen.at(-1), 1, "the final report must be complete");
  // The bytes on disk are the bytes served.
  assertEquals((await Deno.readFile(dest)).length, body.length);

  await s.stop();
  await Deno.remove(dest);
});

Deno.test("downloadVerified refuses a payload that does not match the manifest hash", async () => {
  const body = new TextEncoder().encode("this is not the published artifact");
  const s = serve(() => new Response(body));
  const dest = await Deno.makeTempFile();

  const res = await downloadVerified(`${s.url}/payload`, dest, "a".repeat(64));

  assertEquals(res.ok, false);
  assert(res.error?.includes("sha256 mismatch"), `unexpected error: ${res.error}`);
  // NOTHING IS LEFT BEHIND. A .part file surviving a failed verification is how a later step ends up
  // installing a payload that was never verified.
  const leftovers = [dest, `${dest}.part`];
  for (const p of leftovers) {
    let exists = true;
    try {
      await Deno.stat(p);
    } catch {
      exists = false;
    }
    assert(!exists, `${p} must not survive a failed verification`);
  }
  await s.stop();
});

Deno.test("downloadVerified fails on a truncated body rather than accepting what arrived", async () => {
  // A connection that dies mid-transfer is the common real failure. If the short body were accepted,
  // the hash check is the only thing between the user and a truncated program — and here the hash is
  // deliberately NOT provided, which is the case where nothing else would catch it.
  const full = new Uint8Array(8 * 1024).fill(3);
  const s = serve(() =>
    new Response(
      new ReadableStream({
        start(c) {
          c.enqueue(full.subarray(0, 1024));
          c.close();
        },
      }),
      // The server DECLARES the full length but sends less, which is exactly a dropped connection.
      { headers: { "content-length": String(full.length) } },
    )
  );
  const dest = await Deno.makeTempFile();

  const res = await downloadVerified(`${s.url}/payload`, dest, "", { intervalMs: 0 });

  assertEquals(res.ok, false);
  assert(
    res.error !== null && res.error.length > 0,
    "a truncated body must be reported, not silently accepted",
  );
  assertEquals(res.bytes < full.length, true);

  await s.stop();
});

Deno.test("downloadVerified reports an indeterminate fraction when no length is declared", async () => {
  // A chunked response with no content-length. The UI renders an indeterminate bar for this; a
  // fabricated percentage would be the bug. `fraction` must therefore be null, not 0 or 1.
  const body = new TextEncoder().encode("x".repeat(4096));
  const sum = await sha256Hex(body);
  const s = serve(() => {
    // No content-length header at all.
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(body);
        c.close();
      },
    });
    return new Response(stream);
  });
  const dest = await Deno.makeTempFile();

  const reports: { fraction: number | null; total: number }[] = [];
  const res = await downloadVerified(`${s.url}/payload`, dest, sum, {
    onProgress: (p) => reports.push({ fraction: p.fraction, total: p.total }),
    intervalMs: 0,
  });

  assertEquals(res.ok, true, res.error ?? "");
  assert(reports.length > 0, "progress must still be reported without a length");
  // Mid-stream reports carry NO fraction at all: a percentage cannot be computed from an unknown
  // length, and inventing one is the bug this guards.
  const mid = reports.filter((r) => r.fraction !== null && r.fraction !== 1);
  assertEquals(
    mid.length,
    0,
    `no mid-stream fraction may exist without a content-length, got ${JSON.stringify(reports)}`,
  );
  // The final report IS complete (the stream ended, so that is a fact) but must STILL not claim a
  // total the server never declared — otherwise the UI renders "4.1MB of 4.1MB" from a made-up number.
  const last = reports.at(-1)!;
  assertEquals(last.fraction, 1, "the final report must be complete");
  assertEquals(last.total, 0, "an undeclared total must stay undeclared, not be back-filled");

  await s.stop();
  await Deno.remove(dest);
});

Deno.test("downloadVerified reports an HTTP error plainly", async () => {
  const s = serve(() => new Response("nope", { status: 404 }));
  const dest = await Deno.makeTempFile();

  const res = await downloadVerified(`${s.url}/payload`, dest, "");

  assertEquals(res.ok, false);
  assert(res.error?.includes("404"), `the status must be in the error: ${res.error}`);
  await s.stop();
});
