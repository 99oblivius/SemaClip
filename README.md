# SemaClip

> **/ˈsɛməklɪp/** — from Greek *σῆμα* (sema: sign, signal, mark) + English *clip*. A clip found by reading the signals.

SemaClip is an intelligent, local-first engine for automatically detecting clip-worthy moments in stream VODs. Unlike existing tools that reduce the problem to "find the loudest second," SemaClip models the multidimensional nature of what makes a moment worth clipping — hype, humor, skill, awkwardness, emotion, and tension — each with its own detection logic, its own temporal structure, and its own relationship to signal strength.

**Status: Architecture phase. No code yet.**

## Philosophy

A human editor does not scan for the loudest moment and cut. They recognize *kinds* of moments, each with a different shape, and cut each kind differently. SemaClip models this directly through:

- **Multi-axis detection** — six independent moment types, each with its own detector
- **Adaptive temporal segmentation** — windows follow content structure, not fixed durations
- **Contextual scoring** — a top-2% humor moment outranks a top-20% hype moment
- **Online personalization** — learns your stream from implicit feedback, no manual labeling
- **Dynamic endpoints** — clips end when the emotional arc resolves, not at a fixed offset

## Architecture

See [ARCHITECTURE.md](ARCHITECTURE.md) for the complete v1 design document.

## License

MIT
