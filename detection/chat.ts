/**
 * TwitchDownloader chat JSON parsing → typed chat events.
 *
 * Input format (verified against data/training/chat.json, TwitchDownloader
 * v1.4 export):
 *   { FileInfo, streamer: {name, login, id}, video: {title, id, length,
 *     game, chapters[]}, comments: [...], embeddedData }
 *   comment = { _id, content_offset_seconds, commenter: {display_name},
 *               message: { body, fragments[], emoticons[], user_badges[] } }
 *
 * The parser is defensive: unknown shapes are skipped and counted, never
 * thrown — a partial chat export must still yield usable signal.
 */
import type { ChatEvent } from "./types.ts";

/** Well-known Twitch emotes weighted for the excitement signal (ARCH §7.1). */
const EMOTE_WEIGHTS: Record<string, number> = {
  // hype / pog
  POGGERS: 1.0, PogChamp: 0.9, Pog: 0.9, HYPE: 0.9, LetsGo: 0.8, LetsGooo: 0.95,
  // laughter
  OMEGALUL: 0.9, LUL: 0.8, LULW: 0.8, KEKW: 0.9, HAHAHA: 0.7, haHAA: 0.7,
  // awe / skill
  SHEEESH: 0.85, SHEESH: 0.85, PepegaAim: 0.4, Clap: 0.8,
  // negative / awkward
  RESIDENTSLEEPER: -0.8, ResidentSleeper: -0.8, Sadge: -0.5, PepeHands: -0.6, monkaS: 0.85, MonkaS: 0.85,
  // skull/emoji laughter (text form)
  "💀": 0.8, "😭": 0.6, "🔥": 0.8,
};

export interface ParsedChat {
  /** Sorted-by-time chat events. */
  events: ChatEvent[];
  /** Streamer login from FileInfo/video block (may be null). */
  streamer: string | null;
  /** Video duration in seconds (from the video block; authoritative). */
  durationSec: number | null;
  /** Game name (first GAME_CHANGE chapter). */
  game: string | null;
  /** Chapters with second offsets — future regime hints. */
  chapters: Array<{ startSec: number; lengthSec: number; description: string }>;
  skipped: number;
  warnings: string[];
}

export function parseTwitchChatJson(raw: string): ParsedChat {
  const data = JSON.parse(raw) as Record<string, unknown>;
  const warnings: string[] = [];

  const comments = data.comments;
  if (!Array.isArray(comments)) {
    throw new Error("Chat JSON has no comments array — not TwitchDownloader format");
  }

  // TwitchDownloader-compatible shape: duration falls back to the max
  // comment offset when the fuller `video.length` field is absent (the GQL
  // chat fetcher writes only comments; duration comes from stream metadata).
  const video = (data.video ?? {}) as Record<string, unknown>;
  let durationSec = typeof video.length === "number" ? video.length : null;
  if (durationSec === null) {
    let maxT = 0;
    for (const c of Array.isArray(comments) ? comments : []) {
      const t = (c as Record<string, unknown>).content_offset_seconds;
      if (typeof t === "number" && Number.isFinite(t) && t > maxT) maxT = t;
    }
    durationSec = maxT > 0 ? Math.ceil(maxT) : null;
  }

  const streamerObj = (data.streamer ?? {}) as Record<string, unknown>;
  const streamer = typeof streamerObj.login === "string" ? streamerObj.login : null;

  const chapters: ParsedChat["chapters"] = [];
  const rawChapters = video.chapters;
  if (Array.isArray(rawChapters)) {
    for (const ch of rawChapters) {
      const c = ch as Record<string, unknown>;
      if (typeof c.startMilliseconds === "number" && typeof c.lengthMilliseconds === "number") {
        chapters.push({
          startSec: c.startMilliseconds / 1000,
          lengthSec: c.lengthMilliseconds / 1000,
          description: typeof c.description === "string" ? c.description : "",
        });
      }
    }
  }

  let skipped = 0;
  const events: ChatEvent[] = [];
  for (const c of comments) {
    try {
      const comment = c as Record<string, unknown>;
      const t = comment.content_offset_seconds;
      if (typeof t !== "number" || !Number.isFinite(t) || t < 0) {
        skipped++;
        continue;
      }
      const message = (comment.message ?? {}) as Record<string, unknown>;
      const body = typeof message.body === "string" ? message.body : "";
      if (!body) {
        skipped++;
        continue;
      }
      const commenter = (comment.commenter ?? {}) as Record<string, unknown>;
      const user = typeof commenter.display_name === "string" ? commenter.display_name : "unknown";

      const isEmoteOnly = (message.fragments as unknown[] | undefined)?.every?.(
        (f) => typeof f === "object" && f !== null && (f as Record<string, unknown>).emoticon !== null,
      ) ?? false;
      const bitsSpent = typeof message.bits_spent === "number" ? message.bits_spent : 0;

      events.push({ t, user, body, isEmoteOnly: isEmoteOnly || isEmoteOnlyText(body), bitsSpent });
    } catch {
      skipped++;
    }
  }
  events.sort((a, b) => a.t - b.t);

  if (skipped > 0) warnings.push(`${skipped} comments skipped (malformed or missing offset)`);
  if (durationSec === null) warnings.push("video.length missing — duration falls back to max comment offset");

  return { events, streamer, durationSec, game: null, chapters, skipped, warnings };
}

/** Text-form emote-only bodies ("KEKW", "💀", "LULW") count as emote messages. */
function isEmoteOnlyText(body: string): boolean {
  const trimmed = body.trim();
  if (!trimmed) return false;
  // Single token made of known emote chars or the skull/laugh emoji set.
  return /^[\p{Extended_Pictographic}\u200d\ufe0f]+$/u.test(trimmed) ||
    /^(KEKW|LULW?|OMEGALUL|POGGERS|SHEEESH|Clap|Sadge|monkaS|MonkaS)$/i.test(trimmed);
}

export { EMOTE_WEIGHTS };