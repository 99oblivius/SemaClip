#!/usr/bin/env python3
"""latest.json manifest operations for the release pipeline.

WHY THIS IS A FILE AND NOT AN INLINE HEREDOC: a `run: |` block in a GitHub
Actions workflow carries the block's own indentation into the script, so an
inline `python3 - <<'PY'` body arrives indented — IndentationError for the code
and a `PY` terminator that is no longer at column 0 (heredoc never closes). Both
failure modes are silent until the job runs. Keeping this here also makes the
manifest logic testable outside CI, which matters because a malformed manifest
is invisible to everyone except the updater that refuses it.

Subcommands:
  version-files <version>                          assert both version files agree
  init          <out> <version>                    write a fresh, empty-patch manifest
  merge         <path> <version> <from> <name> <sha>   add one patch entry
  artifact      <path> <version> <platform> <name> <sha> [url]   add/replace one artifact
  check         <path> <version>                   validate a published manifest

Run with no arguments for a self-test of init/merge/check.
"""
import json
import re
import sys

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

VERSION_FILES = ("frontend/package.json", "server/deno.json")


def fail(msg: str) -> None:
    sys.exit(f"::error::{msg}")


def cmd_version_files(version: str) -> int:
    """Both files must carry the version: package.json drives the UI banner
    (vite.config.ts) and deno.json is what deno desktop bakes in as
    Deno.desktopVersion. A drift means the updater compares the wrong current
    version and re-applies patches forever."""
    for path in VERSION_FILES:
        got = json.load(open(path)).get("version")
        if got != version:
            fail(f"{path} carries {got!r}, expected {version!r}")
        print(f"{path}: {got}")
    return 0


