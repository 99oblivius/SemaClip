# Download pipeline v2 — scrub-first progressive HLS (2026-09-09)

> User directive: VODs get taken down on Twitch (retention windows + streamer
> prefs). Download quality strategy: scrub media first (540p, chunked, live),
> HQ second (background, capped at a configured max resolution), single
> unified progress bar with itemized popover. Opt-in via the import modal.

## Verified primitives (2026-09-09, live)

- GQL `PlaybackAccessToken_Template` (public web client-id) → token+sig. **usher
  requires the token to be URL-encoded and the `.m3u8` path** — `.json` returns
  400 "malformed vod id", unencoded token returns 403. Required usher params:
  `allow_source=true&platform=web&player=twitchweb&player_backend=mediaplayer&supported_codecs=h264`.
- Master playlist lists every quality with `RESOLUTION=WxH` + `FRAME-RATE`.
- Media playlist: `#EXT-X-PLAYLIST-TYPE:EVENT`, `#EXT-X-TWITCH-TOTAL-SECS`,
  16,822 × ~10s `.ts` chunks for the 46h ironmouse VOD, `#EXT-X-ENDLIST`.
- "Muted" playlist variants download fine (muted only gates Twitch's own player).
- Chunk fetch verified: 200, 4.78MB for a 10s 720p60 segment.

## Architecture (HLS chunked downloader, replaces twitch-dl for URL imports)

New module `server/adapters/outbound/vod/hls.ts` — no external downloader
dependency for the progressive path (twitch-dl stays for metadata + simple
full-file fallback):

1. `resolveQualities(vodId)` → GQL token → usher master playlist →
   `[{name, width, height, fps, bandwidth, playlistUrl}]`.
2. `pickScrubQuality(qualities, scrubHeight=540)`: highest quality with
   height ≤ 540; if the source's lowest is above the cap, take the lowest
   available (the "no scrub file available" case → HQ streams as scrub).
3. `downloadProgressive(playlistUrl, dest, onProgress)`: sequential chunk
   fetch (parallel 4), append `.ts` chunks to a growing file; `onProgress`
   carries `downloadedSeconds` (from EXTINF accumulation) so the player can
   expose the scrub frontier.
4. Concat: chunks are downloaded in order; the growing file IS the scrub
   media (no post-concat needed for scrub — `.ts` streams in <video> via
   mime sniffing; final remux to mp4 optional).
5. HQ pass: same downloader at the capped quality after scrub completes.

## Wire shape

`GET /api/streams/:id/download` →
```json
{
  "phase": "idle|scrub|hq|done|failed",
  "parts": [
    { "kind": "chat", "status": "done|running|pending|skipped", "percent": 1.0, "etaSec": 0 },
    { "kind": "markers", ... },
    { "kind": "scrub", "percent": 0.42, "downloadedSec": 700, "totalSec": 1680, "etaSec": 95 },
    { "kind": "hq", "status": "pending", "percent": 0 }
  ],
  "overall": { "percent": 0.35, "etaSec": 210 }
}
```
- Single unified percent = chat + markers + scrub + HQ weights (bytes-estimated
  for video parts from BANDWIDTH × duration; chat/markers weighted by count).
- ETA from rolling 10s throughput window (not naive total/elapsed).
- Scrub frontier: the timeline dims time > downloadedSec ("black where not
  downloaded"); player clamps seek to the frontier while scrubbing.

## Import modal (advanced, opt-in)

- `Progressive download (scrub-first)` checkbox (default off; on = the above).
- `Maximum quality` select (populated from resolveQualities at import time):
  applies to the HQ pass when opted in, or the single download when opted out.
- Settings page: `Default max quality` selector, used when the modal doesn't override.

## Stream config actions

- `Delete LQ scrub` (frees the scrub; review falls back to full-res scrubbing).
- `Download scrub` / `Download HQ <res>` for missing pieces.

## Ordering

chat → markers → scrub → HQ (each starts when the previous completes; any
failure marks that part failed and continues with the rest).