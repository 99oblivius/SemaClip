#!/usr/bin/env python3
"""Generate the public landing page for a published SemaClip release.

WHY THIS IS A FILE AND NOT AN INLINE HEREDOC: a `run: |` block in a GitHub Actions
workflow carries its own indentation into the script, so an inline `python3 - <<'PY'`
body arrives indented. That is an IndentationError, and the `PY` terminator is no
longer at column 0 so the heredoc never closes. Both failures are silent until the job
actually runs.

WHY THE PAGE IS GENERATED PER RELEASE rather than being a static file that looks up the
newest download: anything that must name a version has to learn it. Baking it in at
publish time means the page always names an artifact this very run uploaded, needs no
API call, hits no rate limit, and cannot show a stale or wrong version.

USAGE
  landing.py <out.html> <version> <release-url> <asset:os:arch:label>...

  asset spec:  <asset-name>:<os>:<arch>:<label>
               os is linux|windows|macos, arch is x64|arm64
"""

import html
import json
import sys

# Kept in step with frontend/src/app.css so the page reads as the same product.
FOUNDATION = "#0b0b10"
SURFACE = "#16161f"
SURFACE_2 = "#24242f"
BORDER = "#2e2e3a"
INK = "#ffffff"
ASH = "#a1a1aa"
ASH_DIM = "#71717a"
ACCENT = "#cc0000"
WARNING = "#eab308"

OS_LABELS = {"linux": "Linux", "windows": "Windows", "macos": "macOS"}
OS_ORDER = ["windows", "linux", "macos"]

REPO = "https://github.com/99oblivius/SemaClip"

# An em-dash reads as machine-written prose and was called out for exactly that, so
# the generated page must not contain one. The release workflow asserts this too.
FORBIDDEN = "\u2014"


def parse_asset(spec: str) -> dict:
    parts = spec.split(":")
    if len(parts) != 4:
        sys.exit(f"::error::bad asset spec {spec!r}; expected name:os:arch:label")
    name, os_name, arch, label = parts
    if os_name not in OS_LABELS:
        sys.exit(f"::error::unknown os {os_name!r} in {spec!r}")
    return {"name": name, "os": os_name, "arch": arch, "label": label}


def rank(a: dict) -> int:
    """Prefer something installable, then a single-file bundle."""
    if a["name"].endswith((".msi", ".AppImage", ".dmg")):
        return 0
    if a["name"].endswith(".deb"):
        return 1
    return 2


def hint_for(asset: dict) -> str:
    """One line telling the user what to do with the file they just downloaded."""
    if asset["os"] == "windows":
        if asset["name"].endswith(".msi"):
            return "Run the installer. It is unsigned, so Windows will warn about an unknown publisher."
        # The portable build is the Windows download, and it keeps itself up to date when
        # started through the bundled launcher — worth saying, since there is no installer.
        return (
            "Nothing to install. Unzip it anywhere you can write, then run "
            "<code>SemaClip.exe</code>. Start it through "
            "<code>Update and launch SemaClip.cmd</code> and it updates itself."
        )
    if asset["os"] == "linux":
        if asset["name"].endswith(".AppImage"):
            return "Nothing to install. Mark it executable, then run it. It needs <code>webkit2gtk</code>."
        return "Install with your package manager."
    return "Open the disk image and drag SemaClip across to Applications."


def card(os_name: str, group: list[dict], release_url: str) -> str:
    ordered = sorted(group, key=rank)
    links = "\n".join(
        f'        <a class="dl" href="{html.escape(release_url)}/{html.escape(a["name"])}"\n'
        f'           data-os="{a["os"]}" data-arch="{a["arch"]}">\n'
        f'          <span class="dl-label">{html.escape(a["label"])}</span>\n'
        f'          <span class="dl-meta">{OS_LABELS[os_name]} &middot; '
        f'{html.escape(a["arch"])} &middot; {html.escape(a["name"].rsplit(".", 1)[-1])}</span>\n'
        f"        </a>"
        for a in ordered
    )
    return (
        f'    <section class="card" id="card-{os_name}" data-os-card="{os_name}">\n'
        f"      <h3>{OS_LABELS[os_name]}</h3>\n"
        f'      <div class="links">\n{links}\n      </div>\n'
        f'      <p class="hint">{hint_for(ordered[0])}</p>\n'
        f"    </section>"
    )


