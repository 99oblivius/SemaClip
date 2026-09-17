#!/usr/bin/env bash
# Publish a release: create it empty, then upload assets ONE AT A TIME with retries.
#
# ── WHY NOT `gh release create <tag> <files...>` ──────────────────────────────
# MEASURED FAILURES, four consecutive runs:
#   HTTP 500: Error saving asset (…SemaClip-26.184-win-x64-portable.zip)
#   HTTP 400: 400 Bad Request    (…SemaClip-26.185-win-x64-portable.zip)
# on a ~105MB file that is nowhere near any documented size limit, with the rate limit
# untouched (5000/5000), one release in the repo, and no quota involved. The variable
# is the NUMBER of large assets pushed at once: `gh release create` uploads every asset
# CONCURRENTLY, and the endpoint rejects concurrent uploads to a single release. Worse,
# the call is all-or-nothing: one rejected asset aborts the command and the release is
# rolled back, so a transient failure costs the whole publication.
#
# This uploads serially with bounded retries, so a transient rejection costs one asset
# and one retry rather than the release. It is also resumable: an asset already present
# with the right size is skipped, so a retry after a partial run continues instead of
# starting over.
#
# Usage: publish-release.sh <tag> <title> <notes-file> <asset>...
set -uo pipefail

TAG="${1:?usage: publish-release.sh <tag> <title> <notes-file> <asset>...}"
TITLE="${2:?title required}"
NOTES="${3:?notes file required}"
shift 3

repo="${GITHUB_REPOSITORY:?GITHUB_REPOSITORY required}"

# ── 1. an interrupted run may have left a stub release ────────────────────────
# A release with NO assets is the wreckage of a cancelled/failed run and is safe to
# replace. A release WITH assets is published work: never overwrite it, because a
# client may already have downloaded from it.
if gh release view "$TAG" --repo "$repo" --json assets --jq '.assets | length' \
    >/tmp/existing_assets 2>/dev/null; then
  have="$(cat /tmp/existing_assets)"
  if [ "$have" = "0" ]; then
    echo "::warning::release $TAG exists with no assets — replacing a stub"
    gh release delete "$TAG" --repo "$repo" --yes --cleanup-tag
  else
    # Resuming a partial upload is legitimate ONLY for a run we know we interrupted.
    # Without that certainty, a populated release means someone else published it.
    echo "::error::release $TAG already exists with $have asset(s) — refusing to touch it"
    exit 1
  fi
fi

# ── 2. create the release with no assets ─────────────────────────────────────
echo "creating release $TAG"
gh release create "$TAG" \
  --repo "$repo" \
  --target "${GITHUB_SHA:?GITHUB_SHA required}" \
  --title "$TITLE" \
  --notes-file "$NOTES"

# ── 3. upload serially, with retries ────────────────────────────────────────
failed=0
for asset in "$@"; do
  if [ ! -f "$asset" ]; then
    echo "::error::missing $asset"
    failed=1
    continue
  fi
  name="$(basename "$asset")"

  # Already uploaded with the same size => a previous attempt got this far.
  want_size="$(wc -c <"$asset" | tr -d ' ')"
  have_size="$(gh release view "$TAG" --repo "$repo" --json assets \
      --jq ".assets[] | select(.name == \"$name\") | .size" 2>/dev/null | head -1)"
  if [ -n "$have_size" ] && [ "$have_size" = "$want_size" ]; then
    echo "  = $name (already present, ${want_size} bytes)"
    continue
  fi
  if [ -n "$have_size" ]; then
    echo "  ! $name present with a different size — deleting and re-uploading"
    gh release delete-asset "$TAG" "$name" --repo "$repo" --yes
  fi

  ok=no
  for attempt in 1 2 3 4; do
    if gh release upload "$TAG" "$asset" --repo "$repo" 2>/tmp/upload_err; then
      echo "  + $name (${want_size} bytes, attempt $attempt)"
      ok=yes
      break
    fi
    err="$(tail -1 /tmp/upload_err)"
    echo "  . $name attempt $attempt failed: $err"
    # A leftover asset from the failed attempt blocks the next one by name.
    gh release delete-asset "$TAG" "$name" --repo "$repo" --yes 2>/dev/null || true
    sleep $((attempt * 10))
  done
  if [ "$ok" != yes ]; then
    echo "::error::could not upload $name after 4 attempts"
    failed=1
  fi
done

# ── 4. verify against the release, not against our own intentions ────────────
echo
echo "assets on $TAG:"
gh release view "$TAG" --repo "$repo" --json assets \
  --jq '.assets[] | "  \(.size)\t\(.name)"' | sort -k2

count="$(gh release view "$TAG" --repo "$repo" --json assets --jq '.assets | length')"
echo "total: $count asset(s)"

if [ "$failed" != 0 ]; then
  echo "::error::one or more assets failed to upload"
  exit 1
fi
# Every asset passed in must exist on the release. A count alone would not catch a
# missing file that was compensated by a stale one.
for asset in "$@"; do
  name="$(basename "$asset")"
  gh release view "$TAG" --repo "$repo" --json assets \
    --jq ".assets[] | select(.name == \"$name\") | .name" | grep -qx "$name" \
    || { echo "::error::$name is not on the release"; exit 1; }
done
echo "all assets verified on the release"
