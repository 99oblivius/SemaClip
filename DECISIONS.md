# SemaClip — Decision Log

> Rationale for every v2 decision that diverges from v1 or was re-examined. Appends only; newest last within sections.

## 2026-09-09 — v2 architecture reset

- **Python engine deleted.** CUDA-only GPU story fails the AMD/6GB-VRAM requirement; PyInstaller binary (~200-400 MB) fails consumer distribution; the IPC layer was the weakest audited surface (unread stderr deadlock, broken cancel, protocol drift). Detection logic moves to pure TypeScript (`detection/`); heavy lifting to native runtimes (whisper.cpp, llama.cpp, onnxruntime) spawned as subprocesses. *(Audit: engine audit + §2 stack table.)*
- **Universal Stream Encoder cut** (v3+ research at best). It gated anomaly detection and embedding-Kalman, both speculative; building it requires a training corpus pipeline that is a project by itself. The three stages depending on it are cut with it.
- **Kalman persona replaced with rolling multi-timescale percentiles** (v1's own §7.5 design). Kalman adds state/tuning surface before there is anything proven to track. Revisit only if baseline drift demonstrably hurts precision.
- **Six axes staged, hype first.** A working honest single-axis pipeline beats six imaginary ones; all detectors share one interface so later axes are additive.
- **whisper.cpp/llama.cpp over PyTorch/faster-whisper.** GGUF + Vulkan runs identically on NVIDIA/AMD/CPU on both OSes; quantized models fit the 6 GB floor; single binary per runtime, no Python.
- **Chat sentiment via small ONNX classifier**, flagged as cuttable after calibration — the interface is the commitment, not the model.
- **Windows auto-update gap acknowledged**: Deno Desktop stages but cannot swap updates on Windows (loaded DLL, verified in official docs 2026-09). Mitigation: external updater exe performing swap + relaunch, same pattern as Squirrel. Native apply on Linux. Re-evaluate when Deno ships the Windows launcher swap.
- **Fonts bundled, Google Fonts CDN rejected** — offline-first desktop app.
- **Loopback bind + path allowlists** — v1 bound 0.0.0.0 with arbitrary local path acceptance (LAN file-read + subprocess trigger).
- **Hexagonal scaffolding slimmed, not abandoned**: real orchestration keeps use-cases; pass-through shims, unused ports, and the dead Clock/Persona wiring are deleted. routes.ts smuggled logic (ffmpeg waveform, chat cache) moves to services.
- **Docs discipline**: shared/types.ts is the single wire contract; STACK.md's §6/§7 fork (snake_case, `type:'job'`) is recognized as the cause of the v1 protocol drift and archived, not corrected — the actual built camelCase shapes are canonical.
- **Phases have exit gates** (ROADMAP.md) because v1's failure mode was polishing UI atop a mock engine for 4 days: honesty first, capability second, intelligence third.