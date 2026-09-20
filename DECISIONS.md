# SemaClip — Decision Log

> Rationale for every v2 decision that diverges from v1 or was re-examined. Appends only; newest last within sections.

## 2026-09-09 — v2 architecture reset

- **Python engine demoted to a fallback stub.** CUDA-only GPU story fails the AMD/6GB-VRAM requirement; PyInstaller binary (~200-400 MB) fails consumer distribution; the IPC layer was the weakest audited surface (unread stderr deadlock, broken cancel, protocol drift). Detection logic moved to pure TypeScript (`detection/`) and runs **in-process** — there is no engine subprocess and no IPC transport. `engine/semaclip/engine.py` survives only as a mock-clip stub, selected when a build has no bundled whisper tree. *(Audit: engine audit + §2 stack table.)*
- **Universal Stream Encoder cut** (v3+ research at best). It gated anomaly detection and embedding-Kalman, both speculative; building it requires a training corpus pipeline that is a project by itself. The three stages depending on it are cut with it.
- **Kalman persona replaced with rolling multi-timescale percentiles** (v1's own §7.5 design). Kalman adds state/tuning surface before there is anything proven to track. Revisit only if baseline drift demonstrably hurts precision.
- **Six axes staged, hype first.** A working honest single-axis pipeline beats six imaginary ones; all detectors share one interface so later axes are additive.
- **whisper.cpp/llama.cpp over PyTorch/faster-whisper.** GGUF + Vulkan runs identically on NVIDIA/AMD/CPU on both OSes; quantized models fit the 6 GB floor; single binary per runtime, no Python.
- **Chat sentiment via small ONNX classifier**, flagged as cuttable after calibration — the interface is the commitment, not the model.
- **Windows auto-update gap acknowledged**: Deno Desktop stages but cannot swap updates on Windows (loaded DLL, verified in official docs 2026-09). Mitigation: external updater exe performing swap + relaunch, same pattern as Squirrel. Native apply on Linux. Re-evaluate when Deno ships the Windows launcher swap.
- **Fonts bundled, Google Fonts CDN rejected** — offline-first desktop app.
- **Loopback bind + path allowlists** — v1 bound 0.0.0.0 with arbitrary local path acceptance (LAN file-read + subprocess trigger).
- **Hexagonal scaffolding slimmed, not abandoned**: real orchestration keeps use-cases; pass-through shims, unused ports, and the dead Clock/Persona wiring are deleted. Partly outstanding: the waveform route still lives in `routes.ts` rather than a service, alongside the chat cache.
- **Docs discipline**: shared/types.ts is the single wire contract; STACK.md's §6/§7 fork (snake_case, `type:'job'`) is recognized as the cause of the v1 protocol drift and archived, not corrected — the actual built camelCase shapes are canonical.
- **Phases have exit gates** (ROADMAP.md) because v1's failure mode was polishing UI atop a mock engine for 4 days: honesty first, capability second, intelligence third.
## 2026-09-18 — Artifact identity is the filename; `includeProxy` is plan-only

- **A file's role comes from its NAME, not from the download mode.** `includeProxy` describes what an import DOWNLOADS; it must not decide what a file on disk IS. Deriving identity from it (plus "which part is running") produced three live bugs: a completed proxy reported as the video at the proxy's size, a proxy that could never read as on-disk unless the mode was set, and `deleteProxy` forgetting a 1.1 GB video that was still on disk. `findArtifact`/`pathFillsRole` resolve role from name; a state slot resolves to a role by the path recorded in it. `includeProxy` is consulted for identity only in the one window where nothing is on disk yet, because then the run's own plan is the only evidence that exists.
- **No migration for existing projects.** Legacy states recorded a single-file download's path in the proxy slot. Because readers resolve a slot by the path inside it and identify the artifact by that file's name, those projects keep working as written. Chosen over a one-shot DB migration (which would have to be right about every old shape) and over a manual "resync with folder" action (which asks the user to repair what the app can infer).
- **`stream.vodPath` is the render source, with one meaning.** It is the main video and never the proxy: a proxy there made deleting the video look like a no-op and would have made Export render the 540p preview. Both writers of it (the pipeline's `attachPart` and the manual-piece `attachPartToStream`) recorded the proxy whenever it finished first; both now record only the video. `deleteVideo` re-derives it from disk via the shared scan rather than falling back to `state.proxyMp4`.
- **The proxy has no stream-record field.** The download state owns it and the view reads it from there. A field with no writer cannot go stale.
- **One reconcile implementation, and the live path calls it.** `reconcile-stream.ts` held a pure, well-tested `reconcileStreamRecord` while `StreamQueries` carried a drifted inline copy that production actually ran — so the passing tests covered the version nobody used. The live path now delegates to the pure rule, with its async `exists` pre-resolved.
- **A single-file download records itself in the `hq` slot it writes** (`- video.mp4` at the chosen video quality), with its own `videoFrontierSec`. Recording it as `proxy` was what forced every reader to infer the artifact from the mode.
- **A foreign file the user drops in is still adoptable as the video.** Excluding the app's own artifacts by role suffix must not make a user's replacement invisible; only the video role has a foreign fallback, since only the app produces proxies and chat.
- **The `.fragments` index is deleted when a download completes**, and re-written on re-download; a failed or cancelled download keeps it for resume. It now also dies on a manual piece's completion path, which never reached `finalize`.

## 2026-09-18 — The Windows frame is removed by the app, and window state is measured

- **`frameless` is a request the runtime does not honour on the adopted window, so the app removes the frame itself.** The option is creation-only, and the window this app can adopt was created by the runtime before JS ran, so it is silently dropped there (denoland/deno#35969, #35635, both open). Creating a second window to get a frameless one would leave the original on screen, which is the blank-window defect the single-construction rule exists to prevent. `win-frame.ts` clears `WS_CAPTION|WS_THICKFRAME|WS_SYSMENU|WS_MINIMIZEBOX|WS_MAXIMIZEBOX` via user32 and tells the OS the frame changed (measured: 0x14CF0000 → 0x14000000). It is gated on Windows and degrades with a named reason where no window exists, so a dev run is unaffected.
- **Window state is MEASURED, never inferred from the option passed.** `chromeState()` reported `frameless` from the option, so it claimed a frameless window while the real one carried the full native frame — the UI then drew no chrome over a decorated window and the log confirmed the wrong side. The frame state is now tri-state (`null` when unmeasurable), because only Windows can answer it from JS and a claim is worse than an admission.
- **The minimum size is enforced on resize, not requested.** The runtime exposes no min-size option, so the floor is applied by correcting an undersized resize. The default size (1260x890) IS passed at adoption, because size does apply there — measured: the window was 800x600, the runtime's own default.
- **The chrome bar is the app's own, and only when the app owns it.** Minimize/maximize/close are drawn as a right-aligned cluster in Windows order, gated on `canMinimize`/`canMaximize` derived from the measured frame. A decorated window keeps the OS buttons and the bar adds none, so one window never shows two sets. The actions go through user32 because the window class exposes neither.
- **A growing media extent is read from the file, not from the downloader.** `*FrontierSec` counts chunks written to ffmpeg's stdin and does not match what was muxed; ffprobe on the growing fragmented MP4 does, and is what "where the mux reaches" means.

- **Updates are checked once, at app open, and never elsewhere** (owner policy, 2026-09-19). No
  `interval` is passed to `Deno.autoUpdate`, so there is exactly one check ~1s after boot
  ("A single check runs ~1s after the call; pass `interval` to keep polling" — the runtime's own type
  declaration). The Settings → Updates section was REMOVED; the version now sits in the header where
  the "local" badge was, because the badge said nothing actionable and the version is what is needed
  when reporting a problem. Pinned by a test that fails if an interval is reintroduced.
- **The `/api/video` range path streams the window; it does not buffer it.** Measured against a real
  1.32GB VOD: buffering the whole requested range delayed the first byte by 1806ms and held the entire
  range in memory; streaming it reached the first byte in 3ms. This was the owner-reported "preview
  takes many seconds, worse at larger resolutions" — a browser's opening request and each seek is
  typically `bytes=0-`, so the cost scaled with file size. Six ranges, including both chunk boundaries
  and EOF, were verified byte-exact after the change.
- **The `.AppImage` cannot self-update, and our code cannot fix it.** The runtime resolves the dylib
  with `dladdr` (the loaded `.so`'s own path) and stages updates as `<dylib>.update` beside it, which
  inside an AppImage is the read-only squashfs mount — `EROFS` (os error 30), measured on a real
  read-only mount, and documented by Deno: auto-update "does not work for read-only or system-owned
  installs — an AppImage mounted read-only". There is no env var or relocation hook. Windows is
  unaffected. The `.AppImage` is a fresh-download artifact until upstream ships a relocatable dylib.

## 2026-09-20 — Four owner-requested changes: queue, order, project paths, VOD directory

### Full VOD downloads run one at a time, in the order added

- **A FIFO for full VOD downloads only** (import and resume). Manual per-artifact downloads stay
  immediate — they are small, deliberate, usually a repair, and the owner asked for exactly that
  split. The motivation is in the owner's own data: two VODs imported five seconds apart both ended
  with an empty `vod_path`, because two transfers were splitting the link until neither finished.
- **`queued` is its own phase, and it is ACTIVE.** A queued project must appear as pending work
  (`needsAttention` → a Library container) or the import looks like it failed. It is not
  `starting`: a queue can hold several projects for minutes and `starting` would be a bar that never
  moves.
- **The queue's snapshot is the ONE owner of "waiting"**, composed into the phase by the downloads
  route. A first attempt also wrote a queued marker into the download state, which read back as
  `phase: idle, active: false` — because a queued stream is deliberately not a live run, so
  `getState()` serves the persisted state. The container then never rendered and the queue position
  was invisible. Two mechanisms for one fact, in the place it does the least good; the second was
  deleted.
- **A queue entry that is dropped must be dropped everywhere**: cancel de-queues (a queued download
  that starts itself a moment after Cancel is the opposite of what the button says), and a project
  delete/purge drops it too.
- The queue asserts its own invariant in a test as a **live concurrency counter**, not as an
  ordering: `maxConcurrent === 1`. A run that throws (even synchronously) or is aborted releases the
  queue in a `finally`, because a queue that stops after one failure strands every later download.

### Recent lists newest first

- `SqliteStreamRepository.list` orders `desc(created_at)` in both branches. The heading said
  "Recent" and the order said oldest-first. `/api/downloads` iterates the same list, so the progress
  area follows it — inherited, not coincidental. Tested against a real in-memory database, and
  falsified: reverting to `asc` fails two of its three assertions.

### A project's folder is RECORDED, and named after the stream

- **`streams.project_dir` (migration 0.5.0)**, `{vodRoot}/{streamer}-{game}-{YYYY-MM-DD-HHmm}`,
  local time from the VOD's own creation date, each part sanitised and capped at 60, a part that
  sanitises to nothing omitted rather than left as an empty segment, `-2`/`-3` on collision. Artifact
  files inside take the FOLDER name as their stem, so folder and files agree.
- **No SQL backfill.** A migration cannot stat a filesystem, and the value is unknowable for a folder
  the user may have moved or unmounted; guessing would record a wrong path. `NULL` therefore means
  "not recorded", never "missing", and `StreamReconciler` resolves and persists it on first read —
  the same read-heals mechanism already used for `vod_path`/`chat_path`. Migration proven against a
  copy of the owner's real database: 0.4.0 → 0.5.0, both rows preserved.
- **Reachability is three-valued, and that is the whole trick.** `false` = a recorded folder is
  absent; `true` = present; `null` = no folder recorded, which may simply be an EMPTY project and must
  never be flagged. The owner's data contains both empty projects, so a rule that treats "no files" as
  unreachable would stripe two perfectly healthy projects. Measured per read in `/api/downloads`, which
  is why a drive that comes back clears it with no restart.
- **`createdAt` stays the PROJECT's creation time, not the VOD's.** Making it the VOD date would have
  silently redefined the "Recent" sort. The VOD date lives in the folder name, where it reads usefully.

### Change Location writes BOTH owners, or the project looks broken

- The download VIEW resolves presence from the download STATE's slots, while export and the record use
  `stream.vodPath`. Repointing only the record left a real 336MB video reporting `video: false` with
  `renderPath: null` — measured live. A relocation therefore fills an EMPTY state slot from the
  folder's listing via `findArtifact` (role from the FILENAME — identification, not a guess), sets the
  part `done` with its real byte size, and hydrates `idle`/`failed` → `done`. Verified after the fix:
  `video: true`, `renderPath` set, `phase: done`.
- **A missing folder is a refusal, not a mkdir.** "Change location" means "the files are here";
  creating the directory would report success while pointing the project at nothing. A running
  download refuses too (409) — it is writing into the old folder at that moment.
- **The artifact stem is the folder name for projects whose folder this scheme named**, and the
  title-slug is kept as a candidate for deletion sweeps: an existing project keeps its `{id}` folder
  and its title-named files, so a sweep using only the folder basename would find nothing and report
  `deleted: false` while gigabytes sat on disk.

### The OS folder chooser

- **The runtime has no dialog API** (`op_desktop_*` is alert/confirm/prompt/clipboard/notifications),
  so the chooser is per-platform: `zenity` (then `yad`) on Linux, which IS the desktop's GTK
  FileChooser — on this host zenity routes through `xdg-desktop-portal-gtk`, so the portal's own
  chooser appears; and the modern `IFileOpenDialog` + `FOS_PICKFOLDERS` behind a small STA helper on
  Windows, emitted by the app from a template (`folder-picker-windows.ts`) and written out per-user
  like the updater sidecar.
- **Cancelling is a real answer**, distinct from failure, and must not fall through to the next
  mechanism — opening a second dialog after someone declined one is worse than doing nothing.
- **The emitted helper is checked as TEXT by a unit test** (`tests/folder-picker-helper.test.ts`),
  because nothing else in this repo's gates compiles it and two defects reached the VM first: `''` in
  the C# body is two empty CHARACTER literals (`Add-Type`: "Empty character literal"), and an em-dash
  in the template shipped a non-ASCII byte that PowerShell 5.1 mis-parses. Both are now impossible to
  reintroduce silently. Verified on the VM with the adapter's exact argument list, which returned the
  expected path and opened at `-InitialDir`.

### Paths a user types are resolved, not stored verbatim

- `exportDir` had defaulted to the literal string `~/Videos/SemaClip` and nothing expanded the tilde,
  so the "directory" was a relative path named `~` under whatever CWD the app was launched from.
  `resolveUserPath` expands `~`, refuses relative paths (they resolve against the launch directory, so
  the same project lands in different places on two launches), unifies separators and drops the
  trailing one. A refused value throws before anything is written, so a setting can never be persisted
  in a state the app cannot honour.
- **The VOD directory defaults to the app's cache** (`{cacheDir}/vods`, injected at container
  construction) with an empty stored value, so an untouched install writes nothing and keeps resolving
  the old location. Changing it never moves an existing project: each records its own path.

### Resolving a path on save required the form to ADOPT the response

- Follow-on defect from the decision above, reported by the owner: changing the VOD directory and
  pressing Save "doesn't make it accept the save even though it did save." The write was fine. The
  page held the value the user TYPED (`~/VODs`) and compared it against the value the server STORES
  (`/home/livia/VODs`), so the two spellings of one value never compared equal and the form was dirty
  for ever: Save stayed armed, the "✓ Saved" mark never appeared, and the unsaved-changes footer
  never went away. It also made the saved confirmation unreachable by construction, since that mark
  was gated on `!dirty`.
- **Refetching is not enough, and that is the whole trap.** A refetch writes the resolved value into
  the QUERY CACHE while the form keeps the text the user typed — the two still disagree. The fix has
  to feed the mutation's RESPONSE back into the form (`adoptForm(saved)`), because the response is the
  one value guaranteed to be in the spelling the dirty rule compares against. The client cannot
  reproduce resolution itself: `~` expansion needs the home directory, which is the server's to know.
- The dirty rule moved to `frontend/src/lib/components/settings-form.ts` as a pure module
  (`formFromSettings`/`formToSettings`/`isDirty`) rather than an inline comparison in the page — an
  inline one cannot be tested, which is how a whole class of this went unnoticed. One builder means
  the initial load, the adopt-on-save and the revert cannot normalize a field differently from the
  rule that judges it.
- The unsaved footer gained **Revert**: discard every edit back to the SERVER's last value (read from
  the query cache, never a local snapshot — the server resolves and may refuse, so a local snapshot
  can describe a state the server never held). It also takes back a previewed interface scale, which
  lives in a store the layout reads on every route and would otherwise outlive the form.
- Verified through the real page in headless Chromium by asserting control STATE: type `~/VODs-test`
  → Save arms → save → Save DISARMS, the field shows the resolved path, the footer goes, the mark
  appears; then edit → Revert restores the saved value and writes nothing. Falsified by commenting
  out the single `adoptForm(saved)` statement, which reproduces the owner's exact symptom.

