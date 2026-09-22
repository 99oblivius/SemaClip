#!/usr/bin/env bash
# Compute the SemaClip version: v{yy}.{patch} where yy = year - 2000 and patch
# counts commits since Jan 1 of the current year.
#
# ONE CONTINUOUS LINE. There is no stable/beta/nightly split: development is
# continuous and every release is simply the next point on it. The patch number is
# the commit count, so it advances by itself and no channel suffix is needed to keep
# two builds of the same commit distinct -- each commit has its own number.
#
# THE SCHEME IS EXACTLY TWO PARTS, ALWAYS. The commit count is NOT bounded: past 255
# the patch component simply keeps counting (26.256, 26.257, ...). There is no
# three-part form and none may be reintroduced.
#
# WHY yy AND NOT THE FULL YEAR (verified): Windows Installer packs ProductVersion
# as major(0-255).minor(0-255).build(0-65535), so a CalVer major of 2026 is
# rejected outright -- `deno desktop -o SemaClip.msi` fails with "the major field
# 2026 exceeds the maximum of 255". Year-2000 fits (26, and it stays <=255 until
# 2255). This bound is why yy exists, and it is the ONLY part of the MSI constraint
# that still applies.
#
# The MINOR 255 bound does NOT apply, because no .msi is built any more: the build
# targets a plain directory and the release zips that (a per-machine install under
# ProgramFiles leaves WebView2 unable to write its profile, so the window is blank
# -- see build-desktop.ts and docs/RELEASING.md). The three-part form
# `26.255.<patch>` was kept as an overflow valve for an installer that no longer
# exists; carrying a retired constraint is how a scheme becomes nonsense, so the
# overflow is gone and the two-part form is unconditional.
#
# Writes the version into BOTH frontend/package.json (the header banner reads it via
# vite.config.ts) and server/deno.json (what `deno desktop` bakes into the binary as
# Deno.desktopVersion, which Deno.autoUpdate compares against the manifest). They
# must never drift, or the updater re-applies patches forever.
#
# Usage:  ./scripts/version.sh           # write package.json + deno.json, print
#         ./scripts/version.sh --check   # print only, no write (CI verify)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
check_only="no"
for arg in "$@"; do
  case "$arg" in
    --check) check_only="yes" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

year="$(date -u +%Y)"
yy=$((year - 2000))
since="${year}-01-01T00:00:00Z"

# Commits authored this year, up to HEAD. This is the {patch} component.
patch="$(git -C "$repo" rev-list --count --since="$since" HEAD)"
[ "$patch" -gt 0 ] || patch=1

version="${yy}.${patch}"
tag="v${version}"

# The scheme is two dot-separated numeric components. Asserted here as well as in CI
# because a version is baked into a binary that can never be corrected afterwards
# (the updater compares baked-vs-manifest, so a malformed one loops or strands
# clients) -- this is the last place that can refuse before the write.
case "$version" in
  *[!0-9.]* | *.*.* | .* | *.) echo "FAIL: version '$version' is not {yy}.{patch}" >&2; exit 1 ;;
esac

if [ "$check_only" != "yes" ]; then
  # BOTH files must carry the version: frontend/package.json drives the UI
  # banner (via vite.config.ts) and server/deno.json is what deno desktop bakes
  # into the binary as Deno.desktopVersion. Deno.autoUpdate compares the
  # manifest against THAT value, so a drift here means the updater sees the
  # wrong current version and re-applies patches forever.
  python3 - "$repo/frontend/package.json" "$repo/server/deno.json" "$version" <<'PY'
import json, sys
pkg_path, deno_path, version = sys.argv[1], sys.argv[2], sys.argv[3]
for path in (pkg_path, deno_path):
    with open(path) as fh:
        data = json.load(fh)
    data["version"] = version
    with open(path, "w") as fh:
        json.dump(data, fh, indent=2)
        fh.write("\n")
PY
fi

echo "version=${version}"
echo "tag=${tag}"
echo "repo=${repo}"
