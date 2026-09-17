#!/usr/bin/env python3
"""Generate the public landing page for a published SemaClip release.

WHY THIS IS A FILE AND NOT AN INLINE HEREDOC: a `run: |` block in a GitHub Actions
workflow carries its own indentation into the script, so an inline `python3 - <<'PY'`
body arrives indented — IndentationError, and a `PY` terminator no longer at column 0
so the heredoc never closes. Both failures are silent until the job runs.

WHY THE PAGE IS GENERATED PER RELEASE rather than being a static file with JavaScript
that finds the newest download: every SemaClip release is published as a PRERELEASE,
and GitHub's `/releases/latest` redirect resolves to the releases LIST, not to a tag.
So there is no tag-free download URL — something must know the version. Baking it in
at publish time means the page always names a real artifact, needs no API call, hits
no rate limit, and cannot show a stale or wrong version.

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
SUCCESS = "#22c55e"
WARNING = "#eab308"

OS_LABELS = {"linux": "Linux", "windows": "Windows", "macos": "macOS"}
OS_ORDER = ["windows", "linux", "macos"]

REPO = "https://github.com/99oblivius/SemaClip"


def parse_asset(spec: str) -> dict:
    parts = spec.split(":")
    if len(parts) != 4:
        sys.exit(f"::error::bad asset spec {spec!r}; expected name:os:arch:label")
    name, os_name, arch, label = parts
    if os_name not in OS_LABELS:
        sys.exit(f"::error::unknown os {os_name!r} in {spec!r}")
    return {"name": name, "os": os_name, "arch": arch, "label": label}


def hint_for(asset: dict) -> str:
    """One line telling the user what to do with the file they just downloaded."""
    if asset["os"] == "windows":
        if asset["name"].endswith(".msi"):
            return "Run the installer. Windows may warn about an unknown publisher — the build is signed by nobody yet."
        return "No install: unzip anywhere and run <code>SemaClip.exe</code>."
    if asset["os"] == "linux":
        if asset["name"].endswith(".AppImage"):
            return "No install: <code>chmod +x</code> the file, then run it. Needs <code>webkit2gtk</code>."
        return "Install with your package manager."
    return "Open the disk image and drag SemaClip to Applications."


def render(version: str, release_url: str, assets: list[dict]) -> str:
    by_os: dict[str, list[dict]] = {}
    for a in assets:
        by_os.setdefault(a["os"], []).append(a)

    cards = []
    for os_name in OS_ORDER:
        group = by_os.get(os_name)
        if not group:
            continue
        # Prefer an installer, then a single-file bundle; the runtime libraries are
        # NOT offered — they are patch ingredients for the updater, not downloads.
        group.sort(key=lambda a: (
            0 if a["name"].endswith((".msi", ".AppImage", ".dmg")) else
            1 if a["name"].endswith(".deb") else 2
        ))
        links = "\n".join(
            f'''          <a class="dl" href="{html.escape(release_url)}/{html.escape(a['name'])}"
             data-os="{a['os']}" data-arch="{a['arch']}">
            <span class="dl-label">{html.escape(a['label'])}</span>
            <span class="dl-meta">{html.escape(os_name)} · {html.escape(a['arch'])} · {html.escape(a['name'].rsplit(".", 1)[-1])}</span>
          </a>'''
            for a in group
        )
        hint = hint_for(group[0])
        cards.append(f'''      <section class="card" data-os-card="{os_name}">
        <h2>{html.escape(OS_LABELS[os_name])}</h2>
        <div class="links">
{links}
        </div>
        <p class="hint">{hint}</p>
      </section>''')

    return f"""<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>SemaClip — find the clips in a VOD</title>
