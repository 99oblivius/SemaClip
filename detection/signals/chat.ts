/**
 * Chat signal extraction: TwitchDownloader events → per-second features.
 * O(n) over events; output is a per-second array of length durationSec.
 *
 * System/notice messages (sub-gift trains, resubs, raids) are excluded:
 * they are Twitch notifications, not chat. On a subathon fixture, gift
 * trains hit 30 msg/s sustained — counting them would (a) poison the
 * adaptive floor so organic bursts stop registering, and (b) flag every
 * gift flood as a hype candidate. Measured: 16% of messages on the 4h
 * ironmouse fixture.
 */
import type { ChatEvent, ChatFeaturesSec } from "../types.ts";
import { EMOTE_WEIGHTS } from "../chat.ts";

const NOTICE_PATTERNS = [
  /gifted a (tier \d+ )?sub/i,
  /is gifting \d+ subs/i,
  /gifted \d+ \w+ subs to/i,
  /subscribed (at|for)/i,
  /is raiding/i,
  /added \d+ (bits|bonus)/i,
  /cheered \d+ bits/i,
  /pledged/i,
];

export function isNoticeMessage(body: string): boolean {
  return NOTICE_PATTERNS.some((p) => p.test(body));
}

export function chatFeatures(events: ChatEvent[], durationSec: number): ChatFeaturesSec[] {
  const table: ChatFeaturesSec[] = Array.from({ length: durationSec }, () => ({
    velocity: 0, emoteDensity: 0, uniqueUsers: 0, capsRatio: 0, bits: 0,
  }));
  const seenPerSec = new Map<number, Set<string>>();
  const emoteSum = new Float64Array(durationSec);
  const capsSum = new Float64Array(durationSec);
  const lenSum = new Float64Array(durationSec);

  for (const e of events) {
    if (isNoticeMessage(e.body)) continue;
    const sec = Math.min(durationSec - 1, Math.max(0, Math.floor(e.t)));
    const row = table[sec]!;
    row.velocity++;
    row.bits += e.bitsSpent;

    let seen = seenPerSec.get(sec);
    if (!seen) { seen = new Set(); seenPerSec.set(sec, seen); }
    seen.add(e.user);

    emoteSum[sec]! += messageEmoteScore(e.body);
    const caps = capsStats(e.body);
    capsSum[sec]! += caps.capsChars;
    lenSum[sec]! += caps.totalChars;
  }

  for (let s = 0; s < durationSec; s++) {
    const row = table[s]!;
    row.emoteDensity = emoteSum[s]!;
    const users = seenPerSec.get(s);
    row.uniqueUsers = users ? users.size : 0;
    const totalChars = lenSum[s]!;
    row.capsRatio = totalChars > 0 ? Math.min(1, capsSum[s]! / totalChars) : 0;
  }
  return table;
}

/**
 * Emote-weighted excitement score of a message body.
 * Whole-token matches sum their weights; an emote-only body gets a purity
 * bonus (a bare "KEKW" is a stronger unit than a sentence containing KEKW).
 */
export function messageEmoteScore(body: string): number {
  let sum = 0;
  let count = 0;
  const tokens = body.toUpperCase().split(/\s+/);
  for (const [emote, weight] of Object.entries(EMOTE_WEIGHTS)) {
    if (tokens.includes(emote.toUpperCase())) {
      sum += weight;
      count++;
    }
  }
  if (count === 0) return 0;
  const words = Math.max(1, body.trim().split(/\s+/).length);
  return count >= words - 1 ? sum * 1.2 : sum;
}

/** Character-level caps stats (exported for tests). */
export function capsStats(body: string): { capsChars: number; totalChars: number; ratio: number } {
  const letters = body.replace(/[^a-zA-Z]/g, "");
  if (!letters) return { capsChars: 0, totalChars: 0, ratio: 0 };
  const caps = letters.replace(/[^A-Z]/g, "").length;
  return { capsChars: caps, totalChars: letters.length, ratio: caps / letters.length };
}