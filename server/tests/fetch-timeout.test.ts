/**
 * A request to a socket that ACCEPTS but never answers must FAIL, not hang for ever.
 *
 * This is the mechanism behind "the Download button is disabled for ever": that button is
 * gated on the import POST, the POST fetches VOD metadata, and Deno's `fetch` has no
 * default timeout — so a half-open connection (silent firewall, proxy that swallows
 * traffic, a VPN change) left the request pending indefinitely and the UI inert with no
 * error to act on.
 *
 * The check uses a real TCP listener that accepts the connection and then says nothing,
 * because that is the failure mode. A closed port is not the same thing: it refuses
 * immediately and always worked.
 */
import { assert, assertEquals } from "@std/assert";
import { boundedSignal, fetchWithTimeout, isTimeoutError, CHUNK_TIMEOUT_MS, MEDIA_TIMEOUT_MS, METADATA_TIMEOUT_MS } from "@/adapters/outbound/net/fetch-timeout.ts";

/** Starts a listener that accepts connections and never replies. */
function silentServer(): { url: string; close: () => void; hits: () => number } {
  let count = 0;
  const listener = Deno.listen({ port: 0, hostname: "127.0.0.1" });
  const addr = listener.addr as Deno.NetAddr;
  (async () => {
    for await (const conn of listener) {
      count += 1;
      // Accept and hold: never read, never write, never close.
      void conn;
    }
  })().catch(() => {});
  return {
    url: `http://127.0.0.1:${addr.port}/never-answers`,
    close: () => {
      try {
        listener.close();
      } catch {
        // already closed
      }
    },
    hits: () => count,
  };
}

Deno.test("a request to a silent server TIMES OUT instead of hanging", async () => {
  const srv = silentServer();
  try {
    const started = performance.now();
    let threw: unknown = null;
    try {
      await fetchWithTimeout(srv.url, {}, 700);
    } catch (err) {
      threw = err;
    }
    const elapsed = performance.now() - started;
    assert(threw, "the request must not resolve: nothing ever answered it");
    assert(
      isTimeoutError(threw),
      `a deadline miss must be a TimeoutError, not ${(threw as Error).name}: the caller ` +
        "reports it differently from a user cancellation",
    );
    assert(
      elapsed < 5000,
      `it must give up at the deadline; took ${Math.round(elapsed)}ms`,
    );
    assertEquals(srv.hits() > 0, true, "the connection must actually have been attempted");
  } finally {
    srv.close();
  }
});

Deno.test("a caller's cancellation still aborts immediately, not at the deadline", async () => {
  const srv = silentServer();
  try {
    const controller = new AbortController();
    const started = performance.now();
    const p = fetchWithTimeout(srv.url, { signal: controller.signal }, 30_000);
    setTimeout(() => controller.abort(), 150);
    let threw: unknown = null;
    try {
      await p;
    } catch (err) {
      threw = err;
    }
    const elapsed = performance.now() - started;
    assert(threw, "an aborted request must reject");
    assert(
      elapsed < 3000,
      `cancel must not wait out the 30s budget; took ${Math.round(elapsed)}ms`,
    );
    assert(
      !isTimeoutError(threw),
      "a user cancel is NOT a timeout: the retry policy depends on telling them apart",
    );
  } finally {
    srv.close();
  }
});

Deno.test("the budgets are ordered: metadata fails fast, media is lenient but visible", () => {
  assert(
    METADATA_TIMEOUT_MS <= 30_000,
    "small JSON must fail fast; a user waiting on a token should not wait a minute",
  );
  assert(
    MEDIA_TIMEOUT_MS >= 30_000,
    "a media payload can be tens of MB, so its budget bounds a STALL, not slow progress",
  );
  // The reason this cap exists rather than a generous one: 120s combined with 6 retries
  // and exponential backoff meant a failing chunk produced THIRTEEN MINUTES of total
  // silence, which the owner reported as a frozen download and could not distinguish from
  // a hang. A single HLS chunk is a few MB, so 45s is already lenient.
  assert(
    MEDIA_TIMEOUT_MS <= 60_000,
    "a media timeout long enough to hide a stall behind minutes of silence is a defect",
  );
  assert(
    CHUNK_TIMEOUT_MS < MEDIA_TIMEOUT_MS,
    "one chunk is smaller than a whole payload, so its budget must be tighter",
  );
});

Deno.test("boundedSignal carries no signal when the caller has none", () => {
  const s = boundedSignal(undefined, 1000);
  assert(s instanceof AbortSignal);
  assertEquals(s.aborted, false);
});
