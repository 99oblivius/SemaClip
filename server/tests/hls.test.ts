import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  extractVodId,
  parseMasterPlaylist,
  parseMediaPlaylist,
  pickProxyQuality,
  pickBestQuality,
} from "@/adapters/outbound/vod/hls.ts";
import type { HlsQuality } from "@/adapters/outbound/vod/hls.ts";

describe("extractVodId", () => {
  it("extracts from full URLs", () => {
    assert.equal(extractVodId("https://www.twitch.tv/videos/123456789"), "123456789");
    assert.equal(extractVodId("twitch.tv/videos/987"), "987");
  });

  it("accepts bare ids, rejects garbage", () => {
    assert.equal(extractVodId("2867755087"), "2867755087");
    assert.equal(extractVodId("https://twitch.tv/ironmouse"), null);
    assert.equal(extractVodId("no digits 42"), null);
  });
});

const MASTER = `#EXTM3U
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="chunked",NAME="1080p60",AUTOSELECT=NO,DEFAULT=NO
#EXT-X-STREAM-INF:BANDWIDTH=7414180,CODECS="avc1.64002A,mp4a.40.2",RESOLUTION=1920x1080,VIDEO="chunked",FRAME-RATE=59.998
https://example.com/chunked/index.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="720p60",NAME="720p60",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=3429464,CODECS="avc1.4D4020,mp4a.40.2",RESOLUTION=1280x720,VIDEO="720p60",FRAME-RATE=59.998
https://example.com/720p60/index.m3u8
#EXT-X-MEDIA:TYPE=VIDEO,GROUP-ID="480p30",NAME="480p",AUTOSELECT=YES,DEFAULT=YES
#EXT-X-STREAM-INF:BANDWIDTH=1448209,CODECS="avc1.4D401F,mp4a.40.2",RESOLUTION=852x480,VIDEO="480p30",FRAME-RATE=30.000
https://example.com/480p30/index.m3u8
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="audio_only",NAME="audio_only",AUTOSELECT=YES
#EXT-X-STREAM-INF:BANDWIDTH=65000,CODECS="mp4a.40.2",AUDIO="audio_only"
https://example.com/audio/index.m3u8`;

describe("parseMasterPlaylist", () => {
  it("parses qualities with resolution, fps, bandwidth, and display names", () => {
    const q = parseMasterPlaylist(MASTER);
    assert.equal(q.length, 3); // audio-only skipped
    assert.deepEqual(
      q.map((x) => x.name),
      ["1080p60", "720p60", "480p"],
    );
    assert.equal(q[0]!.height, 1080);
    assert.equal(q[0]!.fps > 59 && q[0]!.fps < 60, true);
    assert.equal(q[2]!.name, "480p"); // NAME attribute, not GROUP-ID
  });

  it("returns empty on garbage", () => {
    assert.deepEqual(parseMasterPlaylist("not a playlist"), []);
  });
});

describe("quality pickers", () => {
  const q = parseMasterPlaylist(MASTER);

  it("proxy = highest ≤ cap", () => {
    assert.equal(pickProxyQuality(q, 540)?.name, "480p");
    assert.equal(pickProxyQuality(q, 720)?.name, "720p60");
    assert.equal(pickProxyQuality(q, 1080)?.name, "1080p60");
  });

  it("proxy falls back to lowest available when all exceed the cap", () => {
    assert.equal(pickProxyQuality(q, 200)?.name, "480p");
    assert.equal(pickProxyQuality([], 540), null);
  });

  it("best = highest ≤ cap, falling back to highest overall", () => {
    assert.equal(pickBestQuality(q, 720)?.name, "720p60");
    assert.equal(pickBestQuality(q, null)?.name, "1080p60");
    assert.equal(pickBestQuality(q, 100)?.name, "480p"); // degrade, not fail
  });

  it("orientation: portrait source picks by height too", () => {
    const portrait: HlsQuality[] = [
      { name: "1080x1920", width: 1080, height: 1920, fps: 60, bandwidth: 8e6, playlistUrl: "a" },
      { name: "540x960", width: 540, height: 960, fps: 30, bandwidth: 3e6, playlistUrl: "b" },
    ];
    assert.equal(pickBestQuality(portrait, 1920)?.name, "1080x1920");
    assert.equal(pickProxyQuality(portrait, 540)?.name, "540x960"); // lowest available fallback
  });
});

describe("parseMediaPlaylist", () => {
  it("resolves relative chunk URLs and accumulates EXTINF durations", () => {
    const text = `#EXTM3U
#EXT-X-TARGETDURATION:12
#EXTINF:11.266,
0.ts
#EXT-X-PROGRAM-DATE-TIME:2026-09-07T13:08:35.988Z
#EXTINF:10.000,
1.ts
#EXT-X-ENDLIST`;
    const chunks = parseMediaPlaylist(text, "https://cdn.example/x/720p60/index.m3u8");
    assert.equal(chunks.length, 2);
    assert.equal(chunks[0]!.url, "https://cdn.example/x/720p60/0.ts");
    assert.equal(chunks[0]!.durationSec, 11.266);
    assert.equal(chunks[1]!.durationSec, 10.0);
  });

  it("keeps absolute URLs", () => {
    const chunks = parseMediaPlaylist("#EXTINF:5,\nhttps://other.cdn/5.ts", "https://x/y.m3u8");
    assert.equal(chunks[0]!.url, "https://other.cdn/5.ts");
  });
});