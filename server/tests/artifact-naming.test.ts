/**
 * Artifact naming tests.
 *
 * Names appear in a folder the user browses, so they must be safe, stable,
 * bounded, and say what they hold. A bad slug means a file that cannot be
 * created on Windows or a folder that collides with itself.
 */
import { assert, assertEquals } from "@std/assert";
import {
  artifactName,
  indexPathFor,
  MAX_SLUG_LENGTH,
  slugify,
  streamSlug,
  uniqueName,
  vodFolderName,
  vodTimestamp,
} from "@/application/use-cases/artifact-naming.ts";

Deno.test("slugify: no whitespace, no unsafe characters", () => {
  assertEquals(slugify("I hope it's not a scary game again..."), "i-hope-it-s-not-a-scary-game-again");
  assertEquals(slugify("🔥[!DROPS] BLIZZCON COUNTDOWN: 7 DAYS🔥"), "drops-blizzcon-countdown-7-days");
  assertEquals(slugify("a/b\\c:d*e?f\"g<h>i|j"), "a-b-c-d-e-f-g-h-i-j");
});

Deno.test("slugify: accented titles fold to ASCII rather than separators", () => {
  assertEquals(slugify("Café Pokémon"), "cafe-pokemon");
});

Deno.test("slugify: bounded length, never a trailing separator", () => {
  const long = slugify("x".repeat(200));
  assertEquals(long.length, MAX_SLUG_LENGTH);
  const trailing = slugify("a".repeat(MAX_SLUG_LENGTH) + " b c d e f g");
  assert(!trailing.endsWith("-"), `slug must not end with '-': ${trailing}`);
});

Deno.test("slugify: degenerate input yields an empty slug (caller falls back)", () => {
  assertEquals(slugify(""), "");
  assertEquals(slugify("   "), "");
  assertEquals(slugify("!!!///"), "");
  assertEquals(slugify("---"), "");
});

Deno.test("streamSlug: title, then streamer, then id prefix", () => {
  assertEquals(streamSlug({ id: "abcdef12-3456", title: "Great Stream" }), "great-stream");
  assertEquals(streamSlug({ id: "abcdef12-3456", title: null, streamer: "Pyromancer" }), "pyromancer");
  // An untitled import with no streamer still gets a usable, unique name.
  assertEquals(streamSlug({ id: "abcdef12-3456", title: "!!!", streamer: "" }), "stream-abcdef12");
});

