/**
 * The `exported` mark describes the LAST ATTEMPT, and dies with it.
 *
 * ── WHY THIS EXISTS ──────────────────────────────────────────────────────────────────────────
 * Two reported behaviours, one rule:
 *
 *  - removing a clip from the export list with its ✕ left the clip marked `exported`, so a
 *    `✓ exported` badge sat beside a clip the user had just withdrawn. The badge then travels: the
 *    clip list is invalidated by the export event, and `clips.exported` is what the UI reads.
 *  - re-sending a clip (Export this clip, or Export all) REPLACES its file, so the previous run's
 *    mark is stale while the new encode runs — and if the new one never finishes, the mark stays up
 *    describing a file that was overwritten.
 *
 * The FILE is never deleted by either path: the export is the user's, and a list edit must not
 * destroy it. That distinction is asserted below, because "clear the mark" is the kind of fix that
 * gets over-applied into "delete the output".
 */
import { assertEquals, assert } from "@std/assert";
import { ClearExportedMarkUseCase } from "../application/use-cases/ClipUseCases.ts";
import { markNotExported } from "../domain/Clip.ts";
import type { Clip } from "shared/types";
import type { ClipRepository } from "../application/ports/outbound.ts";

function clip(over: Partial<Clip> = {}): Clip {
  return {
    id: "c1", streamId: "s1", startTime: 10, endTime: 40, peakTime: 20,
    justification: null, title: "Take One", rank: 1, exported: true,
    exportPath: "/exports/vod/clip.mp4", rejected: false, signals: null,
    ...over,
  } as Clip;
}

/** The repository, recording every write so "did it touch the file?" is answerable. */
function repoFor(initial: Clip | null) {
  const writes: Clip[] = [];
  const repo = {
    findById: () => Promise.resolve(initial),
    update: (c: Clip) => { writes.push(c); return Promise.resolve(c); },
  } as unknown as ClipRepository;
  return { repo, writes };
}

Deno.test("removing a clip from the list drops its `exported` mark", async () => {
  const { repo, writes } = repoFor(clip());
  await new ClearExportedMarkUseCase(repo).execute("c1");
  assertEquals(writes.length, 1, "the mark must be written once");
  assertEquals(writes[0]?.exported, false);
  assertEquals(writes[0]?.exportPath, null);
});

Deno.test("the FILE is untouched — only the mark is cleared", async () => {
  // The over-application this guards against: clearing the badge must not delete the artifact, and
  // the use case has no file-system port at all, so an implementation that deleted would not compile.
  const { repo, writes } = repoFor(clip({ exportPath: "/exports/vod/keep-me.mp4" }));
  await new ClearExportedMarkUseCase(repo).execute("c1");
  // The clip's other facts are preserved exactly — the update is a mark change, not a rewrite.
  assertEquals(writes[0]?.title, "Take One");
  assertEquals(writes[0]?.startTime, 10);
  assertEquals(writes[0]?.endTime, 40);
  assertEquals(writes[0]?.rank, 1);
});

Deno.test("an already-unmarked clip is not written again", async () => {
  // A list edit that clears the whole list would otherwise issue a write per clip for no change.
  const { repo, writes } = repoFor(clip({ exported: false, exportPath: null }));
  await new ClearExportedMarkUseCase(repo).execute("c1");
  assertEquals(writes.length, 0, "nothing to change, so nothing is written");
});

Deno.test("a HALF-marked clip is repaired (exported true, path null)", async () => {
  // Reachable in the wild: the mark and the path are two columns, and a row written by an older
  // build can disagree. Clearing must consult BOTH, or a stale `exported: true` survives.
  const { repo, writes } = repoFor(clip({ exported: true, exportPath: null }));
  await new ClearExportedMarkUseCase(repo).execute("c1");
  assertEquals(writes.length, 1);
  assertEquals(writes[0]?.exported, false);
});

Deno.test("a clip that no longer exists is skipped, not thrown", async () => {
  // This runs as a side effect of a list or queue edit. A dangling reference must not fail the
  // user's actual action — the removal itself succeeded.
  const { repo, writes } = repoFor(null);
  await new ClearExportedMarkUseCase(repo).execute("gone");
  assertEquals(writes.length, 0);
});

Deno.test("markNotExported is the rule, and it sets BOTH columns", () => {
  // `exported` and `exportPath` are two representations of one fact; leaving either set is how a
  // "cleared" clip still renders as exported somewhere that reads the other column.
  const cleared = markNotExported(clip({ exported: true, exportPath: "/x.mp4" }));
  assertEquals(cleared.exported, false);
  assertEquals(cleared.exportPath, null);
  // And it does not disturb anything else about the clip.
  assertEquals(cleared.id, "c1");
  assertEquals(cleared.title, "Take One");
});
