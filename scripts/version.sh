#!/usr/bin/env bash
# Compute the SemaClip version: v{year}.{patch}, where patch counts commits
# since Jan 1 of the current year. One number that means something locally and
# still sorts correctly for the updater (which compares version strings).
#
# Writes frontend/package.json's "version" (the banner reads it via
# vite.config.ts) and prints the version + the release tag.
#
# Usage:  ./scripts/version.sh          # write + print
#         ./scripts/version.sh --check   # print only, no write (CI verify)
set -euo pipefail

repo="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
year="$(date -u +%Y)"
since="${year}-01-01T00:00:00Z"

# Count commits authored in the current year up to HEAD.
patch="$(git -C "$repo" rev-list --count --since="$since" HEAD)"
[ "$patch" -gt 0 ] || patch=1

version="${year}.${patch}"
tag="v${version}"

if [ "${1:-}" != "--check" ]; then
  python3 - "$repo/frontend/package.json" "$version" <<'PY'
import json, sys
path, version = sys.argv[1], sys.argv[2]
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
