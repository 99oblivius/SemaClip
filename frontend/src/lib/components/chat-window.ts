// Chat windowing: which window to load, and where the cursor belongs in it.
//
// ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────────
// ChatView loaded `offset=0&limit=500` once and treated that as the whole stream. Measured against a
// 36,000-message / 2h chat, that window covers t=0..100s — so opening a project at 1h30m showed the
// chat from the first 100 SECONDS of the broadcast. The server has always supported `?around=<sec>`;
// the client never sent it.
//
// The decision logic lives here rather than inline in the component because the component cannot be
// exercised without a browser, and these three judgements are what went wrong: WHICH window to fetch,
// WHETHER the playhead should trigger a refetch at all, and WHICH edge the cursor resumes at after a
// browse crosses a boundary. All three are pure functions of state the component already holds.

/** Messages held per window. The server caps `limit` at 500. */
export const WINDOW_LIMIT = 500;

/** A window edge is "close" within this margin, so ordinary playback does not refetch every tick. */
export const REFETCH_MARGIN = Math.floor(WINDOW_LIMIT / 4);

/**
 * How many messages come at or before `time` — i.e. the first index whose message is LATER.
 *
 * The result is EXCLUSIVE, which is what the view needs: `visibleMessages` slices up to `scrollIndex`,
 * so a message exactly at the playhead must be included and a cursor of "first index at or after"
 * would drop it. Verified against a 5 msg/s series: t=1.0 -> 6, with the 6th message at 1.2 and the
 * 5th at 1.0, so the message at the playhead is the last one shown.
 */
export function cursorForTime(times: readonly number[], time: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (times[mid]! <= time) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Whether the loaded window is far enough from the playhead to need a refetch.
 *
 * `false` while browsing: browsing moves the window deliberately and leaves the PLAYHEAD where it is,
 * so refetching "to the playhead" would snap the view home. The original component had no such
 * concept — it never refetched at all — so this is a new way to be wrong, and it is pinned here.
 */
export function shouldRefetchWindow(opts: {
  follow: boolean;
  windowLength: number;
  cursor: number;
}): boolean {
  if (!opts.follow) return false;
  if (opts.windowLength === 0) return false;
  const inside =
    opts.cursor >= REFETCH_MARGIN && opts.cursor <= opts.windowLength - REFETCH_MARGIN;
  return !inside;
}

/**
 * After a browse runs off an edge and the window is refetched, where does the cursor go?
 *
 * `null` means "not a browse — leave the cursor to follow playback". The "top" case matters: fetching
 * a window around an earlier time centres it, but a user moving BACKWARDS expects to continue from the
 * window's LAST message, not from its middle.
 */
export function resumeCursor(
  mode: "top" | "bottom" | null,
  windowLength: number,
  visibleCount: number,
): number | null {
  if (mode === null) return null;
  if (mode === "top") return windowLength;
  return Math.min(visibleCount, windowLength);
}

/**
 * Which direction a browse is crossing, if either.
 *
 * `newIndex <= 0` with `windowStart > 0` means there is more chat before this window; a request at
 * index 0 that is NOT at the start of the stream is a genuine crossing.
 */
export function browseCrossing(opts: {
  newIndex: number;
  windowLength: number;
  windowStart: number;
  windowEnd: number;
  totalCount: number;
}): "top" | "bottom" | null {
  if (opts.windowLength === 0) return null;
  if (opts.newIndex <= 0 && opts.windowStart > 0) return "top";
  if (opts.newIndex >= opts.windowLength && opts.windowEnd < opts.totalCount) return "bottom";
  return null;
}
