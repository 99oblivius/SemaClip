/**
 * A failed update check must be REPORTED as a failed check, and must be retryable.
 *
 * ── THE BUG THIS GUARDS ─────────────────────────────────────────────────────────────────────────
 * `checkWindowsUpdate` wrote every error into `sidecarError`, whose meaning is "this install cannot
 * update itself" — and nothing rendered that field. So a transient HTTP 500 from the release host, a
 * connection dropped partway through a ~100MB download, or a sha256 mismatch all produced: a claim
 * that the install was permanently incapable, no visible message anywhere, and no update until the
 * next launch (the check runs once per launch by policy, so there is no second chance).
 *
 * ── WHY THESE DRIVE THE REAL FUNCTION ───────────────────────────────────────────────────────────
 * The first version of this file asserted against the SOURCE TEXT, and four of its five cases stayed
 * GREEN under mutation — a regex for `status.updateError = res.error` matches whether or not the
 * assignment is reached, and cannot tell a working predicate from one that always returns false. The
 * policy below is therefore asserted by CALLING it: how many attempts a given failure gets, and what
 * the recorded error is afterwards.
 */
import { assert, assertEquals } from "@std/assert";
import { isPermanent, runUpdateCheck, updateStatus } from "@/adapters/outbound/platform/auto-update.ts";

// Run the retry policy instantly. At the 2s production base the three retry cases below spend ~20s
// asleep, and a slow suite is one nobody runs. The mechanism itself is unaffected — only the wait.
Deno.env.set("SEMACLIP_UPDATE_RETRY_MS", "0");

type Status = {
  current: string | null;
  updateError: string | null;
  sidecarError: string | null;
  phase: string;
};

/** Fail the first `n` attempts, then succeed. Reports how many calls it took. */
function flaky(n: number): { run: () => Promise<{ error?: string; reason?: string }>; calls: () => number } {
  let calls = 0;
  return {
    run: async () => {
      calls++;
      return calls <= n ? { error: "manifest fetch failed: HTTP 500" } : { reason: "up to date" };
    },
    calls: () => calls,
  };
}

Deno.test("a fresh status has no update error and no false limitation", () => {
  const s = updateStatus() as Status;
  assertEquals(s.updateError, null);
  assertEquals(s.sidecarError, null, "a check must not imply an unusable install");
  assertEquals(s.phase, "idle");
});

Deno.test("a transient failure is retried, and the error is recorded", async () => {
  // The download is ~100MB and the check runs once per launch, so the retries are the only chance
  // the automatic path gets. This is the behaviour a source-text test could not see.
  const f = flaky(1);
  await runUpdateCheck(f.run as () => Promise<{ error?: string }>);
  assertEquals(f.calls(), 2, "one transient failure must be retried");
  // It succeeded on the second attempt, so no error may be left showing.
  assertEquals(updateStatus().updateError, null, "a success must CLEAR the error");
});

Deno.test("an error IS recorded when every attempt fails", async () => {
  let calls = 0;
  await runUpdateCheck(async () => {
    calls++;
    return { error: "manifest fetch failed: HTTP 503" };
  });
  assertEquals(calls, 3, "1 attempt + 2 retries");
  const err = updateStatus().updateError;
  assert(err !== null, "the failure must be reported, not swallowed");
  assert(err!.includes("503"), `the message must name the real failure: ${err}`);
  // THE DISTINCTION THAT IS THE WHOLE FIX: a failed check must not claim a broken install.
  assertEquals(
    updateStatus().sidecarError,
    null,
    "a network failure is not a limitation of this install",
  );
});

Deno.test("a permanent failure is NOT retried", async () => {
  // Retrying costs two more attempts at a ~100MB download, so it must not be spent on something that
  // cannot change within this launch.
  let calls = 0;
  await runUpdateCheck(async () => {
    calls++;
    return { error: "manifest has no win-x64 artifact (published 26.299)" };
  });
  assertEquals(calls, 1, "a permanent condition must be attempted exactly once");
  assert(updateStatus().updateError !== null, "and still be reported");
});

Deno.test("isPermanent classifies real errors the right way", () => {
  // Called with real strings: a source search cannot tell a working predicate from a disabled one.
  for (
    const permanent of [
      "manifest has no win-x64 artifact (published 26.299)",
      "manifest has no linux-x64 artifact (published 26.299)",
      "manifest has no version",
      "no version baked in (dev run)",
    ]
  ) {
    assertEquals(isPermanent(permanent), true, `${permanent} must be permanent`);
  }
  for (
    const transient of [
      "manifest fetch failed: HTTP 500",
      "manifest fetch failed: HTTP 404",
      "download failed: HTTP 503",
      "download interrupted: error reading a body from connection",
      "sha256 mismatch (expected 80a3…, got 11bb…) — refusing to install",
      "download truncated: got 1024 of 4096 bytes",
    ]
  ) {
    assertEquals(isPermanent(transient), false, `${transient} must be retryable`);
  }
});

Deno.test("a success after a failure clears the error", async () => {
  // A stale error is worse than none, because it is wrong: the banner would keep telling the user
  // their updates are broken after a retry already fixed it.
  await runUpdateCheck(async () => ({ error: "manifest fetch failed: HTTP 500" }));
  assert(updateStatus().updateError !== null, "precondition: the failure is showing");

  await runUpdateCheck(async () => ({ reason: "up to date (26.299)" }));
  assertEquals(updateStatus().updateError, null, "success must clear it");
});

Deno.test("a throwing check is caught and treated as a failure", async () => {
  // The two platform checks can throw (a malformed manifest, an unexpected runtime error). A throw
  // that escapes would leave `checking` latched and no future check could ever run.
  await runUpdateCheck(async () => {
    throw new Error("Cannot convert object to primitive value");
  });
  const err = updateStatus().updateError;
  assert(err !== null && err.includes("Cannot convert"), `the throw must be reported: ${err}`);

  // PROOF the latch was released: a later check still runs and can succeed.
  let ran = false;
  await runUpdateCheck(async () => {
    ran = true;
    return { reason: "up to date" };
  });
  assertEquals(ran, true, "a throwing check must not leave the in-flight guard latched");
  assertEquals(updateStatus().updateError, null);
});
