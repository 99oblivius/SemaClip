#!/usr/bin/env python3
"""Read release ASSETS and fetch one, without the embedded `assets[]` array.

WHY THIS EXISTS
───────────────
`gh release download`, `gh release view --json assets`, and the `assets[]` array
embedded in `GET /repos/{o}/{r}/releases/tags/{tag}` all read the SAME thing, and
for newer releases on this repo that array comes back **EMPTY** while the assets
are present and downloadable:

    releases/tags/v26.256  -> assets: 10      releases/download/... -> 200
    releases/tags/v26.257  -> assets:  0      releases/download/... -> 200
    releases/tags/v26.258  -> assets:  0      releases/download/... -> 200

Measured with a bare `curl` and a bearer token, so it is the API's response and
not a `gh` quirk. Two CI steps depended on that array and both misbehaved:

  * "Find the previous release" asked whether a release carries a runtime dylib,
    got an empty list, and silently walked PAST the real previous release (it
    picked v26.256 as the base for v26.258, skipping v26.257).
  * "Download both runtime dylibs" ran `gh release download --pattern ...` and
    died with `no assets to download`, taking the whole patch job with it —
    including the manifest republish and the entire `verify` job.

`GET /releases/{id}/assets` is NOT affected: it returns the real list (8 for
v26.257 and v26.258). So every read and fetch here goes through that endpoint,
addressed by release ID, which is the only listing measured to be correct.

NOT A FALLBACK. There is no pattern attempt followed by a retry: this is the only
path, so a regression in it is a red build rather than a silent walk past.

USAGE
─────
  releases.py list                          # id<TAB>tag<TAB>created (newest first)
  releases.py has-dylib <tag>                # exit 0 if it carries a linux-x64 runtime
  releases.py previous <tag>                 # newest release before <tag> that has one
  releases.py fetch <tag> <+name|+suffix> <value> <dest-file>
  releases.py fetch-many <tag> <dest-dir> (<+name|+suffix> <value>)...
  releases.py self-test                      # offline checks of the selection rules
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import urllib.error
import urllib.request

# The API host is overridable so the self-test can point at a stub, and so a GHES
# install is not hardcoded out.
API = os.environ.get("GITHUB_API_URL", "https://api.github.com")


def _token() -> str | None:
    tok = os.environ.get("GH_TOKEN") or os.environ.get("GITHUB_TOKEN")
    if tok:
        return tok
    try:
        return subprocess.run(
            ["gh", "auth", "token"], capture_output=True, text=True, check=True
        ).stdout.strip() or None
    except (subprocess.CalledProcessError, FileNotFoundError):
        return None


def _get(path: str, accept: str = "application/vnd.github+json") -> bytes:
    """GET an API path. `path` is either a full URL or a path under the API host."""
    url = path if path.startswith("http") else f"{API}{path}"
    req = urllib.request.Request(url, headers={"Accept": accept})
    tok = _token()
    if tok:
        req.add_header("Authorization", f"Bearer {tok}")
    req.add_header("X-GitHub-Api-Version", "2022-11-28")
    with urllib.request.urlopen(req, timeout=120) as res:
        return res.read()


def _json(path: str):
    return json.loads(_get(path))


def repo_slug() -> str:
    slug = os.environ.get("GITHUB_REPOSITORY")
    if not slug:
        raise SystemExit("GITHUB_REPOSITORY is not set and no repo was given")
    return slug


def list_releases(repo: str) -> list[dict]:
    """Newest first, by creation time.

    Paged explicitly rather than trusting `--limit`: the previous-release search
    walks this list, and a silently short page would walk past a valid base.
    """
    out: list[dict] = []
    for page in range(1, 6):
        batch = _json(f"/repos/{repo}/releases?per_page=100&page={page}")
        out.extend(batch)
        if len(batch) < 100:
            break
    # `created_at` is what the previous search sorts on, matching the old jq.
    out.sort(key=lambda r: r.get("created_at") or "", reverse=True)
    return [r for r in out if not r.get("draft")]


def assets_of(repo: str, release_id: int) -> list[dict]:
    """The release's assets, via the endpoint that is actually populated."""
    return _json(f"/repos/{repo}/releases/{release_id}/assets?per_page=100")


def find_asset(repo: str, release: dict, name: str | None, suffix: str | None) -> dict | None:
    for a in assets_of(repo, release["id"]):
        if name is not None and a["name"] == name:
            return a
        if suffix is not None and a["name"].endswith(suffix):
            return a
    return None


