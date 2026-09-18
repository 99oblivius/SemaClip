/**
 * When should the player reload its media source?
 *
 * ── THE BUG THIS FIXES ──────────────────────────────────────────────────────────
 * The stall detector compared the download's frontier against a high-water mark
 * (`frontierAtLastReload`) that was NEVER reset. Deleting a video and downloading it again
 * therefore broke the comparison: the mark still held the DELETED file's size, the new
 * download starts at zero, and `frontier <= mark + growth` is true forever, so the player
 * never reloaded and the new video did not appear until something else forced a load. That is
 * the owner's "extremely long time to display the new video".
 *
 * A DROP in the frontier is the signal: it cannot mean growth, so it means this is different
 * media and the mark belongs to a file that no longer exists.
 *
 * Kept as a pure function because the decision is the part worth testing — the component
 * around it is a browser, and this was previously untestable inline.
 */
export interface ReloadDecision {
  /** Bytes of the growing media, from the download view. */
  frontierBytes: number;
  /** The frontier at the last reload; a high-water mark of the CURRENT media. */
  frontierAtLastReload: number;
  /** Milliseconds since playback last advanced. */
  sinceProgressMs: number;
  paused: boolean;
  /** True while a reload is already running, so they cannot stack. */
  inFlight: boolean;
  /** No progress for this long counts as a stall. */
  stallMs: number;
  /** New bytes required before a reload is worth doing. */
  minGrowth: number;
}

export function shouldReloadMedia(a: ReloadDecision): boolean {
  if (a.paused || a.inFlight) return false;
  // A stalled decoder with no new data would reload forever.
  if (a.sinceProgressMs < a.stallMs) return false;
  // The frontier went BACKWARDS: this is not the media the mark was tracking (a delete and
  // re-download), so reload now rather than waiting for a growth that starts from zero.
  if (a.frontierBytes < a.frontierAtLastReload) return true;
  // Ordinary growth: only worth reloading once there is meaningfully more to fetch.
  return a.frontierBytes > a.frontierAtLastReload + a.minGrowth;
}

/** What decides whether the player should change the FILE it is playing. */
export interface SourceSwitch {
  /** The media path the view says should be playing (`media.playablePath`). */
  wantedPath: string | null | undefined;
  /** The path the player currently has loaded. */
  loadedPath: string | null | undefined;
}

/**
 * Should the player switch to a different file?
 *
 * ── WHY THIS IS SEPARATE FROM THE STALL DETECTOR ───────────────────────────────────────────
 * The stall detector only ever RE-FETCHED THE SAME URL once it stopped advancing. Every other way
 * the media can change left the player on the old file:
 *
 *   - the proxy is deleted and the finished video should take over — the old URL 404s, and the
 *     player sat on a dead source;
 *   - the video arrives and the proxy was what review was playing — the better file was never
 *     picked up until something else forced a load;
 *   - the FIRST download lands on a project that had nothing — `srcUnavailable` clears, but a
 *     `<video src>` that was `undefined` and then set is a fresh element load the browser may
 *     not perform without a nudge.
 *
 * Comparing the view's intended path against the loaded one covers all of them with one rule,
 * and it is the SERVER that decides which artifact should play (the view already prefers the
 * proxy for review and the video for render), so the player never re-derives that.
 */
export function shouldSwitchSource(s: SourceSwitch): boolean {
  const wanted = s.wantedPath ?? null;
  const loaded = s.loadedPath ?? null;
  if (wanted === loaded) return false;
  // Nothing to play at all: leave the element alone so its "nothing downloaded yet" state
  // renders rather than an element pointing at a URL that does not exist.
  if (wanted === null) return false;
  return true;
}
