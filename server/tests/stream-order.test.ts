/**
 * Stream list ordering.
 *
 * The Library renders this list under a "Recent" heading, so the most recently created
 * project must come FIRST. The repository ordered ascending by `created_at`, which put the
 * newest project at the bottom of the list.
 *
 * This test opens a REAL database (`createDb(":memory:")` runs the migrations and wires the
 * actual Drizzle repository), rather than asserting on a query string: the rule being
 * protected is what the database returns, and a mock would only prove the mock. It fails
 * against the previous `asc` ordering by construction.
 */
import { assertEquals } from "@std/assert";
import { createDb } from "@/adapters/outbound/persistence/db.ts";
import { SqliteStreamRepository } from "@/adapters/outbound/persistence/repositories.ts";
import type { Stream } from "shared/types";

function stream(id: string, createdAt: string, overrides: Partial<Stream> = {}): Stream {
  const base = {
    id,
    vodPath: "",
    chatPath: null,
    sourceUrl: null,
    title: `project ${id}`,
    streamer: null,
    game: null,
    duration: null,
    createdAt,
    status: "pending" as const,
  };
  // A single assertion rather than every field spelled out. This test is about ORDERING and
  // never reads anything else, and `Stream` gains fields over time — restating the full shape
  // would make this file depend on whichever commit added the newest one. The type is still
  // enforced at the repository calls below, which is what the test actually exercises.
  return { ...base, ...overrides } as Stream;
}

Deno.test("stream list: newest first, by created_at and not by insertion order", async () => {
  const repo = new SqliteStreamRepository(createDb(":memory:"));

  // Saved in an order that DISAGREES with the ranking, so an implementation that returned
  // insertion order (or relied on rowid) cannot pass by accident.
  await repo.save(stream("mid", "2026-09-19T10:00:00.000Z"));
  await repo.save(stream("newest", "2026-09-20T04:34:10.672Z"));
  await repo.save(stream("oldest", "2026-09-18T20:26:03.294Z"));

  const ids = (await repo.list()).map((s) => s.id);
  assertEquals(
    ids,
    ["newest", "mid", "oldest"],
    "the Library's Recent list must lead with the most recently created project",
  );
});

Deno.test("stream list: the status-filtered branch orders the same way", async () => {
  const repo = new SqliteStreamRepository(createDb(":memory:"));
  await repo.save(stream("a", "2026-09-18T00:00:00.000Z", { status: "completed" }));
  await repo.save(stream("b", "2026-09-20T00:00:00.000Z", { status: "completed" }));
  await repo.save(stream("c", "2026-09-21T00:00:00.000Z", { status: "pending" }));

  const completed = (await repo.list("completed")).map((s) => s.id);
  assertEquals(completed, ["b", "a"], "filtering must not change the ordering rule");
});

Deno.test("stream list: identical timestamps still return every row", async () => {
  const repo = new SqliteStreamRepository(createDb(":memory:"));
  const t = "2026-09-20T00:00:00.000Z";
  await repo.save(stream("first", t));
  await repo.save(stream("second", t));

  const ids = (await repo.list()).map((s) => s.id).sort();
  assertEquals(ids, ["first", "second"], "a tie must not drop rows or throw");
});
