/**
 * The updater's log must be REACHABLE. Building the endpoint is not the same as reading it.
 *
 * ── WHY THIS EXISTS ─────────────────────────────────────────────────────────────────────────────
 * `/api/update/log` was added and described as "readable from the app", but nothing in the frontend
 * ever fetched it — a write-only endpoint, the same class of dead surface as the status fields that
 * made the original failure invisible. This asserts the whole path: a client function, a component
 * that calls it, and a place the text is rendered.
 */
import { readFileSync } from "node:fs";

const client = readFileSync(new URL("../src/lib/api/client.ts", import.meta.url), "utf8");
const banner = readFileSync(
  new URL("../src/lib/components/UpdateBanner.svelte", import.meta.url),
  "utf8",
);

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS" : "FAIL"}: ${name}${detail ? ` (${detail})` : ""}`);
  if (!ok) failures++;
}

console.log("=== the whole path exists");
check(
  "a client function fetches the endpoint",
  /export async function getUpdateLog\(\)[\s\S]{0,200}?fetch\('\/api\/update\/log'\)/.test(client),
  "an endpoint with no client function is unreachable",
);
check(
  "the component imports it",
  /import \{[^}]*getUpdateLog[^}]*\} from '\$lib\/api\/client'/.test(banner),
);
check(
  "the component calls it",
  /logText = await getUpdateLog\(\)/.test(banner),
);
check(
  "the text is actually rendered",
  /\{logText \?\? 'loading…'\}/.test(banner),
  "calling it and discarding the result would be the same bug",
);

console.log("\n=== the log is not fetched unless asked");
check(
  "the fetch is lazy, inside the toggle",
  /async function toggleLog\(\)[\s\S]{0,400}?getUpdateLog\(\)/.test(banner),
  "reading another process's file on every render is pointless work",
);
check(
  "a repeat open does not refetch",
  /if \(logText === null\) \{/.test(banner),
);

console.log("\n=== it appears only when there is something to see");
check(
  "the control is gated on a prior attempt",
  /\{#if failedBefore\}/.test(banner),
  "a first failure with no attempt should not offer an empty log",
);
check(
  "a refused restart marks that an attempt happened",
  // Scoped to the RESTART refusal. A bare /failedBefore = true;/ is also satisfied by the
  // status-read site, so removing this one left the suite green — the assertion proved nothing about
  // the path it named (it did).
  /restarting = false;[\s\S]{0,400}?failedBefore = true;/.test(banner),
  "the refusal path is a real attempt: the updater ran and recorded why it declined",
);
check(
  "a recorded failure marks it too",
  /updateError = s\.updateError;[\s\S]{0,120}?failedBefore = true;/.test(banner),
  "a failure that happened before the webview connected must also offer the log",
);

console.log(`\nRESULT: ${failures === 0 ? "all passed" : `${failures} failed`}`);
process.exit(failures === 0 ? 0 : 1);
