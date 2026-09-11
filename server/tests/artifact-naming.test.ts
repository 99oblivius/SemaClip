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
