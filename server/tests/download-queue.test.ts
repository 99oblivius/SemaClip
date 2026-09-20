/**
 * The full-VOD download queue: one transfer at a time, in the order they were added.
 *
 * The properties that matter, each of which has a failure behind it:
 *   - the FIFO order is the ORDER ADDED (the owner's requirement);
 *   - never two runs at once, asserted as a live counter rather than inferred from ordering —
 *     that is the whole point of the queue;
 *   - a run that FAILS or is aborted releases the next one (a queue that stops after one
 *     failure would silently strand every later download);
 *   - one stream is never queued twice (a double-press must not start two runs over one
 *     destination folder);
 *   - cancelling a waiting entry removes it, and cancelling a running one aborts it via the
 *     caller while still allowing the next to start.
 */
import { assert, assertEquals } from "@std/assert";
import { DownloadQueue } from "@/application/use-cases/DownloadQueue.ts";

/** A run that resolves only when the test says so. */
function deferred() {
  let release!: () => void;
  const promise = new Promise<void>((res) => (release = res));
  return { promise, release };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

Deno.test("queue: runs in the order added, one at a time", async () => {
  const q = new DownloadQueue();
  const events: string[] = [];
  let concurrent = 0;
  let maxConcurrent = 0;
  const gates = new Map<string, ReturnType<typeof deferred>>();

  const add = (id: string) => {
    const gate = deferred();
    gates.set(id, gate);
    q.enqueue({
      streamId: id,
      label: id,
      run: async () => {
        concurrent++;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        events.push(`start:${id}`);
        await gate.promise;
        events.push(`end:${id}`);
        concurrent--;
      },
    });
  };

  add("a");
  add("b");
  add("c");
  await tick();
  assertEquals(events, ["start:a"], "only the first entry runs");

  gates.get("a")!.release();
  await tick();
  assertEquals(events, ["start:a", "end:a", "start:b"], "then the second, in order");

  gates.get("b")!.release();
  await tick();
  gates.get("c")!.release();
  await tick();
  assertEquals(events, ["start:a", "end:a", "start:b", "end:b", "start:c", "end:c"]);
  // The measurement the queue exists for.
  assertEquals(maxConcurrent, 1, "never two downloads at once");
});

Deno.test("queue: reports a position for each waiting entry, and none for the running one", async () => {
  const q = new DownloadQueue();
  const gate = deferred();
  q.enqueue({ streamId: "first", label: "first", run: () => gate.promise });
  q.enqueue({ streamId: "second", label: "second", run: () => Promise.resolve() });
  q.enqueue({ streamId: "third", label: "third", run: () => Promise.resolve() });
  await tick();

  assertEquals(q.snapshot().running, "first");
  assertEquals(q.snapshot().waiting, ["second", "third"]);
  assertEquals(q.positionOf("second"), 1, "positions are 1-based within the waiting list");
  assertEquals(q.positionOf("third"), 2);
  assertEquals(q.positionOf("first"), 0, "a running entry is not 'waiting'");
  assertEquals(q.positionOf("unknown"), 0);
  assertEquals(q.size, 3);
  gate.release();
});

Deno.test("queue: a failing run releases the next one", async () => {
  const q = new DownloadQueue();
  const events: string[] = [];
  q.enqueue({
    streamId: "boom",
    label: "boom",
    run: () => {
      events.push("boom");
      return Promise.reject(new Error("network died"));
    },
  });
  q.enqueue({
    streamId: "after",
    label: "after",
    run: () => {
      events.push("after");
      return Promise.resolve();
    },
  });

  await tick();
  await tick();
  assertEquals(events, ["boom", "after"], "a failed download must not stall the queue");
  assertEquals(q.size, 0, "both entries left the queue");
});

Deno.test("queue: a run that never rejects but throws synchronously still releases", async () => {
  const q = new DownloadQueue();
  let ran = false;
  q.enqueue({
    streamId: "sync-throw",
    label: "sync-throw",
    run: () => {
      throw new Error("thrown before any await");
    },
  });
  q.enqueue({ streamId: "next", label: "next", run: () => { ran = true; return Promise.resolve(); } });
  await tick();
  await tick();
  assertEquals(ran, true);
});

Deno.test("queue: the same stream is never queued twice", async () => {
  const q = new DownloadQueue();
  const gate = deferred();
  const runs: string[] = [];
  const entry = (id: string) => ({ streamId: id, label: id, run: () => { runs.push(id); return gate.promise; } });

  q.enqueue(entry("a"));
  await tick();
  const second = q.enqueue(entry("a")); // a double-press
  await tick();
  assertEquals(runs, ["a"], "the second press must not start a second run");
  assertEquals(second, 1, "and the caller learns it is already first");
  gate.release();
});

Deno.test("queue: cancelling a WAITING entry removes it, the rest still runs", async () => {
  const q = new DownloadQueue();
  const order: string[] = [];
  const gate = deferred();
  q.enqueue({ streamId: "a", label: "a", run: () => gate.promise });
  q.enqueue({ streamId: "b", label: "b", run: () => { order.push("b"); return Promise.resolve(); } });
  q.enqueue({ streamId: "c", label: "c", run: () => { order.push("c"); return Promise.resolve(); } });
  await tick();

  assertEquals(q.cancel("b"), true, "a waiting entry is cancellable");
  assertEquals(q.snapshot().waiting, ["c"]);
  gate.release();
  await tick();
  await tick();
  assertEquals(order.includes("b"), false, "the cancelled entry never runs");
  assertEquals(order.includes("c"), true, "and the next one still does");
});

Deno.test("queue: cancelling a RUNNING entry does not remove it from the queue itself", async () => {
  // The caller aborts the in-flight download (it owns the controller); the queue's contract is
  // that the entry does not linger afterwards, which the run's own resolution delivers.
  const q = new DownloadQueue();
  const gate = deferred();
  q.enqueue({ streamId: "running", label: "running", run: () => gate.promise });
  await tick();
  assertEquals(q.cancel("running"), false, "there is nothing waiting to remove");
  assertEquals(q.isRunning("running"), true);
  gate.release();
  await tick();
  assertEquals(q.size, 0);
});

Deno.test("queue: clear() drops everything waiting but not the running entry", async () => {
  const q = new DownloadQueue();
  const gate = deferred();
  q.enqueue({ streamId: "a", label: "a", run: () => gate.promise });
  q.enqueue({ streamId: "b", label: "b", run: () => Promise.resolve() });
  await tick();
  q.clear();
  assertEquals(q.snapshot().waiting, []);
  assertEquals(q.isRunning("a"), true, "the clear must not lie about what is running");
  gate.release();
  await tick();
  assert(q.size === 0);
});
