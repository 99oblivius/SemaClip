/**
 * A project's files must be found wherever the project lives, and deleted by the name they
 * actually carry.
 *
 * The trap this guards, in full:
 *   - Before this work the folder was `{cacheDir}/vods/{streamId}` and the artifact stem was
 *     the stream TITLE's slug: `{title-slug} - proxy.mp4`.
 *   - A project is now named `{streamer}-{game}-{date}` with the SAME name for the folder and
 *     its files. But an existing project keeps its `{id}` folder AND its title-slug files —
 *     `projectDir` is adopted as the id folder while the artifacts inside are title-named.
 *
 * So a delete that sweeps only the CURRENT stem (the folder's basename, a UUID) finds nothing
 * and reports `deleted: false` while 1.1GB sits on disk. That is the same defect class this
 * codebase has already been fixed for twice — hardcoded boilerplate names, then a title-only
 * slug — so it gets an explicit test.
 *
 * The filesystem is real: a temp directory, real files, the real use-case. A fake would only
 * prove the fake.
 */
import { assertEquals } from "@std/assert";
import { MediaActionsUseCase } from "@/application/use-cases/MediaActions.ts";
import type { Stream } from "shared/types";
import type { StreamRepository, StreamMetadataRepository, FileSystemPort } from "@/application/ports/outbound.ts";
import type { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";

/** The stream repository, holding one record. */
class OneStreamRepo implements StreamRepository {
  constructor(private stream: Stream) {}
  set(s: Stream) {
    this.stream = s;
  }
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

const metadata: StreamMetadataRepository = {
  get: () => Promise.resolve(null),
  set: () => Promise.resolve(),
  delete: () => Promise.resolve(),
  deleteAll: () => Promise.resolve(),
};

const fs: FileSystemPort = {
  exists: (p) => Deno.stat(p).then(() => true).catch(() => false),
  ensureDir: (p) => Deno.mkdir(p, { recursive: true }),
  remove: (p) => Deno.remove(p, { recursive: true }),
  joinPath: (...segs) => segs.filter((s) => s.length > 0).join("/").replace(/\/+/g, "/"),
  nativePath: (p) => p,
  listFiles: async (dir) => {
    const names: string[] = [];
    for await (const e of Deno.readDir(dir)) if (e.isFile) names.push(e.name);
    return names.sort();
  },
};

/** The orchestrator surface these paths use: state + a revision touch. */
function fakeOrchestrator(state: Partial<Awaited<ReturnType<DownloadOrchestrator["getState"]>>> = {}) {
  const full = {
    phase: "done" as const,
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
    getState: () => Promise.resolve(structuredClone(full)),
    setState: () => Promise.resolve(),
    touch: () => {},
    revision: () => 0,
    globalRev: 0,
    markRunLive: () => {},
  } as unknown as DownloadOrchestrator;
}

function legacyStream(overrides: Partial<Stream> = {}): Stream {
  return {
    id: "aaaa1111-2222-3333-4444-555566667777",
    vodPath: "",
    chatPath: null,
    sourceUrl: null,
    title: "Great Stream",
    streamer: "Pyromancer",
    game: "Chess",
    duration: null,
    createdAt: "2026-09-18T20:26:03.294Z",
    status: "pending",
    projectDir: null,
    ...overrides,
  };
}

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-delete-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

Deno.test("deleteVideo: a legacy project's TITLE-named file is deleted from its adopted {id} folder", async () => {
  await withTempDir(async (root) => {
    // The pre-0.5.0 layout: an `{id}` folder whose files carry the title's slug.
    const idDir = `${root}/aaaa1111-2222-3333-4444-555566667777`;
    await Deno.mkdir(idDir, { recursive: true });
    const videoFile = `${idDir}/great-stream - video.mp4`;
    const indexFile = `${idDir}/great-stream - video.fragments`;
    await Deno.writeTextFile(videoFile, "bytes");
    await Deno.writeTextFile(indexFile, "map");

    const repo = new OneStreamRepo(legacyStream({
      // The record still points at the media, which is what resolves the folder.
      vodPath: videoFile,
      projectDir: idDir, // adopted by the reconciler on first read
      includeProxy: false,
    } as Partial<Stream>));

    const actions = new MediaActionsUseCase(
      repo,
      metadata,
      fs,
      fakeOrchestrator({ hqPath: videoFile, hqMp4: videoFile }),
      root,
    );

    const result = await actions.deleteVideo("aaaa1111-2222-3333-4444-555566667777");
    assertEquals(result.deleted, true, "the video must be found by the name it actually has");
    assertEquals(await fs.exists(videoFile), false, "the video file is gone");
    assertEquals(await fs.exists(indexFile), false, "its index dies with it");
  });
});

Deno.test("deleteProxy: the same rule holds for the proxy", async () => {
  await withTempDir(async (root) => {
    const idDir = `${root}/aaaa1111-2222-3333-4444-555566667777`;
    await Deno.mkdir(idDir, { recursive: true });
    const proxyFile = `${idDir}/great-stream - proxy.mp4`;
    await Deno.writeTextFile(proxyFile, "bytes");

    const repo = new OneStreamRepo(legacyStream({
      vodPath: proxyFile,
      projectDir: idDir,
    } as Partial<Stream>));
    const actions = new MediaActionsUseCase(
      repo,
      metadata,
      fs,
      fakeOrchestrator({ proxyPath: proxyFile, proxyMp4: proxyFile }),
      root,
    );

    const result = await actions.deleteProxy("aaaa1111-2222-3333-4444-555566667777");
    assertEquals(result.deleted, true);
    assertEquals(await fs.exists(proxyFile), false);
  });
});

Deno.test("deleteChat: a title-named chat file is found too", async () => {
  await withTempDir(async (root) => {
    const idDir = `${root}/aaaa1111-2222-3333-4444-555566667777`;
    await Deno.mkdir(idDir, { recursive: true });
    const chatFile = `${idDir}/great-stream.chat.json`;
    await Deno.writeTextFile(chatFile, "[]");

    const repo = new OneStreamRepo(legacyStream({
      chatPath: chatFile,
      projectDir: idDir,
    } as Partial<Stream>));
    const actions = new MediaActionsUseCase(
      repo,
      metadata,
      fs,
      fakeOrchestrator({ chatPath: chatFile }),
      root,
    );

    const result = await actions.deleteChat("aaaa1111-2222-3333-4444-555566667777");
    assertEquals(result.deleted, true);
    assertEquals(await fs.exists(chatFile), false);
  });
});

Deno.test("purgeArtifacts: removes the project's OWN folder, not the old id folder", async () => {
  await withTempDir(async (root) => {
    const projectDir = `${root}/pyromancer-chess-2026-09-18-2226`;
    const oldIdDir = `${root}/aaaa1111-2222-3333-4444-555566667777`;
    await Deno.mkdir(projectDir, { recursive: true });
    await Deno.mkdir(oldIdDir, { recursive: true });
    await Deno.writeTextFile(`${projectDir}/pyromancer-chess-2026-09-18-2226 - video.mp4`, "x".repeat(64));
    await Deno.writeTextFile(`${oldIdDir}/unrelated.txt`, "keep");

    const repo = new OneStreamRepo(legacyStream({ projectDir }));
    const actions = new MediaActionsUseCase(repo, metadata, fs, fakeOrchestrator(), root);

    const purged = await actions.purgeArtifacts("aaaa1111-2222-3333-4444-555566667777");
    assertEquals(purged.bytes > 0, true, "the reported freed bytes come from the real files");
    assertEquals(await fs.exists(projectDir), false, "the project's own folder is gone");
    assertEquals(await fs.exists(oldIdDir), true, "nothing else is touched");
  });
});

Deno.test("artifactDir: a MISSING recorded folder does not fall through to a different one", async () => {
  await withTempDir(async (root) => {
    // The project says it lives on a drive that is not there. The delete must NOT silently
    // operate on the old id folder instead — that would delete files the user did not ask
    // about, and would report success for a project that is merely unmounted.
    const missing = `${root}/mounted-drive/pyromancer-chess-2026-09-18-2226`;
    const oldIdDir = `${root}/aaaa1111-2222-3333-4444-555566667777`;
    await Deno.mkdir(oldIdDir, { recursive: true });
    await Deno.writeTextFile(`${oldIdDir}/great-stream - video.mp4`, "keep me");

    const repo = new OneStreamRepo(legacyStream({ projectDir: missing }));
    const actions = new MediaActionsUseCase(repo, metadata, fs, fakeOrchestrator(), root);

    const result = await actions.deleteVideo("aaaa1111-2222-3333-4444-555566667777");
    assertEquals(result.deleted, false, "nothing to delete: the project is not reachable");
    assertEquals(
      await fs.exists(`${oldIdDir}/great-stream - video.mp4`),
      true,
      "an unreachable project's old folder must not be swept as a fallback",
    );
  });
});
