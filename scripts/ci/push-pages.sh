#!/usr/bin/env bash
# Publish files to the GitHub Pages branch that serves the update manifests.
#
# Usage: scripts/ci/push-pages.sh <owner/repo> <token> <src> <dest-in-branch> [<src> <dest> ...]
#   e.g. scripts/ci/push-pages.sh 99oblivius/SemaClip "$GH_TOKEN" \
#          dist/latest.json latest.json \
#          work/patch-x.bin patch-x.bin
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

# Sources arrive as paths relative to the CALLER's cwd (release.yml passes
# "dist/latest.json"), but this script cds into its scratch directory.
# Resolving to absolute up front is not cosmetic: without it every publish fails
# with "source not found" after the cd, which is exactly the failure this test
# caught.
orig_pwd="$PWD"
args=()
while [ "$#" -gt 0 ]; do
  src="$1"; dest="$2"; shift 2
  case "$src" in
    /*) ;;
    *) src="$orig_pwd/$src" ;;
  esac
  [ -f "$src" ] || { echo "FAIL: source not found: $src" >&2; exit 1; }
  args+=("$src" "$dest")
done
set -- "${args[@]}"

work="$orig_pwd/.pages-publish"
rm -rf "$work"
mkdir -p "$work"
cd "$work"

# The branch is created on the first release, so its absence is expected, not an
# error: start an orphan branch holding only what we are publishing now.
#
# A full remote URL is accepted verbatim (file:// in tests, a GHE host in a
# self-hosted setup); an "owner/repo" slug becomes the token-authenticated GitHub
# HTTPS URL. Hardcoding the github.com form would make the script impossible to
# exercise without hitting the network.
case "$repo" in
  *://*|git@*) remote="$repo" ;;
  *) remote="https://x-access-token:${token}@github.com/${repo}.git" ;;
esac
if git clone --depth 1 --branch "$branch" "$remote" repo 2>/dev/null; then
  echo "==> cloned existing $branch branch"
else
  echo "==> $branch branch does not exist yet; creating it"
  git init -q repo
  git -C repo checkout -q --orphan "$branch"
  # A clone sets up origin; an init does not. Without this the first-ever publish
  # fails at the push with "'origin' does not appear to be a git repository" —
  # the one release where there is no existing branch to fall back on.
  git -C repo remote add origin "$remote"
fi

cd repo

while [ "$#" -gt 0 ]; do
  src="$1"; dest="$2"; shift 2
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
  commit -q -m "publish manifest${GITHUB_RUN_NUMBER:+ (run ${GITHUB_RUN_NUMBER})}"

# Fast-forward push: the release workflow serialises on a concurrency group, so a
# rejected push means something else wrote the branch and the manifest would be
# silently dropped. Fail loudly rather than force over it.
git push -q origin "HEAD:$branch"

echo "==> pushed to $branch"
ls -la
