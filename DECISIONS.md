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

### A hand-made clip records ABSENCE, and the schema had to be rebuilt to allow it

- Manual clip creation needed `clips.job_id`, `clips.axis` and `clips.score` to become NULLABLE.
  SQLite cannot drop `NOT NULL` with ALTER, so migration **0.6.0** rebuilds the table (and
  re-creates `idx_clips_stream` + `idx_clips_job`, which go with it). Safe because **no
  `FOREIGN KEY` is declared anywhere** in this schema, so `PRAGMA foreign_keys = ON` has nothing
  to break.
- **All three go nullable together, and no sentinel replaces them.** A clip with no job cannot keep
  a fabricated `jobId`, and a manual clip's `score` must not become `0` — zero is a plausible
  engine score, so it would present a deliberate edit as a badly-ranked detection. The panel renders
  an explicit **manual** label and a dash, never `0.00`.
- Consequence: manual clips are excluded from the axis-weight path (that feedback is keyed on
  `axis`, and feedback about nothing is worse than none), and they sort by position after the
  score-ranked candidates rather than being coerced into the ranking.
- The end of a hand-made clip is computed on the SERVER (`createManualClip`/`clipEndFrom`): the next
  clip's start after the playhead, else the VOD duration. One owner for the rule, so the browser
  cannot disagree with it — and the created clip is returned and **selected**, because creation is
  the one mutation whose result the user must immediately see.
- **Nullability is a runtime behaviour, not a type error.** Two consumers were silently wrong in ways
  `tsc` cannot see: the queue sort `b.score - a.score` yields `NaN` (which leaves elements in
  implementation-defined order), and the axis filter `activeAxes.has(c.axis)` is false for `null`,
  so turning on ANY axis filter made every hand-made clip *vanish*. Both rules are now covered by
  `frontend/tests/manual-clip-queue.test.mjs`, falsified by reverting each.
- Delete is the existing SOFT reject — no row is removed. It is also the only verb that now has
  derived media to clean up: a rejected clip's thumbnails are deleted with it.

### A thumbnail's cache name must carry the start, and must replace rather than accumulate

- Keyed by the clip id alone, trimming a clip keeps serving the frame from the OLD start for ever —
  and a query-string cache-buster cannot fix that, because the browser's copy is not what the server
  reads. So the cached file is named `{clipId}@{start}.jpg`.
- Keyed **only** by `(clip, start)` it leaks instead: `Timeline` PATCHes endpoints on every
  `pointermove` with no debounce, so a five-second drag would leave a file per pixel moved — none of
  which any surface can name again. So the new frame is written FIRST and the other names for that
  clip are removed after, with an mtime guard so a file still being written by a concurrent request
  is never a deletion candidate.
- Verified live: trim at t=15 leaves **exactly one** file named for 15; nine consecutive drag
  PATCHes still leave exactly one; four clips leave four files; reject deletes that clip's frames and
  leaves the other clips' frames untouched.

### The playable source is decided in ONE place, and a folder import is why

- `GET /api/video` owned the ordering (proxy mp4 twin → raw proxy → HQ mp4 twin → raw HQ, each
  stat-checked). The clip-thumbnail route needed the same file the player serves — a frame drawn
  from a source the user is not watching is worse than no frame — so the rule moved to
  `resolveMediaSource` in `application/view/download-view.ts` and both call it.
- **The second consumer made a second copy a real BUG rather than duplication.** A folder-imported
  project has media on disk and NO download artifacts at all, so a rule derived from download state
  alone reports "no media" for a file sitting right there. `streams.vodPath` is that project's only
  candidate, and it is also export's RENDER source, so it is in the ordering explicitly.
- Falsified by putting HQ before the proxy: the proxy-preference test fails. The ordering is not
  cosmetic — the proxy lands first and scrubs cheaply, which is why it is downloaded first.

### Cancel STOPS and delete SWEEPS — one verb each

Reported: cancelling a download "deletes the proxy and chat as well and does not actually stop
downloading — the backend still shows progress ... Even deleting the project doesn't stop the
downloading." Three defects, all structural, all confirmed by measurement.

- **Cancel was wired to the DELETE verb.** `DELETE /download` aborts, then SWEEPS the artifact
  directory and resets the state. So Cancel destroyed the partial download it was cancelling — the
  owner's "deletes the proxy and chat as well". Cancel now has its own route
  (`POST /streams/:id/download/cancel`) and stops the transfer while KEEPING every file; the
  DELETE remains the deliberate discard verb.
