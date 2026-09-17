#!/usr/bin/env python3
"""Wrap a latest.json manifest in Deno's Ed25519 signing envelope.

NOT YET EXERCISED. No signing key exists, Deno.autoUpdate is not called with a
publicKey yet, and `deno desktop`'s manifest signature is therefore not being
verified by any client today. This script exists so that turning signing on is a
one-line change instead of a research project — treat its output as unverified
until a run with a real key is confirmed against a real client.

Usage: sign-manifest.py <manifest.json> <base64-private-key>
  Rewrites the file in place as:
    {"signed": "<the manifest JSON as a string>", "signature": "<base64 ed25519 sig>"}
  The signature is over the exact bytes of the `signed` string, so the string is
  serialised ONCE and both signed and emitted — re-serialising after signing is
  the classic way to produce a signature no client accepts.

Requires: pip install cryptography
"""
import base64
import json
import sys

from cryptography.hazmat.primitives.asymmetric.ed25519 import Ed25519PrivateKey


def main() -> int:
    if len(sys.argv) != 3:
        print(__doc__, file=sys.stderr)
        return 2
    path, key_b64 = sys.argv[1], sys.argv[2]

    if not key_b64:
        print("FAIL: empty signing key", file=sys.stderr)
        return 1

    try:
        raw = base64.b64decode(key_b64, validate=True)
    except Exception as exc:  # noqa: BLE001 - report and stop
        print(f"FAIL: signing key is not valid base64: {exc}", file=sys.stderr)
        return 1
    if len(raw) != 32:
        print(f"FAIL: expected a 32-byte Ed25519 key, got {len(raw)}", file=sys.stderr)
        return 1

    manifest = json.load(open(path))

    # Deno reads `patches` and `version` from the parsed `signed` string. An empty
    # patches object is valid (first nightly); the envelope must not invent one.
    manifest.setdefault("patches", {})
    signed = json.dumps(manifest, separators=(",", ":"), sort_keys=True)
    signature = Ed25519PrivateKey.from_private_bytes(raw).sign(signed.encode("utf-8"))

    envelope = {"signed": signed, "signature": base64.b64encode(signature).decode("ascii")}
    with open(path, "w") as fh:
        json.dump(envelope, fh, indent=2)
        fh.write("\n")

    print(f"signed {path}: {len(signed)} bytes, signature {len(signature)} bytes")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
