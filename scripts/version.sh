#!/usr/bin/env bash
# Compute the SemaClip version: v{yy}.{patch} where yy = year - 2000 and patch
# counts commits since Jan 1 of the current year.
#
# ONE CONTINUOUS LINE. There is no stable/beta/nightly split: development is
# continuous and every release is simply the next point on it. The patch number is
# the commit count, so it advances by itself and no channel suffix is needed to keep
# two builds of the same commit distinct -- each commit has its own number.
#
# WHY yy AND NOT THE FULL YEAR (verified): Windows Installer packs ProductVersion
# as major(0-255).minor(0-255).build(0-65535), so a CalVer major of 2026 is
# rejected outright -- `deno desktop -o SemaClip.msi` fails with "the major field
# 2026 exceeds the maximum of 255". Year-2000 fits (26, and it stays <=255 until
# 2255) and the commit count fits the minor field; the build field's 65535 ceiling
# is the overflow valve if the commit count ever grows past 255.
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

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="stable"
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

# MSI ProductVersion bounds: minor must be <= 255. Beyond that the commit count
# moves into the build field (<= 65535), keeping the version monotonic-ish and
# still encodable.
if [ "$patch" -le 255 ]; then
  version="${yy}.${patch}"
else
  version="${yy}.255.${patch}"
fi
tag="v${version}"

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