Deno.test("artifactName: role-specific, whitespace-free, distinct per role", () => {
  const slug = "great-stream";
  const video = artifactName("video", slug);
  const proxy = artifactName("proxy", slug);
  const chat = artifactName("chat", slug);
  assertEquals(video, "great-stream - video.mp4");
  assertEquals(proxy, "great-stream - proxy.mp4");
  assertEquals(chat, "great-stream.chat.json");
  // Distinct files — one must never overwrite another.
  assertEquals(new Set([video, proxy, chat]).size, 3);
  for (const n of [video, proxy, chat]) {
    assert(!/\s{2,}/.test(n), "no runs of whitespace");
    assert(!/[<>:"/\\|?*]/.test(n), "no characters illegal on Windows");
  }
});

Deno.test("indexPathFor: the sidecar tracks its media file", () => {
  assertEquals(indexPathFor("/d/great-stream - video.mp4"), "/d/great-stream - video.fragments");
  assertEquals(indexPathFor("/d/great-stream - proxy.mp4"), "/d/great-stream - proxy.fragments");
});

// ── Project folder names ──────────────────────────────────────────────────

Deno.test("vodFolderName: streamer, game and the VOD's own date", () => {
  // The VOD's creation time is UTC in the record; the folder renders LOCAL time, so the
  // expectation is derived the same way rather than hardcoded to one timezone.
  const created = new Date("2026-09-18T20:26:03.294Z");
  const stamp = vodTimestamp(created);
  // NOTE the underscores: the real streamer is `sporadic__movement`, and slugify maps `_`
  // to `-` like any other non-alphanumeric run. That is the intended sanitisation (the
  // folder stays shell- and URL-safe), so the expectation is the sanitised name.
  assertEquals(
    vodFolderName({ streamer: "sporadic__movement", game: "Dead by Daylight", createdAt: created }),
    `sporadic-movement-dead-by-daylight-${stamp}`,
  );
  // Shape, independently of the local clock: the FULL folder name ends in a
  // `YYYY-MM-DD-HHmm` stamp — asserted on the name, not on the stamp alone.
  assert(
    /^sporadic-movement-dead-by-daylight-\d{4}-\d{2}-\d{2}-\d{4}$/.test(
      vodFolderName({ streamer: "sporadic__movement", game: "Dead by Daylight", createdAt: created }),
    ),
  );
  assert(/^\d{4}-\d{2}-\d{2}-\d{4}$/.test(stamp!), `the stamp alone is date-time: ${stamp}`);
});

Deno.test("vodFolderName: the same VOD always yields the same name", () => {
  const when = new Date("2026-09-18T20:26:03.294Z");
  const a = vodFolderName({ streamer: "SoulCamera", game: "Just Chatting", createdAt: when });
  const b = vodFolderName({ streamer: "SoulCamera", game: "Just Chatting", createdAt: when.toISOString() });
  assertEquals(a, b, "re-importing a VOD must reuse its folder, not create a second copy");
});

Deno.test("vodFolderName: a part that sanitises to nothing is OMITTED, not left empty", () => {
  const when = new Date("2026-09-20T04:34:10.672Z");
  const stamp = vodTimestamp(when)!;
  assertEquals(vodFolderName({ streamer: "LeyLey", game: null, createdAt: when }), `leyley-${stamp}`);
  assertEquals(vodFolderName({ streamer: "LeyLey", game: "!!!", createdAt: when }), `leyley-${stamp}`);
  assertEquals(vodFolderName({ streamer: "", game: "Minecraft", createdAt: when }), `minecraft-${stamp}`);
  assert(!vodFolderName({ streamer: "LeyLey", game: null, createdAt: when }).includes("--"));
});

Deno.test("vodFolderName: unsafe characters never reach the filesystem", () => {
  const name = vodFolderName({
    streamer: "Nova/Star",
    game: 'A:B*C?D"E<F>G|H\\I',
    createdAt: new Date("2026-09-20T00:00:00Z"),
  });
  assert(!/[<>:"/\\|?*]/.test(name), `must contain no Windows-illegal characters: ${name}`);
  assert(!/\s{2,}/.test(name), "no runs of whitespace");
  assert(!name.includes(" "), `no spaces at all: ${name}`);
});

Deno.test("vodFolderName: each part is capped independently", () => {
  const longStreamer = "s".repeat(120);
  const longGame = "g".repeat(120);
  const name = vodFolderName({ streamer: longStreamer, game: longGame, createdAt: new Date("2026-09-20T00:00:00Z") });
  const [streamerPart, gamePart] = name.split("-");
  assertEquals(streamerPart!.length, 60, "a long streamer name must be capped");
  assertEquals(gamePart!.length, 60, "a long game name must not eat the streamer's budget");
});

Deno.test("vodFolderName: degenerate input still yields a usable folder name", () => {
  assertEquals(vodFolderName({ id: "66a6bc0a-d90d-450c-8f3b-c5e2348a677a" }), "vod-66a6bc0a");
  assertEquals(vodFolderName({ id: "" }), "vod");
  // A date-less import still names itself from what it has.
  assertEquals(vodFolderName({ streamer: "LeyLey", id: "abcdef12" }), "leyley");
});

Deno.test("vodTimestamp: an unusable date is null, not 'NaN-NaN-NaN'", () => {
  assertEquals(vodTimestamp(null), null);
  assertEquals(vodTimestamp(undefined), null);
  assertEquals(vodTimestamp(""), null);
  assertEquals(vodTimestamp("not a date"), null);
  const d = new Date(2026, 0, 5, 9, 7); // local 2026-01-05 09:07
  assertEquals(vodTimestamp(d), "2026-01-05-0907");
});

Deno.test("uniqueName: free name unchanged, taken name suffixed -2, -3", () => {
  assertEquals(uniqueName("a-b", []), "a-b");
  assertEquals(uniqueName("a-b", ["other"]), "a-b");
  assertEquals(uniqueName("a-b", ["a-b"]), "a-b-2");
  assertEquals(uniqueName("a-b", ["A-B", "a-b-2"]), "a-b-3", "collision check is case-insensitive");
});

Deno.test("uniqueName: never hands back a name that is already in use", () => {
  const taken = ["x", "x-2", "x-3", "x-4"];
  const chosen = uniqueName("x", taken);
  assert(!taken.includes(chosen), `returned a colliding name: ${chosen}`);
  assertEquals(chosen, "x-5");
});
