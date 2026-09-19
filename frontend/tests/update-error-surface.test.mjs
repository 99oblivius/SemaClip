/**
 * A failed update check must be VISIBLE and RETRYABLE in the UI.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * The server recorded check failures in `sidecarError`, which means "this install cannot update
 * itself" — and NOTHING rendered that field anywhere. So a transient HTTP 500 or a download that
 * died on a flaky connection produced no banner, no message, no retry, and no update until the next
 * launch (the check runs once per launch by policy). The user's only clue was silence.
 *
 * These are assertions over the component source, so they are worth exactly as much as their
 * falsification — every case below was checked by breaking the component and watching it fail.
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

console.log("=== the failure is shown");

check(
  "a failure branch exists in the markup",
  /#if updateError && !progress && !staged\}/.test(SRC),
  "the message must be gated on a failure, and not shown while a download or staged update is live",
);

check(
  "the message explains what failed",
  /\{updateError\}/.test(SRC),
  "the real error text must be rendered, not a generic 'update failed'",
);

check(
  "the copy names the once-per-launch policy",
  /only checks when it opens/i.test(SRC),
  "without this the user does not know a retry is the only way to recover this session",
);

check(
  "the failure uses the warning token, not 'warn'",
  // `--color-warning` is the defined token; a bare `warn` class generates nothing and the banner
  // would render unstyled (measured: the utilities are emitted only for `warning`).
  /border-warning\/40 bg-warning\/10/.test(SRC) && !/border-warn\/|bg-warn\/|text-warn[^i]/.test(SRC),
  "a class with no token behind it renders invisible",
);

console.log("\n=== the retry works, and cannot double-fire");

check(
  "a retry control exists",
  /onclick=\{retryNow\}/.test(SRC) && /Try again/.test(SRC),
  "a failure the user can only wait out is a dead end",
);

check(
  "the retry calls the server endpoint and is latched",
  /if \(retrying\) return;[\s\S]{0,200}?await retryUpdateCheck\(\)/.test(SRC),
  "without the latch a double-click starts two 100MB downloads",
);

check(
  "a refusal is not shown as an error",
  // A 409 means a check is already running. Surfacing that as a failure would tell the user their
  // update path is broken while it is in fact working.
  /if \(res\.started\) updateError = null;/.test(SRC),
  "an in-flight check is not a failure",
);

console.log("\n=== the failure is cleared when it stops being true");

check(
  "a progress frame clears the failure",
  /updateError = null;/.test(SRC.slice(SRC.indexOf("const onProgress"), SRC.indexOf("const onStaged"))),
  "leaving the message up while bytes arrive tells the user their update is broken as they watch it work",
);

check(
  "a staged frame clears the failure",
  /updateError = null;/.test(SRC.slice(SRC.indexOf("const onStaged"), SRC.indexOf("const onRollback"))),
  "a successful update must not leave a failure showing",
);

check(
  "the cold-start read picks up a failure that already happened",
  // The check runs during server boot, before the webview connects — the same race the staged-version
  // read exists for. Without this the failure would only ever reach the server log.
  // DOTALL-scoped: the branch and the assignment sit on different lines, so a single-line `.`
  // regex cannot span them (it silently matched nothing and reported a working line as missing).
  /s\.updateError\)[\s\S]{0,200}?updateError = s\.updateError/.test(SRC),
  "a failure before the webview connected would otherwise be invisible",
);

console.log(`\nRESULT: ${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
