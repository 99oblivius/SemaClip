/**
 * Twitch HLS downloader — progressive chunked fetch of VOD playlists.
 *
 * Verified live (docs/DOWNLOAD-PIPELINE.md): GQL playback token → usher
 * master playlist (token MUST be URL-encoded, path is `.m3u8` — `.json`
 * returns 400 "malformed vod id") → media playlist with ~10s `.ts` chunks.
 * Chunks are appended in timeline order so the growing file is immediately
 * proxyable.
 */

const GQL_URL = "https://gql.twitch.tv/gql";
// The public web client-id (same flow as chat/marker fetches).
const CLIENT_ID = "kd1unb4b3q4t58fwlpcbzcbnm76a8fp";

const TWITCH_VOD_REGEX = /videos\/(\d+)/;

/** Extracts the numeric VOD id from a Twitch VOD URL or a bare id. */
export function extractVodId(urlOrId: string): string | null {
  const m = urlOrId.match(TWITCH_VOD_REGEX);
  if (m?.[1]) return m[1];
  if (/^\d{5,}$/.test(urlOrId.trim())) return urlOrId.trim();
  return null;
}

export interface HlsQuality {
  /** Display name, e.g. "720p60". */
  name: string;
  width: number;
  height: number;
  fps: number;
  bandwidth: number;
  playlistUrl: string;
}

export interface PlaylistChunk {
  url: string;
  /** EXTINF duration in seconds. */
  durationSec: number;
}

/** GQL PlaybackAccessToken_Template with the public web client-id. */
export async function fetchPlaybackToken(vodId: string): Promise<{ sig: string; token: string }> {
  const body = {
    operationName: "PlaybackAccessToken_Template",
    query:
      'query PlaybackAccessToken_Template($vodID: ID!, $playerType: String!) { videoPlaybackAccessToken(id: $vodID, params: {platform: "web", playerBackend: "mediaplayer", playerType: $playerType}) { value signature } }',
    variables: { vodID: vodId, playerType: "site" },
  };
  const res = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`GQL playback token failed: ${res.status}`);
  const data = await res.json() as {
    data?: { videoPlaybackAccessToken?: { value: string; signature: string } | null };
  };
  const tok = data.data?.videoPlaybackAccessToken;
  if (!tok || !tok.signature) throw new Error("Playback token denied (forbidden or expired VOD)");
  return { sig: tok.signature, token: tok.value };
}

/** GQL token → usher master playlist → quality descriptors. */
export async function resolveQualities(vodId: string): Promise<HlsQuality[]> {
  const { sig, token } = await fetchPlaybackToken(vodId);
  const usherUrl =
    `https://usher.ttvnw.net/vod/${vodId}.m3u8?sig=${sig}&token=${encodeURIComponent(token)}` +
    `&allow_source=true&platform=web&player=twitchweb&player_backend=mediaplayer&supported_codecs=h264`;
  const res = await fetch(usherUrl);
  if (!res.ok) throw new Error(`usher returned ${res.status} for VOD ${vodId}`);
  return parseMasterPlaylist(await res.text());
}

export interface VodMeta {
  title: string;
  streamer: string;
  game: string | null;
  durationSec: number;
}

/** VOD metadata via GQL — no twitch-dl dependency (progressive path). */
export async function fetchVodMeta(vodId: string): Promise<VodMeta> {
  const res2 = await fetch(GQL_URL, {
    method: "POST",
    headers: { "Client-ID": CLIENT_ID, "Content-Type": "application/json" },
    body: JSON.stringify({
      query: '{ video(id: "' + vodId + '") { title owner { displayName } game { displayName } lengthSeconds } }',
    }),
  });
  if (!res2.ok) throw new Error(`GQL metadata failed: ${res2.status}`);
  const data = await res2.json() as {
    data?: {
      video?: {
        title: string | null;
        owner?: { displayName: string } | null;
        game?: { displayName: string } | null;
        lengthSeconds: number;
      } | null;
    };
  };
  const v = data.data?.video;
  if (!v) throw new Error("VOD not found or unavailable");
  return {
    title: v.title ?? "Untitled",
    streamer: v.owner?.displayName ?? "unknown",
    game: v.game?.displayName ?? null,
    durationSec: v.lengthSeconds,
  };
}

/**
 * Parses an usher master playlist into quality descriptors.
 * Skips audio-only entries (no RESOLUTION) and malformed lines rather than
 * failing the whole manifest.
 */
