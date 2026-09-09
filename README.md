# SemaClip

> /ˈsɛməklɪp/ — Greek σῆμα (sign, signal) + clip. A clip found by reading the signals.

SemaClip is a local-first desktop application that finds clip-worthy moments in stream VODs and turns them into finished, exportable clips. Unlike tools that reduce the problem to "find the loudest second," SemaClip reads multiple signal classes — chat dynamics, audio energy, speech structure — and classifies moments by type (hype, humor, skill, awkward, emotional, tension), each with its own detector and clip boundaries.

## Status

**v2 architecture — pre-implementation.** The v1 codebase (Deno server + SvelteKit frontend) is a real, working skeleton being completed against the v2 architecture; the v1 ML engine was a mock and is being replaced. Current state and phase gates: [ROADMAP.md](ROADMAP.md). Functional design: [ARCHITECTURE.md](ARCHITECTURE.md). The superseded v1 design docs are archived under [docs/archive/v1/](docs/archive/v1/).

## Design principles

- **Honest UI** — nothing on screen is simulated; failures are loud, never silent green checkmarks.
- **Consumer-hardware floor** — ~16 GB RAM / ~6 GB VRAM, AMD or NVIDIA or CPU-only, Windows and Linux; performance scales up automatically via a hardware-tier model manifest.
- **Edit-first** — review, trim, compose, and export are the product; detection feeds it.
- **Local inference** — whisper.cpp + llama.cpp (GGUF, Vulkan/CPU); no cloud dependency.

## Stack

Deno Desktop (CEF shell, cross-compiled `.msi`/`.AppImage`, built-in auto-update) · TypeScript backend · Svelte 5 + SvelteKit + Tailwind v4 · FFmpeg · whisper.cpp · llama.cpp · node:sqlite + Drizzle.

## Layout

See ARCHITECTURE.md §3. `frontend/` (SvelteKit SPA), `server/` (Deno backend, hexagonal but slimmed), `detection/` (pure-TypeScript signal logic, fully unit-tested), `native/` (versioned external binaries, fetched by CI), `shared/` (single source of truth for wire types).

## License

MIT