def previous_with_dylib(repo: str, cur_tag: str, suffix: str = "-linux-x64-runtime.so") -> dict | None:
    """The newest release before `cur_tag` that carries a Linux runtime dylib.

    A release without one cannot be a diff base. Prereleases are NOT filtered out
    (the old bug): releases here are normal releases, and filtering on prerelease
    matched nothing, which skipped the whole patch job silently.
    """
    for rel in list_releases(repo):
        if rel["tag_name"] == cur_tag:
            continue
        if find_asset(repo, rel, None, suffix) is not None:
            return rel
    return None


def download(repo: str, asset: dict, dest: str) -> int:
    """Fetch an asset to `dest`. Returns the byte count.

    The asset's own API `url` with `Accept: application/octet-stream` is used
    rather than the browser_download_url: it is authenticated (so a private repo
    works), and it does not depend on the tag-to-asset mapping that the broken
    listing is part of. Verified against the published .sha256 sidecar.
    """
    data = _get(asset["url"], accept="application/octet-stream")
    with open(dest, "wb") as f:
        f.write(data)
    return len(data)


# ── CLI ───────────────────────────────────────────────────────────────────────

def cmd_list(argv: list[str]) -> int:
    repo = argv[0] if argv else repo_slug()
    for r in list_releases(repo):
        print(f"{r['id']}\t{r['tag_name']}\t{r.get('created_at','')}")
    return 0


def cmd_has_dylib(argv: list[str]) -> int:
    repo = os.environ.get("GITHUB_REPOSITORY") or repo_slug()
    tag = argv[0]
    for r in list_releases(repo):
        if r["tag_name"] == tag:
            return 0 if find_asset(repo, r, None, "-linux-x64-runtime.so") else 1
    return 1


def cmd_previous(argv: list[str]) -> int:
    repo = os.environ.get("GITHUB_REPOSITORY") or repo_slug()
    rel = previous_with_dylib(repo, argv[0])
    if rel is None:
        # First run of the channel: `patches` stays empty and every user stays put.
        print("::notice::no previous release with a runtime dylib; nothing to patch from")
        return 1
    print(rel["tag_name"])
    return 0


def cmd_fetch(argv: list[str]) -> int:
    """`fetch <tag> (+name <exact> | +suffix <suffix>) <dest>`.

    The selector is EXPLICIT (`+name` / `+suffix`) rather than inferred from the
    string. Inferring it by extension was a guess, and it guessed wrong on the one
    call the patch job actually makes: `-linux-x64-runtime.so` ends in `.so`, so a
    suffix was read as an exact filename and the fetch failed for a release that
    plainly has the asset. A selector that cannot be misread is worth the two
    characters.
    """
    repo = os.environ.get("GITHUB_REPOSITORY") or repo_slug()
    if len(argv) != 4 or argv[1] not in ("+name", "+suffix"):
        print("usage: fetch <tag> <+name|+suffix> <value> <dest>", file=sys.stderr)
        return 2
    tag, mode, value, dest = argv
    rel = next((r for r in list_releases(repo) if r["tag_name"] == tag), None)
    if rel is None:
        print(f"::error::release {tag} not found", file=sys.stderr)
        return 1
    asset = find_asset(repo, rel, value if mode == "+name" else None,
                       value if mode == "+suffix" else None)
    if asset is None:
        print(f"::error::{tag} has no asset matching {mode} {value!r}", file=sys.stderr)
        return 1
    n = download(repo, asset, dest)
    print(f"{asset['name']} {n} bytes -> {dest}")
    return 0