export function parseMasterPlaylist(text: string): HlsQuality[] {
  const qualities: HlsQuality[] = [];
  const lines = text.split("\n").map((l) => l.trim());
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line?.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = line.slice("#EXT-X-STREAM-INF:".length);
    const next = lines[i + 1];
    if (!next || next.startsWith("#")) continue;

    const resolution = attrs.match(/RESOLUTION=(\d+)x(\d+)/);
    if (!resolution) continue;
    const bandwidth = parseInt(attrs.match(/BANDWIDTH=(\d+)/)?.[1] ?? "0", 10);
    const fps = parseFloat(attrs.match(/FRAME-RATE=([\d.]+)/)?.[1] ?? "30");
    const video = attrs.match(/VIDEO="([^"]+)"/)?.[1];
    // Display name from the preceding #EXT-X-MEDIA line, else the VIDEO group.
    let name = video ?? "";
    for (let j = i - 1; j >= 0 && lines[j]?.startsWith("#EXT-X-MEDIA:"); j--) {
      const mediaAttrs = lines[j]!.slice("#EXT-X-MEDIA:".length);
      if (video !== null && mediaAttrs.includes(`GROUP-ID="${video}"`)) {
        name = mediaAttrs.match(/NAME="([^"]*)"/)?.[1] ?? name;
        break;
      }
    }
    qualities.push({
      name,
      width: parseInt(resolution[1]!, 10),
      height: parseInt(resolution[2]!, 10),
      fps,
      bandwidth,
      playlistUrl: next,
    });
  }
  return qualities;
}

/**
 * Proxy-quality picker: the highest quality with height ≤ cap. Ties break
 * toward higher fps then bandwidth. If every quality exceeds the cap, the
 * lowest available becomes the proxy (the "no true proxy" case — the caller
 * treats the single download as both proxy and HQ).
 */
export function pickProxyQuality(qualities: HlsQuality[], proxyHeightCap: number): HlsQuality | null {
  if (qualities.length === 0) return null;
  const byHeightAsc = [...qualities].sort((a, b) => a.height - b.height || a.bandwidth - b.bandwidth);
  const candidates = byHeightAsc.filter((q) => q.height <= proxyHeightCap);
  if (candidates.length === 0) return byHeightAsc[0] ?? null;
  return candidates.sort((a, b) => b.height - a.height || b.fps - a.fps)[0] ?? null;
}

/**
 * Highest quality whose height ≤ cap; null cap = highest overall. The cap
 * applies to the vertical dimension for both orientations: landscape VODs
 * are labeled by height (Twitch convention), and portrait content's
 * user-perceived "height" is also H. A cap below the smallest available
 * quality degrades to the smallest quality rather than failing.
 */
export function pickBestQuality(qualities: HlsQuality[], maxHeight: number | null): HlsQuality | null {
  if (qualities.length === 0) return null;
  const sorted = [...qualities].sort((a, b) => b.height - a.height || b.bandwidth - a.bandwidth);
  if (maxHeight === null || maxHeight <= 0) return sorted[0] ?? null;
  const capped = sorted.filter((q) => q.height <= maxHeight);
  return (capped[0] ?? sorted[sorted.length - 1]) ?? null;
}

/** Resolves relative chunk URLs against the playlist URL (HLS §4). */
export function parseMediaPlaylist(text: string, playlistUrl: string): PlaylistChunk[] {
  const base = playlistUrl.replace(/[^/]*$/, "");
  const chunks: PlaylistChunk[] = [];
  const lines = text.split("\n").map((l) => l.trim());
  let pendingDuration: number | null = null;
  for (const line of lines) {
    if (line.startsWith("#EXTINF:")) {
      const dur = parseFloat(line.slice(8).split(",")[0] ?? "0");
      pendingDuration = Number.isFinite(dur) ? dur : null;
    } else if (line !== "" && !line.startsWith("#") && pendingDuration !== null) {
      const url = line.startsWith("http") ? line : base + line;
      chunks.push({ url, durationSec: pendingDuration });
      pendingDuration = null;
    }
  }
  return chunks;
}

export interface ProgressiveProgress {
  downloadedSec: number;
  totalSec: number;
  bytes: number;
  percent: number;
}

/**
 * Downloads a media playlist's chunks in timeline order, appending to one
 * growing .ts file — the proxy media. A lookahead window keeps throughput up
 * while appends stay strictly in order; a small reorder buffer absorbs
 * out-of-order chunk arrivals. Chunk failures retry 3× then abort with the
 * failing URL — a silent gap would corrupt the proxy timeline from that
 * point on, so failing loudly is the honest behavior.
 */
