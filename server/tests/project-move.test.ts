/**
 * Repointing a project at a different folder.
 *
 * The property under test is narrow and load-bearing: a recorded path is rewritten ONLY when
 * the same FILENAME exists in the new folder. The filename is the artifact's identity
 * (`artifact-naming.ts`), so the same name in the new folder IS that artifact — and its
 * absence means the move is incomplete, which must not be papered over with a plausible path.
 *
 * The failure this prevents is the one this codebase keeps hitting: a path that LOOKS right
 * (pointing into the project's folder) while the file is not there, so playback, export and the
 * artifact rows all report something false and the user sees a broken project that claims to
 * be complete.
 */
import { assertEquals } from "@std/assert";
import { rePointPaths, basename } from "@/application/use-cases/project-location.ts";
import { SetProjectLocationUseCase } from "@/application/use-cases/SetProjectLocation.ts";
import type { Stream } from "shared/types";
import type { StreamRepository, FileSystemPort, EventBus } from "@/application/ports/outbound.ts";
import type { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";

const OLD = "/old/cache/vods/abc";
const NEW = "/new/drive/project";

Deno.test("rePointPaths: rewrites only the paths whose file is really in the new folder", async () => {
  const present = new Set([`${NEW}/great - proxy.mp4`, `${NEW}/great.chat.json`]);
  const result = await rePointPaths(
    {
      proxyPath: `${OLD}/great - proxy.mp4`,
      proxyMp4: `${OLD}/great - proxy.mp4`,
      hqPath: `${OLD}/great - video.mp4`, // NOT in the new folder
      hqMp4: `${OLD}/great - video.mp4`,
      chatPath: `${OLD}/great.chat.json`,
    },
    NEW,
    (p) => Promise.resolve(present.has(p)),
  );

  assertEquals(result.state.proxyPath, `${NEW}/great - proxy.mp4`);
  assertEquals(result.state.proxyMp4, `${NEW}/great - proxy.mp4`);
  assertEquals(result.state.chatPath, `${NEW}/great.chat.json`);
  // The video is left pointing at the OLD location, deliberately: the file is not there, and
  // claiming it moved would make Export render from a path that does not exist.
  assertEquals(result.state.hqPath, `${OLD}/great - video.mp4`);
  assertEquals(result.state.hqMp4, `${OLD}/great - video.mp4`);
  assertEquals(result.repointed.length, 3);
  assertEquals(result.kept.map(([k]) => k).sort(), ["hqMp4", "hqPath"]);
});

Deno.test("rePointPaths: an empty new folder repoints nothing and keeps every path", async () => {
  const result = await rePointPaths(
    { proxyPath: `${OLD}/a.mp4`, hqPath: `${OLD}/b.mp4` },
    NEW,
    () => Promise.resolve(false),
  );
  assertEquals(result.repointed.length, 0);
  assertEquals(result.state.proxyPath, `${OLD}/a.mp4`);
  assertEquals(result.state.hqPath, `${OLD}/b.mp4`);
});

Deno.test("rePointPaths: a path already in the new folder is untouched", async () => {
  const result = await rePointPaths(
    { proxyPath: `${NEW}/a.mp4` },
    NEW,
    () => Promise.resolve(true),
  );
  assertEquals(result.repointed.length, 0, "repointing to itself is not a change");
  assertEquals(result.state.proxyPath, `${NEW}/a.mp4`);
});

Deno.test("rePointPaths: null and undefined fields are ignored, not invented", async () => {
  // `exactOptionalPropertyTypes` is on in this project, so an explicitly-undefined field is
  // reached through the index signature rather than the declared keys — the rule still has to
  // tolerate it, because states written by earlier revisions can carry it.
  const sparse: Record<string, unknown> = { proxyPath: null, chatPath: `${OLD}/c.json` };
  sparse.hqPath = undefined;
  const result = await rePointPaths(
    sparse,
    NEW,
    () => Promise.resolve(true),
  );
  assertEquals(result.state.proxyPath, null);
  assertEquals(result.state.hqPath, undefined);
  assertEquals(result.state.chatPath, `${NEW}/c.json`);
});

Deno.test("basename: both separators, including a Windows path", () => {
  assertEquals(basename("/a/b/c.mp4"), "c.mp4");
  assertEquals(basename("C:\\Users\\x\\c.mp4"), "c.mp4");
  assertEquals(basename("/a/b/dir"), "dir");
});

// ── The use-case: refusals and what it writes ─────────────────────────────

class Repo implements StreamRepository {
  constructor(public stream: Stream) {}
  async save(_s: Stream): Promise<void> {}
  async findById(id: string): Promise<Stream | null> {
    return this.stream.id === id ? this.stream : null;
  }
  async list(): Promise<Stream[]> {
    return [this.stream];
  }
  async update(s: Stream): Promise<void> {
    this.stream = s;
  }
  async delete(_id: string): Promise<void> {}
}

function fakeFs(existing: Set<string>): FileSystemPort {
  return {
    exists: (p) => Promise.resolve(existing.has(p)),
    ensureDir: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    joinPath: (...s) => s.filter(Boolean).join("/").replace(/\/+/g, "/"),
    nativePath: (p) => p,
    listFiles: () => Promise.resolve([]),
  };
}

function orchestrator(state: Record<string, unknown>): DownloadOrchestrator {
  let current = {
    phase: "done",
    parts: [],
    overall: { percent: 1, etaSec: null },
    proxyFrontierSec: 0,
    videoFrontierSec: 0,
    proxyPath: null,
    hqPath: null,
    proxyMp4: null,
    hqMp4: null,
    chatPath: null,
    chatCount: 0,
    qualities: [],
    startedAt: null,
    includeProxy: false,
    ...state,
  };
  return {
    getState: () => Promise.resolve(structuredClone(current)),
    setState: (_id: string, s: never) => {
      current = s;
      return Promise.resolve();
    },
  } as unknown as DownloadOrchestrator;
}

const baseStream: Stream = {
  id: "s1",
  vodPath: `${OLD}/great - video.mp4`,
  chatPath: `${OLD}/great.chat.json`,
  sourceUrl: "https://twitch.tv/videos/1",
  title: "Great Stream",
  streamer: "Pyromancer",
  game: "Chess",
  duration: 3600,
  createdAt: "2026-09-18T20:26:03.294Z",
  status: "completed",
  projectDir: OLD,
};

Deno.test("setProjectLocation: refuses a folder that is not there, and writes nothing", async () => {
  const repo = new Repo({ ...baseStream });
  const useCase = new SetProjectLocationUseCase(repo, fakeFs(new Set()), orchestrator({}));
  let threw = "";
  try {
    await useCase.execute("s1", NEW);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertEquals(threw.includes("Folder not found"), true, threw);
  assertEquals(repo.stream.projectDir, OLD, "a refusal must not move the project");
});

Deno.test("setProjectLocation: refuses while a download is running", async () => {
  const repo = new Repo({ ...baseStream });
  const useCase = new SetProjectLocationUseCase(
    repo,
    fakeFs(new Set([NEW])),
    orchestrator({ phase: "running" }),
  );
  let threw = "";
  try {
    await useCase.execute("s1", NEW);
  } catch (err) {
    threw = err instanceof Error ? err.message : String(err);
  }
  assertEquals(threw.includes("running"), true, threw);
  assertEquals(repo.stream.projectDir, OLD);
});

Deno.test("setProjectLocation: refuses a relative path", async () => {
  const useCase = new SetProjectLocationUseCase(
    new Repo({ ...baseStream }),
    fakeFs(new Set([NEW])),
    orchestrator({}),
  );
  let threw = false;
  try {
    await useCase.execute("s1", "relative/folder");
  } catch {
    threw = true;
  }
  assertEquals(threw, true, "a relative path would resolve against the launch directory");
});

Deno.test("setProjectLocation: moves the record, repoints what exists, reports what is missing", async () => {
  const present = new Set([
    NEW,
    `${NEW}/great - video.mp4`,
    `${NEW}/great.chat.json`,
  ]);
  const repo = new Repo({ ...baseStream });
  const events: string[] = [];
  const bus = { publish: (t: string) => events.push(t), subscribe: () => () => {} } as unknown as EventBus;
  const useCase = new SetProjectLocationUseCase(
    repo,
    fakeFs(present),
    orchestrator({
      // The state records the proxy at OLD, which is NOT in the new folder.
      proxyPath: `${OLD}/great - proxy.mp4`,
      proxyMp4: `${OLD}/great - proxy.mp4`,
      hqPath: `${OLD}/great - video.mp4`,
      hqMp4: `${OLD}/great - video.mp4`,
      chatPath: `${OLD}/great.chat.json`,
    }),
    bus,
  );

  const result = await useCase.execute("s1", NEW);
  assertEquals(result.dir, NEW);
  assertEquals(repo.stream.projectDir, NEW, "the project now says where it lives");
  assertEquals(repo.stream.vodPath, `${NEW}/great - video.mp4`, "the render source follows the file");
  assertEquals(repo.stream.chatPath, `${NEW}/great.chat.json`);
  // FIVE, and the count is deliberate: three state fields hold paths into the new folder
  // (`hqPath`, `hqMp4`, `chatPath`) plus the record's own two (`vodPath`, `chatPath`).
  // `proxyPath`/`proxyMp4` stay put — their file is not in the new folder.
  assertEquals(result.repointed, 5, "three state fields + the record's two paths");
  assertEquals(result.missing.includes(`${OLD}/great - proxy.mp4`), true);
  // The proxy stayed put: its file is not in the new folder, so claiming it moved would make
  // the proxy row report a file that is not there.
  assertEquals(events.length, 1, "the change is announced so every surface re-reads");
});

Deno.test("setProjectLocation: a project with no record paths still records its location", async () => {
  const repo = new Repo({ ...baseStream, vodPath: "", chatPath: null });
  const useCase = new SetProjectLocationUseCase(
    repo,
    fakeFs(new Set([NEW])),
    orchestrator({}),
  );
  const result = await useCase.execute("s1", NEW);
  assertEquals(result.dir, NEW);
  assertEquals(repo.stream.projectDir, NEW);
  assertEquals(repo.stream.vodPath, "", "no video in the new folder means no invented vodPath");
});

// ── The gap the LIVE run exposed ──────────────────────────────────────────
//
// A project downloaded before the state recorded a video slot keeps its only
// reference in `stream.vodPath`. Repointing that path is not enough: the download
// view resolves presence from the STATE, so the project reported
// `video: false` with `renderPath: null` while a 336MB video sat in the folder.
//
// This test reproduces that project exactly: a state with no video slot, a folder
// holding `- video.mp4`, and no recorded state path pointing at it.
Deno.test("setProjectLocation: fills a state slot the state never recorded (the live failure)", async () => {
  const projectDir = "/moved/drive/examplestreamer-examplegame-2026-09-20-0634";
  const videoFile = `${projectDir}/will-lock-in-if-milk-is-involved-links - video.mp4`;
  const state = { phase: "idle", hqPath: null, hqMp4: null, proxyPath: null, proxyMp4: null, vodPath: null };

  const fs: FileSystemPort = {
    exists: (p) => Promise.resolve(p === projectDir || p === videoFile),
    ensureDir: () => Promise.resolve(),
    remove: () => Promise.resolve(),
    joinPath: (...s) => s.filter(Boolean).join("/").replace(/\/+/g, "/"),
    nativePath: (p) => p,
    // The folder holds the video and NOTHING else — no state path points at it.
    listFiles: () => Promise.resolve(["will-lock-in-if-milk-is-involved-links - video.mp4"]),
  };

  const written: Record<string, unknown>[] = [];
  const orch = {
    getState: () => Promise.resolve(structuredClone({ ...state, parts: [], overall: { percent: 0, etaSec: null } })),
    setState: (_id: string, s: Record<string, unknown>) => {
      written.push(structuredClone(s));
      return Promise.resolve();
    },
  } as unknown as DownloadOrchestrator;

  const repo = new Repo({
    ...baseStream,
    id: "examplestreamer",
    vodPath: "", // the record does not point at it either
    chatPath: null,
    projectDir: null,
  });
  const useCase = new SetProjectLocationUseCase(repo, fs, orch);
  await useCase.execute("examplestreamer", projectDir);

  assertEquals(written.length > 0, true, "the state must be written when a slot is filled");
  const after = written[written.length - 1]!;
  assertEquals(after.hqPath, videoFile, "the video slot is filled from the folder's real contents");
  assertEquals(after.hqMp4, videoFile, "the playable twin follows");
  assertEquals(after.phase, "done", "a complete artifact means the project is not idle");
});