- **A cancelled run wrote its state back over the reset — the reason it "never stopped".** The
  delete reset the state at T; the aborted run was still unwinding and its own `finalize()` wrote
  the RUN's state at T+delta, resurrecting `phase`, the part counters and the paths just cleared.
  `markRunLive(id, false)` then drops the RAM copy, so the next read came off DISK and served the
  resurrected state. Measured by `tests/cancel-stops-run.test.ts` probe B: the run wrote `done`
  over the `idle`. Fixed with ONE choke point — `runAborted` guards `persist` (all 22 progress
  writes) and `finalize` — because an externally-aborted operation's own conclusions are
  meaningless, including its "failed" verdict, which would otherwise overwrite the canceller's
  intent with a word the user never chose.
- **Deleting a project did not stop its download.** `DELETE /streams/:id` removed the record and
  purged the directory while the run kept writing into it — and with the record gone, nothing in
  any UI could cancel it. The route now stops the download first.
- **The reason this survived: the whole-download path was untestable.** `run()` called
  `downloadFmp4` and `resolveQualities` DIRECTLY, bypassing the `net` seam that `startPiece` uses,
  so no test could drive a full run without reaching Twitch's usher. The seam now covers both — and
  turning it on immediately revealed that the seam's own type omitted `resumeSec`/`onFragment`,
  which every real caller passes.
- Verified live through HTTP: create a project with real media + chat → `POST /download/cancel` →
  **both files still present**, state `idle` and still `idle` across three re-reads → `DELETE`
  afterwards still sweeps everything. Falsified by removing the two abort guards, which reproduces
  the resurrection exactly.

### Versioning is `v{yy}.{patch}` — two parts, always

