#!/usr/bin/env bash
# Publish files to the GitHub Pages branch that serves the update manifests.
#
# Usage: scripts/ci/push-pages.sh <owner/repo> <token> <src> <dest-in-branch> [<src> <dest> ...]
#   e.g. scripts/ci/push-pages.sh 99oblivius/SemaClip "$GITHUB_TOKEN" \
#          dist/nightly/latest.json nightly/latest.json \
#          work/patch-x.bin nightly/patch-x.bin
#
# WHY A SCRIPT AND NOT A PAGES ACTION: the manifest and its patch files must land
# in the SAME commit. Two publishes (manifest first, patch second) leave a window
# where clients read a manifest naming a patch that 404s, and the runtime refuses
# the update. One commit, all-or-nothing.
#
# WHY NOT force-push the whole branch: the branch also holds the other channel
# (stable/) and previously-published patches whose manifest entries still point at
# them. Replacing the tree would delete files the live manifest references, so
# this copies the existing branch and adds/overwrites only the named paths.
#
# Requires: git, an empty or disposable CWD. The token is passed as an argument
# and never written to disk or echoed.
set -euo pipefail

if [ "$#" -lt 4 ] || [ $(( $# % 2 )) -ne 0 ]; then
  echo "usage: $0 <owner/repo> <token> <src> <dest> [<src> <dest> ...]" >&2
  exit 2
fi

repo="$1"; token="$2"; shift 2
branch="releases"

work="$PWD/.pages-publish"
rm -rf "$work"
mkdir -p "$work"
cd "$work"

# The branch is created on the first release, so its absence is expected, not an
# error: start an orphan branch holding only what we are publishing now.
remote="https://x-access-token:${token}@github.com/${repo}.git"
if git clone --depth 1 --branch "$branch" "$remote" repo 2>/dev/null; then
  echo "==> cloned existing $branch branch"
else
  echo "==> $branch branch does not exist yet; creating it"
  git init -q repo
  git -C repo checkout -q --orphan "$branch"
fi

cd repo

while [ "$#" -gt 0 ]; do
  src="$1"; dest="$2"; shift 2
  [ -f "$src" ] || { echo "FAIL: source not found: $src" >&2; exit 1; }
  mkdir -p "$(dirname "$dest")"
  cp "$src" "$dest"
  echo "==> staged $src -> $dest ($(wc -c < "$dest") bytes)"
done

# GitHub Pages reads the served content from the branch tip; no build step runs.
printf '' > .nojekyll

git -c user.name="semaclip-ci" -c user.email="ci@users.noreply.github.com" add -A
if git diff --cached --quiet; then
  echo "==> nothing changed; branch already up to date"
  exit 0
fi
git -c user.name="semaclip-ci" -c user.email="ci@users.noreply.github.com" \
  commit -q -m "publish ${GITHUB_RUN_NUMBER:+nightly.${GITHUB_RUN_NUMBER} }manifests"

# Fast-forward push: the release workflow serialises on a concurrency group, so a
# rejected push means something else wrote the branch and the manifest would be
# silently dropped. Fail loudly rather than force over it.
git push -q origin "HEAD:$branch"

echo "==> pushed to $branch"
ls -la
