#!/usr/bin/env bash
# Compute the SemaClip version: v{year}.{patch}, where patch counts commits
# since Jan 1 of the current year. One number that means something locally and
# still satisfies Deno.autoUpdate (which compares version strings and treats
# "differs" as an update).
#
# Writes frontend/package.json's "version" (the header banner reads it via
# vite.config.ts) and prints the version + the release tag.
#
# Usage:  ./scripts/version.sh              # stable:  2026.138         -> v2026.138
#         ./scripts/version.sh --nightly    # nightly: 2026.138-nightly.42
#         ./scripts/version.sh --check      # print only, no write (CI verify)
#
# THE NIGHTLY SUFFIX IS LOAD-BEARING, not cosmetic. Deno.autoUpdate looks up a
# patch under manifest.patches[Deno.desktopVersion], so if a nightly and a
# stable build both reported "2026.138" the updater would treat them as the same
# version and a nightly would never see the next nightly. The suffix also keys
# the nightly manifest, served from a URL separate from the stable one.
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
mode="stable"
check_only="no"
for arg in "$@"; do
  case "$arg" in
    --nightly) mode="nightly" ;;
    --check) check_only="yes" ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

year="$(date -u +%Y)"
since="${year}-01-01T00:00:00Z"

# Commits authored this year, up to HEAD. This is the {patch} component.
patch="$(git -C "$repo" rev-list --count --since="$since" HEAD)"
[ "$patch" -gt 0 ] || patch=1

version="${year}.${patch}"
if [ "$mode" = "nightly" ]; then
  # The run number keeps consecutive nightlies of the SAME commit distinct —
  # otherwise two runs of one commit collide on a single version and the updater
  # sees no change. CI supplies GITHUB_RUN_NUMBER.
  run="${GITHUB_RUN_NUMBER:-0}"
  version="${version}-nightly.${run}"
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
echo "mode=${mode}"