- The owner rejected a three-part version (`26.255.256`) as nonsensical. `yy` was originally a
  Windows-Installer bound, and **no `.msi` is built at all** (`build-desktop.ts`: "NO .msi IS BUILT
  (owner decision)"), so the overflow branch that produced a third part was dead code guarding a
  retired constraint. It is removed, and `patch` (commits since Jan 1) is unbounded.
- `.github/workflows/check.yml` now asserts the shape as a gate — inspecting **executable lines
  only**, because the first version of the gate matched the prose in its own explanatory comment and
  failed on a correct script.
- Proved on a throwaway 256-commit repository: the rewritten script yields `26.256`, the old one
  `26.255.256`, and a three-part version is refused with exit 1.

### A clip's name is `clips.title`, not `clips.axis`

- The owner asked for the "MANUAL" label to become an editable name. Writing that free text into
  `axis` is the obvious move and it is wrong: `axis` is an engine enum that `isAxis` validates,
  the axis filter queries and axis-weight feedback aggregates. A typed name there would fail
  validation on the next engine write, return a bogus category from a filtered query, teach the
  model a category the engine never emits, and erase the "manual clip = ABSENCE of axis" invariant
  the manual-clip design rests on. Migration `0.7.0` adds `clips.title` as an **ALTER** — unlike the
  `0.6.0` NOT NULL drop, nothing blocks it and no index is disturbed.
- `null` means unnamed and `""` is never stored: a blank name is refused by the use case and
  clearing is explicit (`title: null`), so an untouched field never becomes a failed edit.
- Display precedence is `title ?? axis ?? "manual"` — the user's name, then the engine's, then the
  KIND. The name field is never prefilled from the axis: an editable box holding an enum invites
  overwriting detection data with prose.
- The migration is numbered `0.7.0` and `0.6.0` keeps the nullable-columns rebuild. The live
  database had **already applied `0.6.0`** (the owner ran the browser build), so renumbering was
  the only safe choice — inserting `title` as a new second migration leaves an applied version
  number untouched, and no `0.8.0` gap is ever created.
- **A clip has exactly two timestamps, and nothing may derive a third from `peakTime`.** The peak is
  a recorded fact that goes stale when the clip is trimmed. This showed up TWICE: as an independent
  start line on the timeline (the peak tick sat where the clip was created while the boundaries
  moved) and again in selection, which seeked to the peak so opening a candidate landed mid-clip.
  The timeline's hit-test also keyed on the peak, making a clip hoverable only near a point that
  could be outside the clip entirely — it now tests the RANGE, which is what gets drawn.


## The export list and batch (26.255)

- **Clips are persistent INDEPENDENTLY of exporting.** The export list holds REFERENCES to clips,
  never copies: boundaries, name and axis live in `clips`, and a duplicate here would be a second
  owner of the same truth — the recurring bug class — drifting the moment either side is edited.
  `removed_at` is a soft flag rather than a row DELETE, so taking a clip off the list does not erase
  that it was once on it, and a re-add can keep its original position.
- **The batch is DURABLE, and that is a requirement rather than a preference.** A batch interrupted
  by a restart must resume instead of silently vanishing: the user asked for those files, and a
  half-finished batch reporting "done" is a lie about their deliverables. `export_jobs.clip_id` is
  the PRIMARY KEY, not a surrogate id — one clip has at most one pending export, because two rows
  would race for the same output filename. The schema makes that state unrepresentable rather than
  relying on the queue to avoid it.
- **Migration `0.8.0` adds both tables.** No `FOREIGN KEY` is declared, matching the rest of the
  schema (see the 0.6.0 note); adding one only here would make this table's delete semantics differ
  from every other. Each migration runs in its own transaction, so a failure rolls back its earlier
  statements and records nothing (measured by fault injection).
- **Cancel = stop the unfinished, delete the partial artifact, keep finished exports.** The artifact
  path is RECORDED per attempt (`artifact_path`) rather than re-derived at cancel time: deriving it
  would be a second implementation of the naming rule, and a cancel that deletes the wrong file is
  worse than one that leaves a fragment. **`artifact_path` carries the LIVE partial while a job runs
  and the DELIVERED file once it lands**, so `deleteArtifact` refuses `completed`/`failed` rows
  structurally — a cancel must never be able to delete a file the user was told was ready.
- **The running item's artifact was the one file cancel never cleaned.** Aborting makes the PUMP
  mark the running item `cancelled` while `cancelIncomplete` waits, and `dropIncomplete` removes only
  NON-terminal rows — so the item that certainly had a partial file was the one nobody swept. Both
  populations are now collected. Found live (a 1.7 MB partial survived `cancelled: 0`), then pinned
  by a unit test.
- **`resume()` pumps whenever ANY row is queued, not only when a stranded `running` row exists.** A
  process killed BETWEEN two items leaves rows `queued` and none `running`; gating the pump on
  `stranded` left a durable batch sitting there for ever — the exact failure durability is meant to
  prevent. Found by the unit test written for the queue.
- **Progress parsing is `-progress pipe:1`, not the human stats on stderr.** The adapter's header had
  claimed progress parsing for months while `run()` passed `-nostats` with `stdout: "null"` — a
  comment describing a feature that did not exist. Measured: ~2 samples/sec, monotonic, correct
  fraction, and an abort genuinely kills the encoder mid-encode.
- **A published topic that is absent from the WS handler's TOPICS list looks wired and is not.**
  `EXPORT_CHANGED_TOPIC` and `EXPORT_PROGRESS_TOPIC` were published from the routes and the queue
  while missing from that list, so progress would have reached no browser at all.
- **A mutation that changes the database must PUBLISH.** Sending a clip to export is a real write
  (`POST /api/export/list`) followed by navigation on success — it was previously two lines of
  `window.location.href`, which made the Review page's Export button indistinguishable from doing
  nothing. `export_list` and `export_queue` are separate event variants because they have different
  consequences: a batch transition also invalidates the clip rows (an export writes `exported` /
  `export_path` onto its clip), while adding or removing a reference touches only the list.

## The encoder settings are per codec, and the mapping is a measured BAND (26.255)

Owner: "quality options often correlate with time to encode and in some codecs above a certain
quality value it becomes effectively lossless. Intelligently research each codec's range of utility
for the profile tier defaults." Quality and bitrate are both part of the encoder options and both are
manually editable per codec; the tier defaults are measured, not chosen.

- **A constant quality OFFSET between two encoders is not a mapping.** The first attempt mapped AV1 by
  `+16`, derived by matching `av1_nvenc` against **libx264's** crf 23. That is a cross-codec
  comparison: it says those two points agree, not how the rest of the scales relate. Measured within
  each codec's own scale, x264's band (crf 18–30, 12 wide) maps onto `h264_nvenc` cq 26–38 (also 12
  wide, slope 1.0) — which is why a constant `+8` happened to work for H.264 — while SVT-AV1's band
  (crf 28–45, 17 wide) maps onto `av1_nvenc` cq 32–41 (**9 wide, slope 0.53**). A constant cannot
  serve both; `HW_QUALITY_BANDS` stores the measured endpoints and the mapping interpolates between
  them. The failing case is visible in one number: the old code turned the SVT-AV1 default (crf 35)
  into `-cq 51`, the least useful cq `av1_nvenc` accepts, for a request at its own recommended quality.
- **The test asserts band ENDPOINTS and MONOTONICITY, not a midpoint.** A single mid-band assertion
  passes for a wrong slope; asserting both ends plus "a worse software quality never asks for a better
  hardware quality" fails it. This is the check the original offset would not have survived.
- **`speed` is measured and nullable.** Quality and encode time rise together, so the tradeoff is
  recorded as data: h264 5.2x realtime at 1080p60, h265 2.2x, **vp9 0.8x** (slower than playback),
  svt-av1 2.0x, nvenc 6.2x. H.265 and VP9 hardware speeds are `null` because no such encoder exists
  on the reference host — nothing was timed, so nothing is claimed, and the UI omits the estimate
  rather than quoting a number nobody took.
- **Each band's `best` edge comes from marginal utility, not from a vendor recommendation.** VMAF
  gained per 1000kbps: h264 5.70 stepping 30→26, but **0.35** stepping 18→16. Past that point the
  codec is effectively lossless and more quality buys only bytes and time. This is what "above a
  certain quality value it becomes effectively lossless" means as a number.
- **A hardware encoder that silently falls back is worse than one that fails.** `av1_nvenc` was absent
  from `HW_UPLOAD_FOR`, so the lookup fell through to bare `hwupload` ("A hardware device reference is
  required to upload frames to") and the export fell back to the CPU while returning a valid file and
  reporting success. Measured: `hwupload` fails for BOTH nvenc encoders, `hwupload_cuda` works for
  both. The GPU probe was also codec-blind — it answered `h264_nvenc` to a question about AV1, which
  the hardware check then correctly refused, producing the same silent fallback. Both are fixed and
  the live check now asserts the backend that RAN (`av1_nvenc`), not merely that a file appeared.
- **The automatic bitrate ceiling is gone, not retuned.** It was codec-blind (6000 kbps at 1080p for
  H.264/H.265/VP9/AV1 alike) and existed to compensate for the quality-scale bug. At a matched quality
  nvenc is at parity (1.03x), so capping by default would cap a file that is not oversized. The
  ceiling is now opt-in, per codec, with a measured starting point.
- **Encoder choice is per codec and reflects measurement**: H.264 on the CPU (parity at matched
  quality, universally decodable), AV1 on the GPU (smaller at comparable quality, ~3x the software
  encoder's speed). The owner's read — H.264 popular on CPU, AV1 sensibly hardware — is what the
  measurements support, and the user can override either default.
- **The encoder picker lists what the MACHINE offers, per codec, verified by encoding — the OBS
  model.** `probeGpuEncoder` and `listEncodersFor` are deliberately two routines: the first answers
  "which should we default to?" and stops at the first working family; the second answers "what can we
  offer?" and tries every family. Using the first for the picker is what made the page claim "no
  hardware encoder on this machine" for every codec whose hardware was not nvenc, when this host has
  two H.264 encoders, two H.265 encoders and one AV1 encoder. Families are filtered to the useful
  vendors (NVENC, VAAPI/AMD, QSV/Intel, AMF/Windows, and the software entries); a family that is
  platform-gated (AMF) is not offered off its platform.
- **A NAMED encoder outranks the profile's default, and that precedence is explicit code.** The name
  and the `encoder: auto|software|hardware` field are two channels onto one decision, and the field was
  overruling the name: a profile naming `h264_nvenc` with `encoder: "auto"` — which is exactly what
  picking from the list produces — ran libx264. Precedence is now named > probed hardware > named
  software > per-codec default, unit-tested, and cannot return null.
- **A measured speed is keyed by ENCODER, never by backend or codec.** `h264_nvenc` (RTX 4090) and
  `h264_vaapi` (AMD iGPU) are different silicon, so reporting one's measurement under the other's name
  is a borrowed number that reads as measured. Absent means unmeasured, and the UI shows nothing.
- **VAAPI rate control is CQP, and pairing `-rc_mode VBR` with `-qp` is refused by ffmpeg** (exit 234,
  "Could not open encoder before EOF", nothing written). That shipped, so every VAAPI export failed and
  the silent CPU fallback absorbed it — the caller saw a valid file and a success throughout. The
  lesson generalises: **assert the backend that RAN, because a silent fallback hides encoder-config
  bugs completely.** Verified after the fix: a named `h264_vaapi` export reports `backend:
  "h264_vaapi"` with no fallback in the log, alongside `h264_nvenc` and `cpu` for a named libx264.

## Preset origin is DATA, and the drizzle `.get()` trap it exposed

- **Deletability is a COLUMN on the row, not a hardcoded id list in the UI.** The frontend held
  `DEFAULT_PRESET_IDS = new Set(['preset-tiktok-916', ...])`, which is the wrong owner for a property
  of a row: the set has to be edited in step with `DEFAULT_PRESETS`, and the server — which owns the
  data and can be called by anything — would delete a seeded preset while the UI still assumed it
  could not. `export_presets.origin` ('seeded' | 'user') gives ONE owner, and the DELETE route refuses
  a seeded preset BY NAME (409 with the reason) instead of trusting a client not to ask.
- **`origin` is NOT written into `config_json`, and is omitted from the update set on conflict.** Two
  owners of one fact drift, and re-saving over a seeded preset must not promote it into a deletable
  one — the origin is a property of the existing ROW, so the repo's `onConflictDoUpdate` deliberately
  leaves the column alone. A test asserts both halves.
- **Drizzle `.get()` returns COLUMNS AS ARRAYS here, so it is unusable.** `createDb` runs drizzle over
  a remote callback; selecting `{ origin }` returned `{ origin: ["user"] }` for a user preset and `{}`
  for no match. Both failure modes are silent and both were live in the first version of `originOf`:
  a user preset compared as unequal to `"user"` and reported as `seeded`, and a missing row never
  tripped `if (!row)`, making the route's 404 branch dead code — an unknown preset answered 409
  "ships with the app". Fixed by reading with `.all()` and type-checking `rows[0].origin`; every
  pre-existing repository already did this, which is why nothing had hit it before.
- **The 0.9.0 migration backfills every existing preset as `seeded`, and that is the CORRECT value,
  not a convenient one.** User presets did not exist before this version, so any preset already in
  someone's database was one the app shipped. It also fails safe: a wrongly-seeded preset is merely
  undeletable, while a wrongly-user one is deletable when it should not be. Verified on the live DB
  (3 presets backfilled, none lost) and pinned by a test that builds the schema at the PREVIOUS
  version, migrates, and asserts the backfill; falsified by removing the `DEFAULT` (the migration
  still applies, and the test fails with the right message).

## Presets are normalised on READ, because the stored shape is not the only shape

`export_presets.config_json` holds the profile, and TWO shapes exist in real databases: the legacy FLAT
subset (`format`/`aspectRatio`/`cropPosition`/`captions`/`nameTemplate`) and the full nested profile.
`list()` spread the blob verbatim, so a legacy row reached the client with NO `profile` field and every
`preset.profile.x` read threw. A thrown `$derived` does not render an error — it aborts the render — so
the export page sat on "Loading presets…" for ever while the HTTP request returned 200. The query had
succeeded and the DATA was the problem, which is why no unit test caught it: the suite asserted the
shape the CODE produced, not the shape the DATA had.

Fixed by normalising on read (`normaliseProfile` already understands the legacy `format`), NOT by
migrating the blobs. Reasons: it is idempotent by construction, it degrades an unreadable field instead
of failing, and it therefore also repairs hand-edited rows — a JSON-rewriting migration would need the
same tolerance to be safe and would still leave an unparseable row broken. Pin it with a test whose
fixtures are the ACTUAL blobs from a live database.

## Setters and radios are different kinds of control, and Revert needs the distinction

A quality TIER is a one-shot SETTER: pressing it writes a quality AND a bitrate, then the buttons all
read unselected, because the user took an ACTION rather than selecting a mode. A tier staying lit was
the category error — the same as a Save button staying pressed — so `selectedTier` was removed entirely,
along with any derivation of a tier from a quality number. FORMAT, aspect ratio, encoder and the caption
controls are RADIOS: their current value is the state, so reverting writes the preset's value back.

`applyPreset` and `revertToPreset` are now ONE operation (`writeValues(valuesFromPreset(p))`), differing
only in whether the preset is adopted as active. Two separate implementations were why Revert missed
controls: every new control had to be added twice and only one site got updated.

## A format change OVERRIDES the bitrate; it does not overwrite the user's choice

Switching to a different codec makes the source's own bitrate unusable (a transcode has no original rate
to fall back to), so the control moves to a forced one. That is a TEMPORARY override: what the user had
is remembered and restored when they return to the source's format, so a round-trip leaves them where
they started rather than silently converting "use the source's rate" into a pinned number they never
chose.

## `{platform}` was a fabricated token, and the fix had to be a data migration

`{platform}` resolved to the FIRST WORD OF THE PRESET NAME (falling back to the literal `"export"`), and
the seeded templates baked in a literal `-tiktok` / `-shorts`. There is no platform concept in the app:
the token described a display name, changed when a preset was renamed, and wrote invented text into a
filename. Removed, along with the literal. Because the text lived in every existing database's rows,
removing it from `DEFAULT_PRESETS` alone would have fixed only fresh installs — migration 0.10.0 strips
it from a SEEDED preset whose template is EXACTLY the shipped literal, so a user's own text in any
preset, seeded or not, is untouched. Both guards are individually falsified.

## Crop position was removed as a concept, not just as a control

Removing only the UI would have left a profile field no user could ever set — dead config that still
round-trips through save/load and still needs testing. Every existing preset was already `center`, so
removing the type, the domain maths, the seeded values and the control changes no behaviour; the vertical
crop is computed centred. A vertical crop of a 16:9 source has no better answer than the middle, and
offering three positions invited cutting off heads or feet while looking for framing that had already
been chosen.

## The unreleased 0.6.0-0.10.0 range was FLATTENED into one migration

Five version numbers (0.6.0 through 0.10.0) accumulated while the code was never published. The highest
schema any SHIPPED release created is **0.5.0** (`v26.252` / `v26.253` — the tags are the publication
boundary, not the branch: `refs/heads/main` on origin matched local HEAD the whole time), so those five
numbers described the author's working history rather than any state a user can be in. They are now ONE
migration, 0.6.0.

Why this is not cosmetic:

- **0.6.0 is a REBUILD (`DROP TABLE` + rename + recreate).** It is the one kind of migration that can
  lose rows, and chaining four more migrations onto it multiplied the number of ways that single step
  could go wrong. One unreleased step is one migration.
- Five numbers for one step is noise in a list whose entire job is to describe the path from a user's
  database to the current schema.
- The consolidation had to happen NOW. Once a build containing 0.6.0-0.10.0 is pushed, a released state
  exists at each of those versions and merging them becomes unsafe (it would either skip or replay DDL a
  user already has). It is only flattenable while none of them has ever been published.

**The statements were kept in their ORIGINAL ORDER and unedited.** Nothing was "simplified" while
merging: the rebuilt `clips` table still gets 0.7.0's `title` column from a later statement rather than
by editing the rebuild, because editing that DDL would be a NEW migration wearing an old version number
— a change no existing reader has ever validated. The end state is identical by construction, and the
tests assert the same outcomes (0.5.0 → latest with real rows, the rebuild preserving every row, the
template strip, the origin backfill) that they asserted before.

**One consequence worth stating:** the `origin = 'seeded'` condition on the template UPDATE became
INERT. It was correct when that statement was its own migration, where only pre-existing rows had been
backfilled. Merged into 0.6.0, the origin backfill earlier in the SAME migration sets every row to
`seeded` and no `user` row can exist yet, so the condition could never exclude anything. It was removed
rather than left in place reading as protection while preventing nothing. The guards that DO protect a
user's text are the id match and the exact-template match, and each now has its own test with its own
database — they cannot share a fixture, because `id` is the primary key and "shipped template" vs
"template the user edited" are two states of the SAME id. An earlier test put the edited row under a
different id, so the id guard excluded it and the template guard was never exercised: it passed while
proving nothing about the guard it named. Falsifying that guard is what exposed it.

**`schema_versions` rows for 0.7.0-0.10.0 may still exist** on a database that ran a pre-consolidation
build (the developer's own does). They are harmless: the runner reads the table into a SET and compares
it against the `migrations` array, so an unknown recorded version is simply never matched and nothing
re-runs — verified by opening a database recorded through 0.10.0 against the consolidated set, which
applies zero migrations and returns a usable handle.


## A gesture is ONE history entry, and it is owned by the window (26.258)

The owner reported that "moving the play head should not create a history event every frame". The
playhead never did: `pushEdit` has exactly two call sites and neither is a seek. The per-frame history
was ENDPOINT dragging — `adjustEndpoints` pushed an undo entry AND issued a PUT on every mousemove, so
a single drag wrote ~60 entries and reversing one gesture took 60 presses of Ctrl+Z. The report named
one mechanism and the fault lived in the other; the count of call sites is what settles it.

**The rule:** HISTORY IS COMMITTED BY THE GESTURE, NOT BY THE FRAME. Live frames update the query cache
only, and one `onCommitEndpoints` fires on release. Two consequences fall out of that:

- **The pre-drag range must be captured at PRESS.** By release the live frames have overwritten the
  current range, so nothing downstream can reconstruct where the drag started. The component pins the
  anchor clip and the range in `mousedown` and passes them back on release; the undo entry is built
  from those.
- **A drag is owned by the WINDOW, not the element.** Listening on the timeline alone meant leaving the
  element ended the gesture (and `mouseleave` cancelled it), so a drag past the edge died. Window
  listeners are armed in an `$effect` gated on a gesture being active, so the page pays nothing at rest.
  Exactly ONE handler may act per frame: with both the element and the window handling motion, every
  frame fired twice — two seeks, two endpoint updates.

## The timeline's view window has one owner (26.258)

Middle-drag pans, left-drag moves the playhead, right-click does nothing. The pan drives the same
`viewStart`/`viewEnd` the zoom control already owns, rather than introducing a pan offset of its own.
A second owner of "what time sits at x=0" is how a timeline comes to disagree with itself about where a
clip is — the same class of fault as two owners of a project's file paths. The pan delta is applied
against the offset captured at press, never accumulated per event, so a long drag cannot drift away
from the pointer.

## The manual clip cap is a CEILING, never a source of video (26.258)

`clipEndFrom` takes the MINIMUM over candidate ends — the 60s cap, the next clip's start when it is at
least the 0.5s floor away, and the end of the video — rather than an if/else chain. The chain let a
neighbour's start beat the cap, or vice versa, depending on the ORDER OF THE BRANCHES; a minimum cannot
have an order-dependent bug.

Two boundaries the first implementation got wrong, both caught by writing the tests:

- **The cap must not be used when the video is nearly over.** With 0.2s of stream left, `min(cap, …)`
  returned `start + 60` — a clip running 59.8s past the end of the video. The cap is a ceiling on what
  may be created, not a supply of footage that exists. Under the floor, the fallback length is used.
- **An unknown duration is not a short video.** With `duration: null` there is no video end to honour,
  so the cap is the only bound and the clip gets the full 60s. The pre-cap rule returned the 30s
  fallback here, which handed back a shorter clip than the cap allows for no reason.

An explicit `endTime` is clamped to the same ceiling inside `CreateClipUseCase`: the cap describes what
a manual clip MAY BE, so a client cannot talk the server into an hours-long clip by sending an end.

**Known gap, deliberately not closed here:** `createClip` validates no bounds at all, and the manual
path does not pass through `UpdateClipUseCase` (where the 0.5s floor lives), so nothing re-checks the
floor downstream. The last branch can return an end barely past `startTime` when an existing clip
starts within 0.5s of the playhead. Closing it means giving `createClip` a validator, which is a wider
change than this fix.

## A batch's filename is a TEMPLATE, and export-all means the OUTSTANDING work (26.258)

Two faults behind the owner's report, and neither was the sorting they suspected — the export page has
no sorting at all, only a partition for entries whose clip is gone; row order is the server's stored
`position`.

**One filename for the whole batch.** `enqueueAll` stores a single `filename` and hands it to every
item, and `ExportClipUseCase` treats an incoming `filename` as a TEMPLATE (that is what the field means
on the single-clip route) and renders it. The export page sent the SELECTED clip's already-rendered
name, which has no tokens left, so it rendered verbatim for every clip in the run — one clip's name
stamped across the batch, with the `-2`/`-3` collision suffix the only thing telling the files apart.
A batch must send `filename: null` and let `profile.nameTemplate` render per clip, because a per-clip
name is the one thing a single string cannot be.

**Export-all re-sent finished work.** The implicit selection was `liveIds()` — every listed clip,
marked or not — and the route clears the mark of everything it ACCEPTS. So pressing export all both
re-encoded files that already existed and destroyed the record that they do. The rule is that
export-all means the work still OUTSTANDING; the mark, not the path, decides (`exported` with a nulled
path still records that an export was made). The ids are passed EXPLICITLY, because passing none makes
`enqueueAll` re-read the list and put the filtered clips straight back. An EXPLICIT `clipIds` list
stays unfiltered: there the user named the clips, and filtering them would silently ignore a direct
instruction. The skip count is reported rather than swallowed, so a user who pressed export-all on a
partly-exported list is told why some rows did not run.

The rule lives in `selectImplicitBatch` — pure, in `ClipUseCases.ts`, so it is testable without a
server, with its own test file covering the all-exported and dangling-reference cases.

## 2026-09-23 — A release asset is fetched by RELEASE ID, never by pattern

- **`releases/tags/<tag>.assets[]` is EMPTY for these releases while the assets exist.** Measured with
  a bare `curl` (not `gh`, so it is the API's response): the embedded array returned 10 entries for
  v26.256 and **0** for v26.257 and v26.258, while `/releases/<id>/assets` returned 8 for each and
  `releases/download/<tag>/<name>` served every file with a 200. Two consecutive releases, so it is
  systematic rather than a one-off.
- **`gh release download --pattern` and `gh release view --json assets` both read that embedded array.**
  That is why the patch job died at `Download both runtime dylibs` with `no assets to download` on
  every release from v26.257 on, taking the manifest republish and all of `verify` with it.
- **The louder failure was the milder one.** The step BEFORE it scanned for the previous release with
  the same call, so it was silently walking past the real previous release: for v26.258 it chose
  v26.256 as the diff base, skipping v26.257. A wrong diff base produces a patch that reproduces
  nothing — a silent wrong answer is worse than a skipped check, and only measuring both endpoints
  showed it.
- **`scripts/ci/releases.py` resolves every asset through `/releases/<id>/assets`.** One helper, called
  by both steps, with a self-test the job runs before it needs it. The name selector is EXPLICIT
  (`+name` / `+suffix`) because inferring the mode from the string mis-classified
  `-linux-x64-runtime.so` as an exact filename and failed the fetch for a release whose dylib was
  present.
- **No fallback.** The pattern-based path is REMOVED from both steps rather than kept beside the new
  one (owner directive). A retained fallback would quietly restore the wrong diff base the moment the
  new path had trouble, which is the failure being fixed.
- **A fetch is sized before it is used.** The step asserts a byte floor on both dylibs, so a truncated
  or empty download fails at the fetch instead of producing a patch that reproduces nothing.
- **The `verify` job had the SAME defect, and only running it would have revealed it.** All three of
  its reads (the artifact download and both dylib fetches in the patch-reproducibility loop) used
  `gh release download --pattern`, i.e. the empty embedded array. It was invisible because `verify` was
  SKIPPED for three consecutive releases — `patch` failed first, and the job's guard accepts
  `skipped`/`cancelled` but not `failure`. A fix to `patch` alone would therefore have converted a
  red `patch` job into a red `verify` job. Fixing a defect found the identical defect one job
  downstream: when a job has been silently skipped, its inputs are UNEXERCISED, not working.
- **`--pattern` was worse than the helper for a second reason.** It cannot require a match, so a
  selector that stopped matching would leave the file absent and be reported by the following check as
  the PUBLISH having lost an asset — the wrong diagnosis. The helper fails on an unmatched selector
  (`fetch-many` requires every one to resolve), so "we asked for the wrong thing" cannot be mistaken
  for "the release is missing it".
- **Nothing in the app reads `manifest.patches`** (only the runtime's `Deno.autoUpdate` consumes it),
  so the missed patch hops never stranded a user — the cost was bandwidth, not an update path. That is
  why the defect was invisible to users and visible only in CI.

## 2026-09-23 — The help overlay is generated from the handler, not maintained by hand

- **A hand-audited list drifted in BOTH directions, and every row of that drift was a lie to the
  user.** `A` (accept) was documented and handled nowhere; `Q` was documented as a working filter
  with no `q` branch and a state (`unreviewedOnly`) that was never assigned; `Enter (on marker)`
  described a keystroke for what is a mouse click; `[`/`]` and `N` were real and missing. The fix is
  not a better hand-audit — it is `frontend/tests/keybind-help-parity.test.mjs`, which reads the keys
  out of `handleKey`'s own `case` labels and the rows out of the overlay's own literal and fails when
  either side has something the other lacks.
- **Aliases and named keys are asserted, never assumed.** One `case` label can accept two forms of the
  same key (`case ',': case '<'`), so aliases are declared and each is checked to resolve to a
  documented canonical key; arrow keys are matched against their named cases. A silent exemption is
  exactly how `Q` stayed wrong.
- **Removing a dead key means removing what it drove.** `Q`'s target state was unreachable, so the
  state, its filter and its stale comment went with the key. A dead branch left behind reads as a
  feature nobody finished.
- **Snoozed clips SORT to the end; nothing hides them.** S (`snoozeClip`) stays honest because the
  ordering makes it visible. The documented behaviour now matches that rather than promising a filter
  that does not exist.

## 2026-09-23 — One export button, and what "Play from start" actually did

- **Two controls with the same verb on one screen is a defect, not redundancy-for-convenience.** The
  preview panel's header `Export` and its Actions column's `Export clip` were both wired to the same
  `onExport`. The header copy survives (the panel's actions live there); the Actions column is deleted
  and Endpoints takes the width, which is the same change.
- **`Play from start` undersold itself, and that is recorded rather than silently dropped.** It seeked
  to the clip's start, PLAYED, auto-paused at the clip's END, then advanced to the NEXT clip
  (`onClipEnd` -> `nextClip`). No other control chains that — Space plays from wherever the playhead
  is and does not stop at the boundary — so it is a real capability change, reproducible in one
  keystroke (J/K to select, then Space) and restorable in the header without the duplicate Export.
- **The dead chain went with it.** `playClip` on the page, `VideoPlayer.playClip`, `autoAdvanceClip`
  and the `onClipEnd` prop were all reachable only from that button, so all four were removed; a dead
  mechanism left in place implies a feature that no longer has a trigger.
- **An early edit removed BOTH export controls.** The test written for this item caught it before it
  left the tree — and the first version of that test counted LABELS, which passed while a button still
  said "Export" but had been rewired to `onDiscard`. The assertion now counts controls wired to
  `onExport`, and both falsifications go red.

## 2026-09-23 — "Export this clip" rides the queue, and the UI is not a document

- **The single-clip export was SILENT because the route is synchronous.** `POST /api/clips/:id/export`
  runs the entire encode before it answers, so there is no progress to report and the button looks
  inert for the length of an encode. The queue already reports progress, ETA and cancel, and a batch
  of one is still a batch: the button enqueues with an explicit `clipIds` (so it is a deliberate
  re-send that bypasses the already-exported rule) and no `filename` (a rendered name has no tokens
  left, so the server would stamp it verbatim on every item).
- **The timeline is not focusable, because it takes no keyboard input.** `tabindex={0}` made it a tab
  stop whose focus ring outlived the interaction. Its gestures are all mouse events — there is no
  keydown handler in the component — so the `slider` role promised keys that do not exist. Both are
  gone; `role="application"` and the `aria-label` stay, because removing focusability must not remove
  the accessible name. The endpoint handles lost the same tabindex: they are drag targets.
- **Selection is OFF by default and opted into where copying is the point.** A desktop tool is not a
  document. The global `user-select: none` carries explicit opt-ins for form fields and
  `contenteditable` (typing needs selection), `pre`/`code`, error text (users copy it into a report)
  and chat messages. Chat's scroll container had a blanket `select-none` that would have cancelled the
  per-message opt-in, so it was removed — the exception belongs on the text, not on its container.
- **Both clip boundaries are drawn at one width.** The end was 3px against the start's 2px, and the
  asymmetry read as a different KIND of mark. Which handle is which is answered by position and the
  hit-test, not by thickness.
