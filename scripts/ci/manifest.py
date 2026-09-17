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


def cmd_check(path: str, version: str) -> int:
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

    print(f"live manifest ok: version={version} patches={list(patches)}")
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

    print("self-test OK (init/merge/check, empty patches, bad sha, version drift)")
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
        "check": (cmd_check, 2),
    }
    if cmd not in table:
        print(__doc__, file=sys.stderr)
        return 2
    fn, arity = table[cmd]
    if len(args) != arity:
        print(f"FAIL: {cmd} takes {arity} argument(s), got {len(args)}", file=sys.stderr)
        return 2
    return fn(*args)


if __name__ == "__main__":
    raise SystemExit(main())