def render(version: str, release_url: str, assets: list[dict]) -> str:
    by_os: dict[str, list[dict]] = {}
    for a in assets:
        by_os.setdefault(a["os"], []).append(a)

    present = [o for o in OS_ORDER if o in by_os]
    # The build cannot know who is downloading, so one platform is rendered in the
    # main slot and a script swaps in the right one. Every platform's card is in the
    # document either way, so the page is complete and usable as served.
    first = present[0] if present else None
    rest = present[1:]

    primary_card = card(first, by_os[first], release_url) if first else ""
    other_cards = "\n".join(card(o, by_os[o], release_url) for o in rest)
    others_html = (
        '  <details class="others" id="other-oss">\n'
        "    <summary>Other operating systems</summary>\n"
        f'    <div class="other-grid">\n{other_cards}\n    </div>\n'
        "  </details>"
        if rest
        else ""
    )

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SemaClip</title>
<meta name="description" content="SemaClip opens a Twitch VOD and marks the moments that might be worth clipping. It runs on your machine.">
<style>
  :root {{
    --foundation: {FOUNDATION};
    --surface: {SURFACE};
    --surface-2: {SURFACE_2};
    --border: {BORDER};
    --ink: {INK};
    --ash: {ASH};
    --ash-dim: {ASH_DIM};
    --accent: {ACCENT};
    --warning: {WARNING};
    --display: 'Space Grotesk', system-ui, sans-serif;
    --body: 'Inter', system-ui, sans-serif;
    --mono: 'JetBrains Mono', ui-monospace, monospace;
  }}
  * {{ box-sizing: border-box; }}
  body {{
    margin: 0; background: var(--foundation); color: var(--ink);
    font-family: var(--body); line-height: 1.55;
  }}
  a {{ color: inherit; }}
  .wrap {{ max-width: 42rem; margin: 0 auto; padding-left: 1.5rem; padding-right: 1.5rem; }}
  .bar {{
    display: flex; align-items: center; gap: .75rem; height: 2.75rem;
    border-bottom: 1px solid var(--border);
  }}
  .wordmark {{ font-family: var(--display); font-weight: 700; letter-spacing: -.01em; }}
  .wordmark span {{ color: var(--accent); }}
  .ver {{ font-family: var(--mono); font-size: .6875rem; color: var(--ash-dim); }}
  /* The pre-alpha notice, matching the app's own header. This is the honest state of
     the software and the page must not imply otherwise. */
  .prealpha {{
    margin-left: auto; font-family: var(--mono); font-size: .6875rem; font-weight: 700;
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-radius: .25rem; padding: .1rem .5rem;
  }}

  main.wrap {{ padding-top: 3rem; padding-bottom: 3rem; }}
  h1 {{ font-family: var(--display); font-size: clamp(1.5rem, 4vw, 2rem); line-height: 1.15; margin: 0 0 .75rem; }}
  .lede {{ font-size: 1rem; color: var(--ash); margin: 0 0 1rem; }}
  .state {{ font-size: .9375rem; color: var(--ash-dim); margin: 0 0 2.25rem; }}
  .state strong {{ color: var(--warning); font-weight: 600; }}

  h2 {{ font-family: var(--display); font-size: .8125rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ash); margin: 0 0 .75rem; }}
  .card h3 {{ font-family: var(--display); font-size: .8125rem; text-transform: uppercase; letter-spacing: .06em; color: var(--ash); margin: 0 0 .5rem; }}
  .links {{ display: flex; flex-direction: column; gap: .5rem; }}
  .dl {{
    display: flex; flex-direction: column; text-decoration: none;
    border: 1px solid var(--border); background: var(--surface-2);
    border-radius: .375rem; padding: .625rem .75rem;
  }}
  .dl:hover {{ border-color: var(--accent); }}
  .dl-label {{ font-weight: 600; }}
  .dl-meta {{ font-family: var(--mono); font-size: .6875rem; color: var(--ash-dim); }}
  .hint {{ font-size: .8125rem; color: var(--ash-dim); margin: .75rem 0 0; }}
  .hint code {{ font-family: var(--mono); color: var(--ash); }}

  .others {{
    margin-top: 1.5rem; border: 1px solid var(--border); border-radius: .375rem;
    background: var(--surface);
  }}
  .others > summary {{
    cursor: pointer; padding: .625rem .875rem; font-size: .875rem; color: var(--ash);
    list-style: none;
  }}
  .others > summary::-webkit-details-marker {{ display: none; }}
  .others > summary::before {{ content: '+  '; font-family: var(--mono); color: var(--ash-dim); }}
  .others[open] > summary::before {{ content: '-  '; }}
  .others > summary:hover {{ color: var(--ink); }}
  .other-grid {{ display: grid; gap: 1rem; padding: 0 .875rem 1rem; }}

  footer.wrap {{
    border-top: 1px solid var(--border); margin-top: 2.5rem;
    padding-top: 1.5rem; padding-bottom: 3rem;
    color: var(--ash-dim); font-size: .8125rem;
  }}
  footer a {{ color: var(--ash); }}