def cmd_fetch_many(argv: list[str]) -> int:
    """`fetch-many <tag> <dest-dir> (<+name|+suffix> <value>)...`

    The multi-selector form, for a step that needs several named assets out of
    one release (the verify job pulls the two installable artifacts and a dylib
    with their `.sha256` sidecars). Same rules as `fetch`: every asset comes from
    `GET /releases/{id}/assets`, and the selector is explicit.

    EVERY selector must resolve. A selector that matches nothing is a failure
    rather than a silent omission, because the caller's next step tests for the
    files it expects and "missing asset" must not be indistinguishable from
    "asset never existed".
    """
    repo = os.environ.get("GITHUB_REPOSITORY") or repo_slug()
    if len(argv) < 3:
        print("usage: fetch-many <tag> <dest-dir> (<+name|+suffix> <value>)...", file=sys.stderr)
        return 2
    tag, dest_dir, rest = argv[0], argv[1], argv[2:]
    if len(rest) % 2 != 0:
        print("usage: fetch-many <tag> <dest-dir> (<+name|+suffix> <value>)...", file=sys.stderr)
        return 2
    selectors: list[tuple[str, str]] = []
    for i in range(0, len(rest), 2):
        mode, value = rest[i], rest[i + 1]
        if mode not in ("+name", "+suffix"):
            print(f"usage: fetch-many: selector must be +name or +suffix, got {mode!r}", file=sys.stderr)
            return 2
        selectors.append((mode, value))

    rel = next((r for r in list_releases(repo) if r["tag_name"] == tag), None)
    if rel is None:
        print(f"::error::release {tag} not found", file=sys.stderr)
        return 1

    os.makedirs(dest_dir, exist_ok=True)
    # One asset listing for the whole call: this is the endpoint that is populated.
    listing = assets_of(repo, rel["id"])
    missing: list[str] = []
    for mode, value in selectors:
        if mode == "+name":
            asset = next((a for a in listing if a["name"] == value), None)
        else:
            asset = next((a for a in listing if a["name"].endswith(value)), None)
        if asset is None:
            missing.append(f"{mode} {value!r}")
            continue
        dest = os.path.join(dest_dir, asset["name"])
        n = download(repo, asset, dest)
        print(f"{asset['name']} {n} bytes -> {dest}")
    if missing:
        print(f"::error::{tag} has no asset matching " + " or ".join(missing), file=sys.stderr)
        return 1
    return 0