export async function downloadProgressive(
  playlistUrl: string,
  destPath: string,
  opts: {
    onProgress: (p: ProgressiveProgress) => void;
    signal?: AbortSignal | undefined;
    /** Fetch-ahead window size (default 3). */
    lookahead?: number;
    /** Resume: seconds already on disk from a previous run. Chunks fully
     *  below this point are skipped (not re-fetched); the file opens for
     *  append and onProgress reports cumulative seconds (existing + new) so
     *  the frontier never regresses. Default 0 = fresh download. */
    resumeSec?: number;
    /** Per-chunk byte offsets written so far — [index, byteOffset] pairs
     *  appended as chunks land in the file. The HLS chunk proxy uses these
     *  to serve downloaded chunks from disk (single fetch for both the
     *  player and the downloader). Missing entry = chunk not on disk. */
    onChunk?: (index: number, byteOffset: number, byteLength: number) => void;
  },
): Promise<void> {
  const playlist = await fetchPlaylist(playlistUrl);
  const chunks = parseMediaPlaylist(playlist, playlistUrl);
  if (chunks.length === 0) throw new Error("Media playlist has no chunks");

  const totalSec = chunks.reduce((s, c) => s + c.durationSec, 0);
  const lookahead = Math.max(1, opts.lookahead ?? 3);
  const resumeSec = Math.max(0, opts.resumeSec ?? 0);
  // First chunk index not fully covered by the on-disk prefix. A chunk
  // straddling resumeSec is re-fetched — TS is append-friendly, so that's
  // safe and keeps the logic simple.
  let skippedSec = 0;
  let firstIndex = 0;
  while (firstIndex < chunks.length && skippedSec + chunks[firstIndex]!.durationSec <= resumeSec + 1e-6) {
    skippedSec += chunks[firstIndex]!.durationSec;
    firstIndex++;
  }
  const resuming = firstIndex > 0;
  const dest = await Deno.open(destPath, {
    write: true, create: true, append: resuming, truncate: !resuming,
  });
  let bytes = 0;
  let downloadedSec = skippedSec;

  try {
    let nextFetchIndex = firstIndex;
    let nextWriteIndex = firstIndex;
    const inFlight = new Map<number, Promise<{ index: number; data: Uint8Array }>>();
    const reorderBuffer = new Map<number, { index: number; data: Uint8Array }>();

    const fetchOne = (index: number): Promise<{ index: number; data: Uint8Array }> => {
      const chunk = chunks[index]!;
      return fetchWithRetry(chunk.url, opts.signal).then(async (res) => ({
        index,
        data: new Uint8Array(await res.arrayBuffer()),
      }));
    };

    while (nextWriteIndex < chunks.length) {
      if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");
      // Fill the lookahead window.
      while (nextFetchIndex < chunks.length && inFlight.size < lookahead) {
        const index = nextFetchIndex++;
        inFlight.set(index, fetchOne(index));
      }
      // Wait for the next in-order chunk (or anything after it, buffered).
      const winnerIndex = await Promise.race(
        [...inFlight.entries()].map(([index, p]) => p.then(() => index)),
      );
      const done = (await inFlight.get(winnerIndex!))!;
      inFlight.delete(winnerIndex!);
      if (done.index === nextWriteIndex) {
        reorderBuffer.set(done.index, done);
      } else {
        reorderBuffer.set(done.index, done);
      }
      // Drain everything now in order.
      while (reorderBuffer.has(nextWriteIndex)) {
        const ready = reorderBuffer.get(nextWriteIndex)!;
        reorderBuffer.delete(nextWriteIndex);
        await dest.write(ready.data);
        const chunkOffset = bytes;
        bytes += ready.data.byteLength;
        downloadedSec += chunks[ready.index]!.durationSec;
        opts.onChunk?.(ready.index, chunkOffset, ready.data.byteLength);
        opts.onProgress({
          downloadedSec,
          totalSec,
          bytes,
          percent: downloadedSec / totalSec,
        });
        nextWriteIndex++;
      }
    }
  } finally {
    dest.close();
  }
}

async function fetchPlaylist(url: string): Promise<string> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`playlist fetch ${res.status}: ${url}`);
  return res.text();
}

async function fetchWithRetry(url: string, signal?: AbortSignal, attempts = 3): Promise<Response> {
  let lastErr: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      const res = await fetch(url, { signal: signal ?? null });
      if (!res.ok) throw new Error(`chunk ${res.status}`);
      return res;
    } catch (err) {
      if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
      lastErr = err;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  throw new Error(`chunk failed after ${attempts} attempts: ${url} (${lastErr})`);
}