</style>
</head>
<body>
<div class="wrap">
  <div class="bar">
    <span class="wordmark">Sema<span>Clip</span></span>
    <span class="ver">v{html.escape(version)}</span>
    <span class="prealpha">pre-alpha</span>
  </div>
</div>

<main class="wrap">
  <h1>SemaClip</h1>
  <p class="lede">
    Opens a Twitch VOD and marks the moments that might be worth clipping, so you can
    look them over in one pass instead of scrubbing through the whole stream. It runs
    on your machine, and it keeps working with the network off.
  </p>
  <p class="state">
    <strong>Not finished.</strong> Downloading a VOD works, and detection works.
    Review and export are still being built, so making a clip from start to finish
    does not work yet. Expect it to break.
  </p>

  <h2 id="download-heading">Download</h2>
  <div id="primary-slot">
{primary_card}
  </div>

{others_html}
</main>

<div class="wrap">
  <footer>
    <a href="{html.escape(REPO)}">Source and issue tracker</a>. Each build is cut from
    the latest commit and has not been through a test pass.
  </footer>
</div>

<script>
  // Put the visitor's platform in the main slot. The section holding the others
  // stays closed, so the page shows one download and offers the rest. Presentation
  // only: every download is already in the document, so if detection is unavailable
  // or simply wrong the page still works exactly as served.
  (function () {{
    var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "";
    ua = ua.toLowerCase();
    var os = ua.indexOf("win") >= 0 ? "windows"
           : ua.indexOf("mac") >= 0 || ua.indexOf("darwin") >= 0 ? "macos"
           : ua.indexOf("linux") >= 0 || ua.indexOf("x11") >= 0 ? "linux"
           : null;
    if (!os) return;

    var slot = document.getElementById("primary-slot");
    var others = document.getElementById("other-oss");
    var grid = others && others.querySelector(".other-grid");
    var wanted = document.getElementById("card-" + os);
    // Nothing to do when detection agrees with what was rendered first, or when this
    // platform has no card at all.
    if (!slot || !others || !grid || !wanted || wanted.parentNode === slot) return;

    var current = slot.querySelector(".card");
    if (current) grid.appendChild(current);
    slot.appendChild(wanted);
    // Deliberately NOT opened: the other platforms stay behind the disclosure.
  }})();
</script>
</body>
</html>
"""


def main() -> int:
    if len(sys.argv) < 4:
        print(__doc__, file=sys.stderr)
        return 2
    out, version, release_url = sys.argv[1], sys.argv[2], sys.argv[3]
    assets = [parse_asset(s) for s in sys.argv[4:]]
    # Runtime libraries are patch ingredients for the updater, never user downloads:
    # offering one would hand the user a bare .so/.dll.
    assets = [a for a in assets if not a["name"].endswith(("-runtime.so", "-runtime.dll"))]
    if not assets:
        sys.exit("::error::no downloadable assets given, so the page would ship empty")
    page = render(version, release_url.rstrip("/"), assets)
    if FORBIDDEN in page:
        sys.exit("::error::the generated page contains an em-dash, which reads as machine-written prose")
    with open(out, "w") as fh:
        fh.write(page)
    print(json.dumps({"wrote": out, "version": version, "assets": len(assets)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
