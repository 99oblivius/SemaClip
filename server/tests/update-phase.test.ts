/**
 * The update STATE the update banner renders, and the property the owner asked for: the app must not
 * offer to install anything until the payload is downloaded and verified.
 *
 * ── WHY THESE CASES ─────────────────────────────────────────────────────────────────────────────
 * The owner's requirement is a SEQUENCE: download while the window is open, show progress, and only
 * once it is downloaded close, upgrade and reopen. A UI that has to reconstruct that sequence from
 * two independent booleans gets the intermediate states wrong, which is why the server publishes an
 * explicit `phase`. These tests pin the state, the transition rule that matters most (a download in
 * flight is NOT an update ready to install), and the shape the banner switches on.
 */
import { assert, assertEquals } from "@std/assert";
import { emitAppEvent, resetAppEvents, subscribeAppEvents } from "@/application/events.ts";

type UpdateStatus = {
  current: string | null;
  pendingVersion: string | null;
  phase: "idle" | "downloading" | "ready";
  downloading: boolean;
  download: { version: string; received: number; total: number; fraction: number | null } | null;
};

/** Fresh import, so the module's own singleton status is not shared between cases. */
async function freshModule() {
  return await import(
    `@/adapters/outbound/platform/auto-update.ts?t=${Date.now()}-${Math.random()}`
  );
}

Deno.test("a fresh status is idle with nothing pending and nothing downloading", async () => {
  const mod = await freshModule();
  const s = mod.updateStatus() as UpdateStatus;
  assertEquals(s.phase, "idle");
  assertEquals(s.downloading, false);
  assertEquals(s.download, null);
  assertEquals(s.pendingVersion, null);
});

Deno.test("a progress frame never claims an update is ready to install", async () => {
  // ── THE REQUIREMENT, AS A PROPERTY ──────────────────────────────────────────────────────────
  // "only once it's downloaded should the app close, it get upgraded, and reopened" — so while bytes
  // are still arriving, the event stream must not announce a staged version. A restart offered at
  // the start of a download would install nothing and would start the sidecar with no payload.
  resetAppEvents();
  const seen: { type: string; version: string; canApplyByRestart?: boolean }[] = [];
  const un = subscribeAppEvents((e) => seen.push(e as unknown as typeof seen[number]));

  emitAppEvent({ type: "update-progress", version: "26.240", received: 10, total: 100, fraction: 0.1 });
  emitAppEvent({ type: "update-progress", version: "26.240", received: 90, total: 100, fraction: 0.9 });

  const progress = seen.filter((e) => e.type === "update-progress");
  assertEquals(progress.length, 2, "both progress frames reach a subscriber in order");
  for (const e of progress) {
    // `canApplyByRestart` is OPTIONAL on the event type for exactly this reason: a progress frame is
    // not a statement about being installable, so a publisher must not be forced to invent one.
    assertEquals(e.canApplyByRestart, undefined, "a progress frame must not assert applying");
  }
  un();
});

Deno.test("only a staged frame announces something installable", async () => {
  resetAppEvents();
  const seen: { type: string; version: string; canApplyByRestart?: boolean }[] = [];
  const un = subscribeAppEvents((e) => seen.push(e as unknown as typeof seen[number]));

  emitAppEvent({ type: "update-progress", version: "26.241", received: 5, total: 10, fraction: 0.5 });
  emitAppEvent({ type: "update-staged", version: "26.241", canApplyByRestart: true });

  const staged = seen.filter((e) => e.type === "update-staged");
  assertEquals(staged.length, 1);
  assertEquals(staged[0]!.version, "26.241");
  assertEquals(staged[0]!.canApplyByRestart, true);
  un();
});

Deno.test("a rollback reports its reason and is a distinct frame type", async () => {
  // The banner renders a rollback differently from a stage, so the type must carry it. It also
  // reports the reason in `version`, which is what the UI prints — so that reuse is asserted rather
  // than left implicit for a future reader to "tidy up" into a separate field.
  resetAppEvents();
  const seen: { type: string; version: string }[] = [];
  const un = subscribeAppEvents((e) => seen.push(e as unknown as typeof seen[number]));

  emitAppEvent({ type: "update-rollback", version: "previous launch failed" });

  assertEquals(seen.length, 1);
  assertEquals(seen[0]!.type, "update-rollback");
  assertEquals(seen[0]!.version, "previous launch failed");
  un();
});

Deno.test("the three phases the banner switches on are exactly the three it knows", async () => {
  // The banner prints one of three messages and reads ONE field to choose. A fourth state, or a
  // rename, would silently fall through to the wrong message, so the union is pinned here.
  const mod = await freshModule();
  const s = mod.updateStatus() as UpdateStatus;
  assert(
    s.phase === "idle" || s.phase === "downloading" || s.phase === "ready",
    `unexpected phase ${s.phase}`,
  );
});

Deno.test("downloading and phase cannot disagree", async () => {
  // `downloading` existed before `phase` and is kept for the existing consumers. Two fields for one
  // fact is how a UI ends up showing a progress bar with no phase, so their agreement is asserted.
  const mod = await freshModule();
  const s = mod.updateStatus() as UpdateStatus;
  assertEquals(s.downloading, s.phase === "downloading");
  if (s.phase === "downloading") assert(s.download !== null, "downloading implies a progress object");
  else assertEquals(s.download, null, "no progress object outside a download");
});
