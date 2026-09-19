/**
 * How a packaged build's version is resolved, and why there is more than one channel.
 *
 * ── THE BUG THIS EXISTS FOR ─────────────────────────────────────────────────────────────────
 * `Deno.desktopVersion` is what `deno desktop` compiles in from a top-level `version` in deno.json.
 * MEASURED, on this project's own build inputs:
 *
 *   linux-x64 target, deno.json "version":"9.9.9"  ->  desktopVersion="9.9.9"
 *   win-x64   target, SAME deno.json               ->  desktopVersion=null
 *
 * with `"app_version":"9.9.9"` visibly present in the Windows dylib. So on Windows the value is
 * baked but never surfaced, and every consumer that guards on it early-returns: the update check
 * logged `Updates: disabled (no version baked in — dev run)` on every launch of a correctly
 * versioned Windows install, and the owner saw no update prompt at all. Reproduced in the VM with
 * the published 26.232 win-x64 payload, one minimal probe apart from the same probe on Linux.
 *
 * ── THE SECOND CHANNEL, AND WHY IT IS THE ENV ───────────────────────────────────────────────
 * The version is also compiled in through the build's `--env-file`: build-desktop.ts writes
 * `SEMACLIP_VERSION=<version>` into `server/.env`, and that file's variables reach `Deno.env` in
 * the packaged app. Verified on win-x64 in the VM, in the same run that reported
 * `desktopVersion=null`:
 *
 *   desktopVersion=null
 *   SEMACLIP_VERSION="9.9.9"
 *
 * Both channels are compile-time, so neither can drift from the other, and `version.sh` is the
 * single writer of both. Nothing here reads a config file at runtime that a user could edit —
 * that would let `current` be lied to and make the updater re-apply forever.
 *
 * ── WHY THE FALLBACK IS DELIBERATELY NOT USED FOR UPDATES ───────────────────────────────────
 * A dev run (`deno run`) has no baked version of either kind, and reading frontend/package.json
 * would make a DEV tree look like a released `26.x` and enable the update path in development.
 * `bakedVersion()` therefore reports only the two build channels and returns null in a dev run,
 * which keeps the original "updates are off in development" behaviour exactly.
 */

/** Version channels that only a packaged build can have. Null in a dev run. */
export function bakedVersion(
  env: (k: string) => string | undefined = (k) => Deno.env.get(k),
): { version: string; source: "desktopVersion" | "env" } | null {
  const fromRuntime = (Deno as { desktopVersion?: string | null }).desktopVersion;
  if (fromRuntime) return { version: fromRuntime, source: "desktopVersion" };
  const fromEnv = env("SEMACLIP_VERSION");
  // Present-but-empty is treated as absent: a blank value would make `current` falsy in one place
  // and a string in another, and an update that compares equal to "" re-applies on every launch.
  if (fromEnv && fromEnv.length > 0) return { version: fromEnv, source: "env" };
  return null;
}

/**
 * The version to SHOW (window title, and anywhere a human reads it).
 *
 * Unlike `bakedVersion()` this falls back to frontend/package.json, so a dev run shows the tree's
 * real version instead of "dev". That read fails in a packaged build (package.json is not an
 * included file), which is harmless: a packaged build always has a baked channel.
 */
export function displayVersion(): string {
  const baked = bakedVersion();
  if (baked) return baked.version;
  try {
    const pkg = JSON.parse(
      Deno.readTextFileSync(new URL("../../../../frontend/package.json", import.meta.url)),
    );
    return String(pkg.version ?? "dev");
  } catch {
    return "dev";
  }
}
