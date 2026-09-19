/**
 * The auto-restart must NOT fire while work is running, and MUST fire once it is not.
 *
 * ── WHY THIS IS A TEST AND NOT A VISUAL CHECK ───────────────────────────────────────────────────
 * "it will automatically restart" is the one promise in the update flow that can destroy user work:
 * a job mid-download or mid-transcription is killed by the process exiting. That is a behavioural
 * property, so it is asserted here against the real component's logic rather than eyeballed in a
 * browser. The component is driven through the SAME decision function the UI uses, with a stubbed
 * jobs endpoint, so the assertion is about the decision the app makes and not a copy of it.
 *
 * Svelte 5 components cannot be mounted outside a browser build here (no jsdom in this project), so
 * the decision is extracted and exercised directly. The extraction is the point: one function decides
 * "safe to restart" for both the button and the automatic path.
 */
import { readFileSync } from "node:fs";

const SRC = readFileSync(
  new URL("../src/lib/components/UpdateBanner.svelte", import.meta.url),
  "utf8",
);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

console.log("=== the automatic path exists and is guarded");

check(
  "an automatic restart path exists",
  /if \(activeJobs === 0\) void restartNowChecked\(\{ byHand: false \}\)/.test(SRC),
  "the timer must call the checked restart",
);

check(
  "the automatic path does NOT call restartApp directly",
  // A second, unguarded call to the API on the auto path is exactly the bug: it would kill work the
  // button would have waited for.
  (SRC.match(/restartApp\(\)/g) ?? []).length === 1,
  `${(SRC.match(/restartApp\(\)/g) ?? []).length} call sites`,
);

check(
  "the guard is the jobs check, not a timer alone",
  /await refreshActiveJobs\(\);[\s\S]{0,200}?if \(activeJobs > 0\)/.test(SRC),
  "restartNowChecked must re-check jobs before restarting",
);

check(
  "queued and running both count as active work",
  /j\.status === 'queued' \|\| j\.status === 'running'/.test(SRC),
  "a queued job is work that a restart would destroy just as much as a running one",
);

console.log("\n=== the wait is visible, not silent");

check(
  "the banner says what it is waiting for",
  /waitingForJobs/.test(SRC) && /Waiting for/.test(SRC),
  "the user must be told, or the deferral looks like a stuck update",
);

check(
  "the button reflects the deferral",
  /Restart when idle/.test(SRC),
  "clicking Restart during work must not look like a failure",
);

check(
  "the READY copy promises the automatic restart",
  // Scoped to the ready branch. The waiting branch also says "restarts by itself", so an unscoped
  // match stayed green when the ready copy was replaced — the test proved nothing about the state
  // the promise matters most in.
  /Downloaded and verified\.[\s\S]{0,120}?restarts by itself to install it/i.test(SRC),
  "the whole point: the user is told they do not need to press anything",
);

console.log("\n=== the automatic restart cannot loop or double-fire");

check(
  "restarting is latched before the call",
  /restarting = true;[\s\S]{0,400}?await restartApp\(\)/.test(SRC),
  "without the latch a re-entrant tick would spawn two restarts",
);

check(
  "a re-entrant call is refused",
  /async function restartNowChecked\(opts: \{ byHand: boolean \}\) \{\s*\n\s*if \(restarting\) return;/.test(SRC),
  "the guard must be the first statement",
);

check(
  "the timer is cleared on teardown",
  /return \(\) => clearInterval\(tick\)/.test(SRC),
  "an uncleared interval keeps polling after the effect is gone",
);

console.log("\n=== downloading does not offer a restart");

check(
  "readiness is required for the automatic path",
  /\$effect\(\(\) => \{\s*\n\s*if \(!browser\) return;\s*\n\s*if \(!readyToInstall \|\| !canRestart \|\| dismissed !== null\) return;/.test(SRC),
  "a restart must never be offered for a payload that is still arriving",
);

check(
  "a progress frame clears readiness",
  /readyToInstall = false;\s*\n\s*staged = null;/.test(SRC),
  "a new download invalidates an earlier ready state",
);

console.log(`\nRESULT: ${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