<meta name="description" content="SemaClip is a local-first desktop app that finds the clip-worthy moments in a Twitch VOD. Everything runs on your machine.">
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
    --success: {SUCCESS};
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
  .wrap {{ max-width: 62rem; margin: 0 auto; padding: 0 1.5rem; }}

  header {{
    border-bottom: 1px solid var(--border); background: var(--surface);
    position: sticky; top: 0; z-index: 2;
  }}
  .bar {{ display: flex; align-items: center; gap: .75rem; height: 2.75rem; }}
  .wordmark {{ font-family: var(--display); font-weight: 700; letter-spacing: -.01em; }}
  .wordmark span {{ color: var(--accent); }}
  .chip {{
    font-family: var(--mono); font-size: .6875rem; color: var(--ash-dim);
    border: 1px solid var(--border); border-radius: .25rem; padding: .1rem .375rem;
  }}
  /* The pre-alpha notice, matching the app's own header: this is the honest state
     of the software and the page must not imply otherwise. */
  .prealpha {{
    margin-left: auto; font-family: var(--mono); font-size: .6875rem; font-weight: 700;
    color: var(--accent); border: 1px solid color-mix(in srgb, var(--accent) 60%, transparent);
    background: color-mix(in srgb, var(--accent) 10%, transparent);
    border-radius: .25rem; padding: .1rem .5rem;
  }}

  main.wrap {{ padding-top: 3.5rem; padding-bottom: 4rem; }}
  h1 {{ font-family: var(--display); font-size: clamp(2rem, 5vw, 3rem); line-height: 1.1; margin: 0 0 .75rem; }}
  .lede {{ font-size: 1.125rem; color: var(--ash); max-width: 40rem; margin: 0 0 2rem; }}
  .lede strong {{ color: var(--ink); font-weight: 600; }}

  .downloads {{ display: grid; gap: 1rem; align-items: start; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); }}
  .card {{ background: var(--surface); border: 1px solid var(--border); border-radius: .5rem; padding: 1.25rem; }}
  .card h2 {{ font-family: var(--display); font-size: .8125rem; text-transform: uppercase; letter-spacing: .08em; color: var(--ash); margin: 0 0 .875rem; }}
  .links {{ display: flex; flex-direction: column; gap: .5rem; }}
  .dl {{
    display: flex; flex-direction: column; text-decoration: none;
    border: 1px solid var(--border); background: var(--surface-2);
    border-radius: .375rem; padding: .625rem .75rem;
  }}
  .dl:hover {{ border-color: var(--accent); }}
  .dl-label {{ font-weight: 600; }}
  .dl-meta {{ font-family: var(--mono); font-size: .6875rem; color: var(--ash-dim); }}
  /* The detected platform is highlighted, but every option stays visible and
     clickable — detection is a convenience, never a gate. */
  .dl[data-detected="1"] {{ border-color: var(--accent); box-shadow: 0 0 0 1px color-mix(in srgb, var(--accent) 40%, transparent); }}
  .hint {{ font-size: .8125rem; color: var(--ash-dim); margin: .875rem 0 0; }}
  .hint code {{ font-family: var(--mono); color: var(--ash); }}

  .note {{
    margin-top: 2rem; border: 1px solid var(--border); border-radius: .5rem;
    padding: 1rem 1.125rem; background: var(--surface); font-size: .9375rem; color: var(--ash);
  }}
  .note b {{ color: var(--warning); }}
  footer.wrap {{ border-top: 1px solid var(--border); margin-top: 2.5rem; padding-top: 1.5rem; padding-bottom: 3rem; color: var(--ash-dim); font-size: .8125rem; }}
  footer a {{ color: var(--ash); }}
  .feat {{ display: grid; gap: 1.25rem; grid-template-columns: repeat(auto-fit, minmax(15rem, 1fr)); margin: 3rem 0 0; }}
  .feat div h3 {{ font-family: var(--display); font-size: .9375rem; margin: 0 0 .25rem; }}
  .feat div p {{ margin: 0; color: var(--ash); font-size: .9375rem; }}
</style>
</head>
<body>
<header>
  <div class="wrap bar">
    <span class="wordmark">Sema<span>Clip</span></span>
    <span class="chip">local</span>
    <span class="chip">nightly {html.escape(version)}</span>
    <span class="prealpha">pre-alpha — missing features, will break</span>
  </div>
</header>

<main class="wrap">
  <h1>Find the clips in a VOD.</h1>
  <p class="lede">
    SemaClip watches a Twitch VOD and marks the moments worth clipping — chat spikes,
    loud reactions, the parts everyone rewound. <strong>Everything runs on your
    machine:</strong> no account, no upload, no cloud. Download once and it works
    offline.
  </p>

  <div class="downloads">
{chr(10).join(cards)}
  </div>

  <div class="note">
    <b>This is pre-alpha.</b> Downloading, detection and review work today; the app is
    missing features and will break in places. It reports its own problems instead of
    hiding them — if something looks wrong, it probably is, and it should say so.
  </div>

  <div class="feat">
    <div>
      <h3>Local-first</h3>
      <p>Detection, transcription and export all run on your hardware. Your VODs never leave the machine.</p>
    </div>
    <div>
      <h3>Streams while it downloads</h3>
      <p>A scrubbable preview appears within seconds and grows as the file arrives, so you can start reviewing immediately.</p>
    </div>
    <div>
      <h3>Nothing to configure</h3>
      <p>Point it at a VOD or a folder and it works out the rest — resolution, proxy quality and CPU use have sensible defaults.</p>
    </div>
  </div>
</main>

<footer class="wrap">
  <a href="{html.escape(REPO)}">Source, issues and release notes</a> ·
  nightly builds are produced automatically from the latest commit and are not tested releases.
</footer>

<script>
  // Highlight the visitor's platform. This is a CONVENIENCE only: every download is
  // rendered above regardless, because detection is wrong often enough (a Linux user
  // on a phone, a Chromebook, a UA-locked browser) that hiding options would strand
  // people. If it cannot tell, it simply changes nothing.
  (function () {{
    var ua = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || "";
    ua = ua.toLowerCase();
    var os = ua.indexOf("win") >= 0 ? "windows"
           : ua.indexOf("mac") >= 0 || ua.indexOf("darwin") >= 0 ? "macos"
           : ua.indexOf("linux") >= 0 || ua.indexOf("x11") >= 0 ? "linux"
           : null;
    if (!os) return;
    var links = document.querySelectorAll('.dl[data-os="' + os + '"]');
    for (var i = 0; i < links.length; i++) links[i].setAttribute("data-detected", "1");
    var cards = document.querySelectorAll(".card[data-os-card]");
    for (var j = 0; j < cards.length; j++) {{
      cards[j].style.order = cards[j].getAttribute("data-os-card") === os ? "-1" : "0";
    }}
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
        sys.exit("::error::no downloadable assets given — the page would ship empty")
    page = render(version, release_url.rstrip("/"), assets)
    with open(out, "w") as fh:
        fh.write(page)
    print(json.dumps({"wrote": out, "version": version, "assets": len(assets)}))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
