# SemaClip

> /ˈsɛməklɪp/ — Greek σῆμα (sign, signal) + clip. A clip found by reading the signals.

SemaClip is a local-first desktop application that finds clip-worthy moments in stream VODs and turns them into finished, exportable clips. Unlike tools that reduce the problem to "find the loudest second," SemaClip reads multiple signal classes — chat dynamics, audio energy, speech structure — and classifies moments by type (hype, humor, skill, awkward, emotional, tension), each with its own detector and clip boundaries.

## Status

**Pre-alpha.** The app runs end to end — import a VOD, download it (chat + a scrub-able preview + full quality), review detected moments, edit captions, export — but features are missing and things break. The UI says so in its header bar. Current state and phase gates: [ROADMAP.md](ROADMAP.md). Functional design: [ARCHITECTURE.md](ARCHITECTURE.md). Release mechanics and CI: [docs/RELEASING.md](docs/RELEASING.md). Superseded v1 design docs are archived under [docs/archive/v1/](docs/archive/v1/).

Versioning is `v{yy}.{patch}` (e.g. `v26.196`), where patch counts commits since Jan 1 and is unbounded — there are exactly two parts, always. The two-digit year comes from Windows: an MSI ProductVersion packs as major(0-255).minor(0-255).build(0-65535), so a full CalVer year is unencodable. See [docs/RELEASING.md](docs/RELEASING.md).

## Getting started

Requires Deno 2.9+ and ffmpeg on PATH for development. ffmpeg is deliberately **not**
bundled: the app resolves it from PATH first, then from its own managed directory, and
offers a download only when neither has it.

```sh
./scripts/fetch-native.sh   # pinned whisper.cpp binaries + models
cd frontend && npm ci && npm run build
cd ../server && deno task start
```

Then open <http://localhost:5174>.

To build the desktop app for one platform (cross-compiles, so a Linux host can produce
the Windows artifacts):

```sh
cd server && deno task desktop
```

## Design principles

- **Honest UI** — nothing on screen is simulated; failures are loud, never silent green checkmarks.
- **Consumer-hardware floor** — ~16 GB RAM / ~6 GB VRAM, AMD or NVIDIA or CPU-only, Windows and Linux; performance scales up automatically via a hardware-tier model manifest.
- **Edit-first** — review, trim, compose, and export are the product; detection feeds it.
- **Local inference** — whisper.cpp + llama.cpp (GGUF, Vulkan/CPU); no cloud dependency.
- **Offline once downloaded** — the player reads local media only. It is never given the
  VOD URL; a range-served growing file is what makes review start before the download ends.

## Stack

TypeScript backend (Deno) · Svelte 5 + SvelteKit + Tailwind v4 · whisper.cpp for
transcription · `node:sqlite` for persistence · `deno desktop` for packaging, with
cross-compiled `.AppImage` and a self-updating portable `.zip` (no installer).

## Layout

See ARCHITECTURE.md §3. `frontend/` (SvelteKit SPA), `server/` (Deno backend, hexagonal but slimmed), `detection/` (pure-TypeScript signal logic, fully unit-tested), `native/` (versioned external binaries, fetched by CI), `shared/` (single source of truth for wire types).

## License

MIT