def cmd_init(out: str, version: str) -> int:
    """The manifest is PATCHES-ONLY: there is no full-artifact entry, so a user
    whose version is absent from `patches` stays put (gracefully). On the first
    nightly there is no previous version, so an empty `patches` object is the
    correct manifest, not a stub to replace later."""
    manifest = {"version": version, "patches": {}}
    with open(out, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(json.dumps(manifest))
    return 0


def cmd_merge(path: str, version: str, frm: str, name: str, sha: str) -> int:
    if not SHA256_RE.match(sha):
        # sha256 is mandatory and the runtime refuses a mismatch, so publishing a
        # malformed one turns every update from `frm` into a silent no-op.
        fail(f"{name}: sha256 {sha!r} is not 64 lowercase hex")
    if not name:
        fail("patch name is empty")

    with open(path) as fh:
        manifest = json.load(fh)

    patches = manifest.setdefault("patches", {})
    if not isinstance(patches, dict):
        fail("manifest `patches` is not an object")
    patches[frm] = {"name": name, "sha256": sha}
    # The manifest's own `version` must track the newest build, or a client
    # already on it sees a stale manifest and keeps re-checking.
    manifest["version"] = version

    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(json.dumps(manifest, indent=2))
    return 0



def cmd_artifact(path: str, version: str, platform: str, name: str, sha: str, url: str = "") -> int:
    """Record a whole-payload artifact for one platform.

    Windows does not take a bsdiff patch: Deno.autoUpdate cannot swap a loaded DLL,
    so a sidecar process updates the stopped app and downloads the full payload.
    Replacing the entry each release is deliberate — only the newest payload is
    ever fetched, and keeping old ones would grow the manifest without a reader."""
    if not SHA256_RE.match(sha):
        fail(f"artifact sha256 is not a 64-char hex digest: {sha!r}")
    with open(path) as fh:
        manifest = json.load(fh)
    artifacts = manifest.setdefault("artifacts", {})
    if not isinstance(artifacts, dict):
        fail("manifest `artifacts` is not an object")
    # The payload lives in the RELEASE, not beside the manifest on Pages, so an
    # explicit url is recorded when given. Without one a client would resolve the
    # name against the manifest's own directory and 404.
    entry = {"name": name, "sha256": sha}
    if url:
        entry["url"] = url
    artifacts[platform] = entry
    manifest["version"] = version

    with open(path, "w") as fh:
        json.dump(manifest, fh, indent=2)
        fh.write("\n")
    print(json.dumps(manifest, indent=2))
    return 0


def cmd_check(path: str, version: str, artifact_name: str = "") -> int:
    """Validate what is actually being SERVED, not what we meant to write."""
    with open(path) as fh:
        manifest = json.load(fh)

    if manifest.get("version") != version:
        fail(f"live manifest version {manifest.get('version')!r} != {version!r}")

    patches = manifest.get("patches")
    if not isinstance(patches, dict):
        fail("live manifest has no `patches` object")

    for frm, entry in patches.items():
        if not isinstance(entry, dict):
            fail(f"patches[{frm}] is not an object")
        sha, name = entry.get("sha256"), entry.get("name")
        if not isinstance(sha, str) or not SHA256_RE.match(sha):
            fail(f"patches[{frm}].sha256 is not 64 lowercase hex: {sha!r}")
        if not isinstance(name, str) or not name:
            fail(f"patches[{frm}].name is missing")

    # The whole-payload entries must describe THIS version's bytes. A manifest whose
    # `version` advanced while its `artifacts` still name the previous release is the
    # worst shape there is: the client is offered an update, downloads the file it is
    # already running, and offers again on the next launch, for ever. MEASURED: the
    # patch job merged into a stale CDN copy of the manifest and republished it, so
    # 26.256 shipped advertising `download/v26.255/...AppImage` at 26.255's sha256 —
    # and this check passed anyway, because every url resolved and every digest was
    # well-formed. Well-formed is not the same as CURRENT; the version token in the
    # name and the url is what ties an entry to the release it belongs to.
    if artifact_name:
        artifacts = manifest.get("artifacts")
        if not isinstance(artifacts, dict) or not artifacts:
            fail("live manifest carries no `artifacts` — no client could resolve a payload")
        for plat, entry in artifacts.items():
            if not isinstance(entry, dict):
                fail(f"artifacts[{plat}] is not an object")
            name, url = entry.get("name"), entry.get("url")
            if not isinstance(name, str) or not name:
                fail(f"artifacts[{plat}].name is missing")
            url_s = url if isinstance(url, str) else ""
            sha = entry.get("sha256")
            if not isinstance(sha, str) or not SHA256_RE.match(sha):
                fail(f"artifacts[{plat}].sha256 is not 64 lowercase hex: {sha!r}")
            # The AppImage keeps an unversioned filename, so its url must name the
            # release directory; every other artifact carries the version in its name.
            marker = f"v{version}" if name == artifact_name else version
            if marker not in name and marker not in url_s:
                fail(
                    f"artifacts[{plat}] does not belong to {version}: "
                    f"name={name!r} url={url!r} — a client would download the wrong build"
                )

    print(f"live manifest ok: version={version} patches={list(patches)} artifacts={list(manifest.get('artifacts') or {})}")
    return 0


def self_test() -> int:
    import tempfile
    from pathlib import Path

    with tempfile.TemporaryDirectory() as d:
        p = str(Path(d) / "latest.json")
        cmd_init(p, "2026.142-nightly.43")
        assert json.load(open(p)) == {"version": "2026.142-nightly.43", "patches": {}}
        # An empty-patch manifest must pass check: that is the first-nightly case.
        cmd_check(p, "2026.142-nightly.43")

        sha = "a" * 64
        cmd_merge(p, "2026.142-nightly.43", "2026.141-nightly.42",
                  "patch-2026.141-nightly.42-to-2026.142-nightly.43.bin", sha)
        cmd_check(p, "2026.142-nightly.43")
        got = json.load(open(p))
        assert got["patches"]["2026.141-nightly.42"]["sha256"] == sha, got

        # A malformed sha must be rejected rather than published.
        try:
            cmd_merge(p, "2026.142-nightly.43", "x", "n.bin", "A" * 64)
        except SystemExit:
            pass
        else:
            raise AssertionError("uppercase sha256 was accepted")

        # A version drift in the served manifest must fail the check.
        try:
            cmd_check(p, "2026.999-nightly.1")
        except SystemExit:
            pass
        else:
            raise AssertionError("version drift was accepted")

        # THE SHIPPED DEFECT, pinned. A manifest whose `version` advanced while its
        # `artifacts` still name the previous release is what made a client download
        # the build it was already running and re-offer the update for ever. It passed
        # the old check because every url resolved and every digest was well-formed —
        # so the check must key on the version the entry BELONGS to, not on validity.
        cmd_artifact(p, "2026.142-nightly.43", "linux-x64", "SemaClip.AppImage", "c" * 64,
                     "https://example.test/releases/download/v2026.142-nightly.43/SemaClip.AppImage")
        cmd_check(p, "2026.142-nightly.43", "SemaClip.AppImage")
        # Now the exact stale shape: version moved on, artifact left behind.
        stale = dict(doc := json.load(open(p)))
        doc["version"] = "2026.143-nightly.44"
        doc["artifacts"]["linux-x64"]["url"] = \
            "https://example.test/releases/download/v2026.142-nightly.43/SemaClip.AppImage"
        with open(p, "w") as fh:
            json.dump(doc, fh)
        try:
            cmd_check(p, "2026.143-nightly.44", "SemaClip.AppImage")
        except SystemExit:
            pass
        else:
            raise AssertionError("a stale artifact entry was accepted — a client would download the previous build")
        # And a versioned filename is checked by its own name, not only by its url.
        doc["artifacts"]["win-x64"] = {"name": "SemaClip-2026.142-nightly.43-win-x64-portable.zip",
                                       "sha256": "d" * 64, "url": "https://example.test/x"}
        with open(p, "w") as fh:
            json.dump(doc, fh)
        try:
            cmd_check(p, "2026.143-nightly.44", "SemaClip.AppImage")
        except SystemExit:
            pass
        else:
            raise AssertionError("a stale versioned artifact name was accepted")
        # Restore a consistent manifest so the remaining assertions start clean.
        cmd_artifact(p, "2026.143-nightly.44", "linux-x64", "SemaClip.AppImage", "e" * 64,
                     "https://example.test/releases/download/v2026.143-nightly.44/SemaClip.AppImage")
        cmd_artifact(p, "2026.143-nightly.44", "win-x64", "SemaClip-2026.143-nightly.44-win-x64-portable.zip",
                     "d" * 64, "https://example.test/x")
        cmd_check(p, "2026.143-nightly.44", "SemaClip.AppImage")

        # artifact: additive to `patches`, replaced in place, digest validated.
        cmd_artifact(p, "2026.142-nightly.43", "win-x64", "payload.zip", "a" * 64)
        doc = json.load(open(p))
        if doc["artifacts"]["win-x64"]["name"] != "payload.zip":
            raise AssertionError("artifact entry not recorded")
        if "2026.141-nightly.42" not in doc["patches"]:
            raise AssertionError("artifact write dropped the patch entries")
        cmd_artifact(p, "2026.142-nightly.43", "win-x64", "payload2.zip", "b" * 64)
        doc = json.load(open(p))
        if doc["artifacts"]["win-x64"]["name"] != "payload2.zip":
            raise AssertionError("artifact entry was not replaced")
        try:
            cmd_artifact(p, "2026.142-nightly.43", "win-x64", "x.zip", "NOT-A-HASH")
        except SystemExit:
            pass
        else:
            raise AssertionError("a malformed artifact digest was accepted")

    print("self-test OK (init/merge/artifact/check, empty patches, bad sha, version drift)")
    return 0


def main() -> int:
    if len(sys.argv) < 2:
        return self_test()
    cmd, args = sys.argv[1], sys.argv[2:]
    if cmd == "self-test":
        return self_test()
    table = {
        "version-files": (cmd_version_files, 1),
        "init": (cmd_init, 2),
        "merge": (cmd_merge, 5),
        "artifact": (cmd_artifact, (5, 6)),
        "check": (cmd_check, (2, 3)),
    }
    if cmd not in table:
        print(__doc__, file=sys.stderr)
        return 2
    fn, arity = table[cmd]
    # arity is an int, or a tuple of accepted counts for subcommands with an
    # optional trailing argument.
    allowed = arity if isinstance(arity, tuple) else (arity,)
    if len(args) not in allowed:
        want = " or ".join(str(a) for a in allowed)
        print(f"FAIL: {cmd} takes {want} argument(s), got {len(args)}", file=sys.stderr)
        return 2
    return fn(*args)


if __name__ == "__main__":
    raise SystemExit(main())
