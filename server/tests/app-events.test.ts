/**
 * App events: the staged-update push.
 *
 * An update stage happens on disk next to the runtime dylib, with no state in our
 * database, so a poll cannot discover it — the UI would only learn about it if the user
 * happened to open Settings. This is the one surface that is pushed, and these tests pin
 * the two properties that make it reliable: a late subscriber is replayed what it missed
 * (the update check runs at boot, before the webview connects), and one broken subscriber
 * cannot stop the others or surface as a server error from a background check.
 */
import { assert, assertEquals } from "@std/assert";
import {
  emitAppEvent,
  resetAppEvents,
  sseFrame,
  subscribeAppEvents,
  type AppEvent,
} from "@/application/events.ts";

function withCleanState(fn: () => void): void {
  resetAppEvents();
  try {
    fn();
  } finally {
    resetAppEvents();
  }
}

Deno.test("a subscriber receives an event emitted after it subscribes", () => {
  withCleanState(() => {
    const seen: AppEvent[] = [];
    subscribeAppEvents((e) => seen.push(e));
    emitAppEvent({ type: "update-staged", version: "26.200", canApplyByRestart: true });
    assertEquals(seen.length, 1);
    assertEquals(seen[0]!.version, "26.200");
    assertEquals(seen[0]!.type, "update-staged");
  });
});

Deno.test("a LATE subscriber is replayed what it missed", () => {
  // The real race: the update check runs during server boot and can finish staging before
  // the webview has connected. Without replay, that user is never told.
  withCleanState(() => {
    emitAppEvent({ type: "update-staged", version: "26.200", canApplyByRestart: true });
    const seen: AppEvent[] = [];
    subscribeAppEvents((e) => seen.push(e));
    assertEquals(seen.length, 1, "a subscriber appearing after the stage must still be told");
    assertEquals(seen[0]!.version, "26.200");
  });
});

Deno.test("unsubscribing stops delivery", () => {
  withCleanState(() => {
    const seen: AppEvent[] = [];
    const off = subscribeAppEvents((e) => seen.push(e));
    emitAppEvent({ type: "update-staged", version: "a", canApplyByRestart: true });
    off();
    emitAppEvent({ type: "update-staged", version: "b", canApplyByRestart: true });
    assertEquals(seen.map((e) => e.version), ["a"], "only the pre-unsubscribe event arrives");
  });
});

Deno.test("a throwing subscriber does not stop the others, and does not propagate", () => {
  withCleanState(() => {
    const seen: string[] = [];
    subscribeAppEvents(() => {
      throw new Error("subscriber blew up");
    });
    subscribeAppEvents((e) => seen.push(e.version));
    // Must not throw: this runs from a background update check, where an exception would
    // surface as a crash rather than a missed notification.
    emitAppEvent({ type: "update-staged", version: "26.200", canApplyByRestart: true });
    assertEquals(seen, ["26.200"], "the healthy subscriber still got it");
  });
});

Deno.test("ids are monotonic, so a client can tell a replay from a new event", () => {
  withCleanState(() => {
    const a = emitAppEvent({ type: "update-staged", version: "1", canApplyByRestart: true });
    const b = emitAppEvent({ type: "update-rollback", version: "2", canApplyByRestart: true });
    assert(b.id > a.id);
  });
});

Deno.test("a rollback is its own event type, carrying the reason", () => {
  withCleanState(() => {
    const seen: AppEvent[] = [];
    subscribeAppEvents((e) => seen.push(e));
    emitAppEvent({
      type: "update-rollback",
      version: "the previous launch failed",
      canApplyByRestart: true,
    });
    assertEquals(seen[0]!.type, "update-rollback");
    assertEquals(seen[0]!.version, "the previous launch failed");
  });
});

Deno.test("the SSE frame carries the event name and a JSON body", () => {
  const frame = sseFrame({
    id: 7,
    type: "update-staged",
    version: "26.200",
    canApplyByRestart: false,
  });
  assert(frame.startsWith("id: 7\n"), "must carry the id");
  assert(frame.includes("event: update-staged\n"), "must carry the event NAME, or a listener never fires");
  assert(frame.includes('"version":"26.200"'), "must carry the payload");
  assert(frame.endsWith("\n\n"), "SSE frames end with a blank line");
});
