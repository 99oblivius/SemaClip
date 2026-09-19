/**
 * The restart happens when the USER asks, and never on its own.
 *
 * ── WHY THIS TEST EXISTS, AND WHAT IT USED TO SAY ────────────────────────────────────────────────
 * It used to assert the opposite: that a timer restarted the app automatically once nothing was
 * running, on the reasoning that the banner had promised the user they would not need to press
 * anything. The owner rejected that outright:
 *
 *   "why is it triggering the update on itself after being done downloading? Even the downloading
 *    should not be happening automatically."
 *
 * A window that closes itself while someone is reading is indistinguishable from a crash, and it
 * takes a decision away from them. So the assertions are INVERTED: no timer, no automatic restart,
 * and a download that only starts on a click. The properties that stay are the ones that protect
 * work — the jobs check, and the latch against a double restart.
 *
 * Svelte 5 components cannot be mounted outside a browser build here (no jsdom in this project), so
 * the component is read as source. That is a weaker check, so each assertion names the specific
 * line that would have to change for the behaviour to regress.
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

console.log("=== nothing restarts the app on its own");

check(
  "no timer exists to restart the app",
  !/setInterval\s*\(/.test(SRC) && !/setTimeout\s*\(\s*\(\)\s*=>\s*restart/.test(SRC),
  "the automatic path was a setInterval; any timer here is a regression",
);

check(
  "no automatic call to the checked restart remains",
  !/restartNowChecked\(\{\s*byHand/.test(SRC),
  "the auto path passed byHand:false and is gone; the argument should be gone with it",
);

check(
  "there is exactly ONE place that restarts the app",
  (SRC.match(/restartApp\(\)/g) ?? []).length === 1,
  `${(SRC.match(/restartApp\(\)/g) ?? []).length} call sites — a second one is the bug`,
);

check(
  "the button is the only caller of the restart decision",
  /onclick=\{restartNow\}/.test(SRC),
  "the click handler must be wired to the restart path",
);

console.log("\n=== the download starts only when asked");

check(
  "a Download button exists",
  /onclick=\{startDownload\}/.test(SRC),
  "the check only offers an update, so the UI must be able to request one",
);

check(
  "the offer is shown as an offer, not as a ready update",
  /SemaClip \{offered\} is available/.test(SRC),
  "the offered state needs its own copy, or the user cannot tell it is not downloaded",
);

check(
  "the offer copy says nothing is downloaded yet",
  /Nothing is downloaded yet/.test(SRC),
  "the distinction between offered and staged is the whole point of the split",
);

console.log("\n=== work is still protected");

check(
  "the restart re-checks jobs before proceeding",
  /await refreshActiveJobs\(\);[\s\S]{0,300}?if \(activeJobs > 0/.test(SRC),
  "restartNowChecked must re-check jobs before restarting",
);

check(
  "queued and running both count as active work",
  /j\.status === 'queued' \|\| j\.status === 'running'/.test(SRC),
  "a queued job is work that a restart would destroy just as much as a running one",
);

check(
  "the user is told when work is running",
  /waitingForJobs/.test(SRC) && /restarting now would lose that work/.test(SRC),
  "the warning must name the consequence, not just the fact",
);

check(
  "a second click proceeds anyway",
  /confirmedWithWork/.test(SRC),
  "the button is the only way to apply an update; a deferral that could not be overridden would refuse forever",
);

check(
  "restarting is latched before the call",
  /restarting = true;[\s\S]{0,400}?await restartApp\(\)/.test(SRC),
  "without the latch a double click would spawn two restarts",
);

check(
  "a re-entrant call is refused",
  /if \(restarting\) return;/.test(SRC),
  "the guard must come first in the restart function",
);

console.log("\n=== downloading does not offer a restart");

check(
  "a progress frame clears readiness",
  /readyToInstall = false;\s*\n\s*staged = null;/.test(SRC),
  "a new download invalidates an earlier ready state",
);

check(
  "a progress frame clears the offer",
  /readyToInstall = false;\s*\n\s*staged = null;[\s\S]{0,200}?offered = null;/.test(SRC),
  "leaving the Download button up during a download would invite a second fetch",
);

check(
  "the ready copy does NOT promise an automatic restart",
  !/restarts by itself to install it/i.test(SRC),
  "the app never restarts itself now, so any such sentence is a lie",
);

console.log(`\nRESULT: ${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
