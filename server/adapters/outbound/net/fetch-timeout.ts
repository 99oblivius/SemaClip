/**
 * Every outbound request is BOUNDED.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────
 * A download on Windows can leave the app frozen with the Download button disabled for
 * ever. The button is disabled while the import POST is in flight
 * (`disabled={importUrlMutation.isPending || ...}`), so a request that never returns is
 * indistinguishable from a hung app: no container is seeded, no progress starts, and the
 * control stays inert.
 *
 * Deno's `fetch` has NO default timeout. A TCP connection that is ACCEPTED but never
 * answers — a silent firewall, a proxy that swallows traffic, a half-open socket after a
 * VPN change, a TLS handshake that stalls — therefore hangs for ever. None of the twelve
 * `fetch` call sites in this server passed a signal, so a single stalled request could
 * wedge the path that starts a download, with no error and nothing to recover from.
 *
 * `AbortSignal.timeout` makes that a failure instead of a hang. The timeout is per
 * attempt, and the HLS chunk fetch already retries, so a slow-but-alive CDN still
 * succeeds; only a connection that produces NOTHING is abandoned.
 *
 * Two budgets, because the two cases are different:
 *   - METADATA (GQL, usher, playlists): small JSON/text, seconds.
 *   - MEDIA (a chunk, a managed-binary download): can be tens of MB, so minutes.
 */

/** Small JSON/text requests: tokens, metadata, playlists. */
export const METADATA_TIMEOUT_MS = 15_000;

/**
 * A media payload. Deliberately generous: a 1080p60 chunk is a few MB and a managed
 * ffmpeg download is ~80MB, and killing a slow-but-progressing transfer would be worse
 * than waiting. This bounds a STALL, not a slow connection.
 */
export const MEDIA_TIMEOUT_MS = 120_000;

/**
 * Combines a caller's cancellation signal with a timeout.
 *
 * `AbortSignal.any` keeps BOTH reasons working: a user cancel aborts immediately, and a
 * stalled socket aborts at the deadline. Passing only the timeout would make cancel wait
 * out the full budget; passing only the caller's signal is what we had, which never fires
 * unless the user cancels.
 */
export function boundedSignal(
  caller: AbortSignal | undefined,
  timeoutMs: number = METADATA_TIMEOUT_MS,
): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs);
  if (!caller) return timeout;
  return AbortSignal.any([caller, timeout]);
}

/** True when an error came from a timeout rather than a caller cancellation. */
export function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // AbortSignal.timeout produces a TimeoutError DOMException; a caller abort produces
  // AbortError. Distinguishing them matters: a timeout deserves a retry, a cancel does not.
  return err.name === "TimeoutError" || err.name === "Timeout";
}

/**
 * `fetch` with a deadline. Use everywhere instead of a bare `fetch`.
 *
 * Throws a TimeoutError (not a hang, not an AbortError) when the deadline passes, so the
 * caller can report "the request timed out" rather than leaving the UI waiting.
 */
export function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs: number = METADATA_TIMEOUT_MS,
): Promise<Response> {
  const caller = init.signal ?? undefined;
  return fetch(url, { ...init, signal: boundedSignal(caller, timeoutMs) });
}