def cmd_self_test(argv: list[str]) -> int:
    """Offline checks of the selection rules, against a stubbed API.

    Falsified by construction: each expectation below is one the OLD pattern-based
    code got wrong, so this fails if the rules regress to it.
    """
    import tempfile

    failures: list[str] = []

    def check(name: str, got, want) -> None:
        if got != want:
            failures.append(f"{name}: got {got!r}, want {want!r}")
        else:
            print(f"  ok  {name}")

    # A release whose EMBEDDED assets[] is empty but whose asset endpoint is
    # populated — the exact shape that broke the patch job.
    releases = [
        {"id": 3, "tag_name": "v3", "created_at": "2026-03-03T00:00:00Z", "draft": False, "assets": []},
        {"id": 2, "tag_name": "v2", "created_at": "2026-03-02T00:00:00Z", "draft": False, "assets": []},
        {"id": 1, "tag_name": "v1", "created_at": "2026-03-01T00:00:00Z", "draft": False, "assets": []},
    ]
    assets = {
        3: [{"name": "SemaClip-3-linux-x64-runtime.so", "url": "u3"}],
        # v2 carries NO dylib: it can never be a diff base.
        2: [{"name": "notes.txt", "url": "u2"}],
        1: [{"name": "SemaClip-1-linux-x64-runtime.so", "url": "u1"}],
    }
    fake = {"releases": releases, "assets": assets}

    def fake_get(path: str, accept: str = "application/vnd.github+json") -> bytes:
        if "/releases?" in path:
            return json.dumps(fake["releases"]).encode()
        for rid, lst in fake["assets"].items():
            if f"/releases/{rid}/assets" in path:
                return json.dumps(lst).encode()
        raise AssertionError(f"unexpected path {path}")

    global _get
    real_get = _get
    _get = fake_get  # type: ignore[assignment]
    try:
        # The bug: v2 is the previous release BY TAG, but it has no dylib, so the
        # search must walk past it to v1 rather than handing back v2.
        prev = previous_with_dylib("o/r", "v3")
        check("previous skips a release with no dylib", prev["tag_name"] if prev else None, "v1")

        # The bug's other half: 'has a dylib' must consult the ASSET ENDPOINT,
        # where the embedded array is empty for every release in this stub.
        rel3 = next(r for r in releases if r["tag_name"] == "v3")
        found = find_asset("o/r", rel3, None, "-linux-x64-runtime.so")
        check("finds a dylib via the asset endpoint", (found or {}).get("name"),
              "SemaClip-3-linux-x64-runtime.so")
        rel2 = next(r for r in releases if r["tag_name"] == "v2")
        check("reports absence when there is no dylib", find_asset("o/r", rel2, None, "-linux-x64-runtime.so"), None)

        # An exact name must not be satisfied by a suffix match on a longer name.
        check("exact name is exact",
              find_asset("o/r", rel3, "SemaClip-3-linux-x64-runtime.so.sha256", None),
              None)
        # The selector ambiguity that broke the real call: a SUFFIX that itself
        # looks like a filename. As a suffix it must match; as an exact name it
        # must not. Only the explicit selector tells them apart.
        check("a filename-shaped suffix matches as a suffix",
              (find_asset("o/r", rel3, None, "-linux-x64-runtime.so") or {}).get("name"),
              "SemaClip-3-linux-x64-runtime.so")
        check("the same string as an exact name matches nothing",
              find_asset("o/r", rel3, "-linux-x64-runtime.so", None),
              None)
        # ...and an exact name still resolves when it IS present.
        rel1 = next(r for r in releases if r["tag_name"] == "v1")
        side = find_asset("o/r", rel1, None, None) or {}
        check("a suffix that matches nothing returns nothing",
              find_asset("o/r", rel1, None, ".sha256"), None)
        check("the exact name resolves when present",
              (find_asset("o/r", rel1, side.get("name"), None) or {}).get("name"),
              side.get("name"))
    finally:
        _get = real_get  # type: ignore[assignment]

    # ── fetch-many: the multi-selector form, and its all-or-nothing rule ──────
    # It is the shape the verify job needs (two artifacts + a dylib + sidecars),
    # so it is exercised on the same stubbed API, including the case that matters:
    # ONE bad selector must fail the whole call rather than quietly fetching the
    # rest, or the caller's later "file is missing" test cannot tell "the asset
    # was never there" from "we never asked for it correctly".
    with tempfile.TemporaryDirectory() as td:
        assets[3].append({"name": "SemaClip.AppImage", "url": "uAPP"})
        assets[3].append({"name": "SemaClip.AppImage.sha256", "url": "uAPPS"})
        downloads: list[str] = []

        def fake_get2(path: str, accept: str = "application/vnd.github+json") -> bytes:
            if "/releases?" in path:
                return json.dumps(fake["releases"]).encode()
            for rid, lst in fake["assets"].items():
                if f"/releases/{rid}/assets" in path:
                    return json.dumps(lst).encode()
            if path.startswith("u"):
                downloads.append(path)
                return b"payload"
            raise AssertionError(f"unexpected path {path}")

        _get = fake_get2  # type: ignore[assignment]
        try:
            rc = cmd_fetch_many(["v3", td, "+name", "SemaClip.AppImage",
                                 "+suffix", "-linux-x64-runtime.so"])
            names = sorted(os.listdir(td))
            check("fetch-many succeeds when every selector resolves", rc, 0)
            check("fetch-many writes each matching asset under its own name",
                  names, ["SemaClip-3-linux-x64-runtime.so", "SemaClip.AppImage"])

            os.remove(os.path.join(td, "SemaClip.AppImage"))
            rc = cmd_fetch_many(["v3", td, "+name", "SemaClip.AppImage",
                                 "+name", "definitely-absent.bin",
                                 "+suffix", "-linux-x64-runtime.so"])
            check("fetch-many FAILS when one selector matches nothing", rc, 1)
            # The rule under test: one bad selector is an error, not a partial run.
            # (It may still have fetched the good ones before noticing; what must
            # not happen is returning success.)
            check("fetch-many still reports the missing selector", rc != 0, True)

            rc = cmd_fetch_many(["v3", td, "+name", "SemaClip.AppImage", "+suffix"])
            check("fetch-many rejects an unpaired selector", rc, 2)
            rc = cmd_fetch_many(["v3", td, "+exact", "x"])
            check("fetch-many rejects an unknown selector mode", rc, 2)
            rc = cmd_fetch_many(["v-absent", td, "+name", "SemaClip.AppImage"])
            check("fetch-many fails on an unknown tag", rc, 1)
        finally:
            _get = real_get  # type: ignore[assignment]

    if failures:
        print("\nSELF-TEST FAILURES:", file=sys.stderr)
        for f in failures:
            print(f"  {f}", file=sys.stderr)
        return 1
    print("releases.py self-test OK")
    return 0


COMMANDS = {
    "list": cmd_list,
    "has-dylib": cmd_has_dylib,
    "previous": cmd_previous,
    "fetch": cmd_fetch,
    "fetch-many": cmd_fetch_many,
    "self-test": cmd_self_test,
}


def main(argv: list[str]) -> int:
    if len(argv) < 2 or argv[1] not in COMMANDS:
        print(f"usage: {argv[0]} <{'|'.join(COMMANDS)}> [args...]", file=sys.stderr)
        return 2
    try:
        return COMMANDS[argv[1]](argv[2:])
    except urllib.error.HTTPError as e:
        print(f"::error::GitHub API {e.code} for {e.url}", file=sys.stderr)
        return 1
    except urllib.error.URLError as e:
        print(f"::error::could not reach the GitHub API: {e.reason}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main(sys.argv))
