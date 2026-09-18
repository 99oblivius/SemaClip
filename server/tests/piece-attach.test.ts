/**
 * A manual piece download must ATTACH the artifact to the stream record.
 *
 * Reported: "Deleting chat correctly makes the chat panel empty, but downloading it
 * doesn't populate it again like it should." Deleting chat clears `stream.chatPath` (it
 * has to — the record must stop claiming a file that is gone), and every reader of the
 * chat panel resolves THAT field (`loadChat(stream.chatPath)` on both chat routes). The
 * re-download wrote the file, recorded it in the download state, and updated the settings
 * row from the state's presence — but never pointed the record back at it, so the panel
 * stayed empty while the UI insisted the chat was there.
 *
 * The cause is a divergence, not a missing feature: the PIPELINE always fired
 * `onPartDone` (which attaches each artifact as its part completes) and the piece path
 * never did. Same for a manual VIDEO piece — Export renders from `stream.vodPath`, so a
 * re-downloaded video was equally invisible to it.
 *
 * ── WHY THESE TESTS SUBSTITUTE THE NETWORK, NOT THE RUNNERS ───────────────────────
 * The `onPartDone` calls live INSIDE `runChatPiece`/`runVideoPiece`. Two earlier versions
 * of this file stubbed those runners (and then `startPiece`'s dispatch) and each time the
 * suite PASSED WITH THE FIX REVERTED, because the stub stood where the missing call was.
 * Only the two functions that talk to Twitch are replaced now, so the real runner bodies
 * execute and the assertion is about a line that actually ships. Verified by excising the
 * two `onPartDone` calls and watching these tests fail.
 */
import { assert, assertEquals } from "@std/assert";
import { DownloadOrchestrator } from "@/adapters/outbound/vod/download-orchestrator.ts";

/**
 * A piece body that WROTE ITS FILE.
 *
 * The artifacts must exist on disk, because the orchestrator reconciles every state read
 * against the filesystem — a path with no file is dropped, by design. A fake that only
 * reports progress would have its hqPath reconciled away, and the proxy test below would
 * then fail for a reason that has nothing to do with the rule it checks.
 */
async function writeArtifact(path: string): Promise<void> {
  await Deno.mkdir(path.replace(/\/[^/]+$/, ""), { recursive: true });
  await Deno.writeTextFile(path, "fake media");
}

/** A temp dir per test, removed afterwards. */
async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "semaclip-attach-" });
  try {
    await fn(dir);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

type Stream = {
  id: string;
  title: string;
  streamer: string;
  chatPath: string | null;
  vodPath: string;
};

/** A stream repo that records every update, so the attach is observable. */
function fakeStreams(initial: Stream) {
  let current = { ...initial };
  const updates: Partial<Stream>[] = [];
  return {
    repo: {
      findById: () => Promise.resolve({ ...current }),
      update: (s: Stream) => {
        updates.push({ ...s });
        current = { ...s };
        return Promise.resolve(s);
      },
    },
    current: () => current,
    updates: () => updates,
  };
}

const IDLE_STATE = {
  phase: "idle",
  parts: [],
  overall: { percent: 0, etaSec: null },
  proxyFrontierSec: 0,
  proxyPath: null,
  hqPath: null,
  proxyMp4: null,
  hqMp4: null,
  chatPath: null,
  chatCount: 0,
  qualities: [],
  startedAt: null,
  includeProxy: false,
};

function harness(initial: Stream) {
  const streams = fakeStreams(initial);
  // A real key/value store: the piece runner persists its state and the NEXT piece reads
  // it back. A harness that discarded writes would let the proxy test pass for the wrong
  // reason — the second piece would start from an empty state and demote the video that
  // the first piece had legitimately recorded.
  const store = new Map<string, string>();
  const orch = new DownloadOrchestrator(
    {
      get: (_id: string, key: string) => Promise.resolve(store.get(key) ?? null),
      set: (_id: string, key: string, value: string) => {
        store.set(key, value);
        return Promise.resolve();
      },
    } as never,
    { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" } as never,
    streams.repo as never,
  );
  return { orch, streams };
}

Deno.test("a finished CHAT piece points the stream record at the new file", async () => {
  await withTempDir(async (dir) => {
    const h = harness({
      id: "s1",
      title: "My Stream",
      streamer: "someone",
      chatPath: null, // deleted earlier: the reported starting point
      vodPath: "",
    });
    // The chat fetch is the only thing faked. The runner that calls onPartDone is real.
    h.orch.net.chat = async (_vodId, destPath) => {
      await writeArtifact(destPath);
      return 7;
    };

    await h.orch.startPiece({
      streamId: "s1",
      destDir: dir,
      kind: "chat",
      vodId: "123",
      slug: "my-stream",
    });

    assertEquals(
      h.streams.current().chatPath,
      `${dir}/my-stream.chat.json`,
      "the record must name the re-downloaded chat, or every chat route answers 404 and " +
        "the panel stays empty exactly as reported",
    );
    assert(
      h.streams.updates().length > 0,
      "the attach must write through the repository, not just mutate a local object",
    );
  });
});

Deno.test("a finished VIDEO piece points `vodPath` at the new file", async () => {
  await withTempDir(async (dir) => {
    const h = harness({
      id: "s2",
      title: "My Stream",
      streamer: "someone",
      chatPath: null,
      vodPath: "",
    });
    h.orch.net.fmp4 = async (_url, destPath, o) => {
      await writeArtifact(destPath);
      o.onProgress({ downloadedSec: 12, totalSec: 120, bytes: 1024, percent: 0.1 });
      return { fragments: [] };
    };

    await h.orch.startPiece({
      streamId: "s2",
      destDir: dir,
      kind: "hq",
      vodId: "123",
      slug: "my-stream",
      quality: { name: "720p", height: 720, width: 1280, fps: 60, playlistUrl: "https://x", bandwidth: 1 } as never,
    });

    assertEquals(
      h.streams.current().vodPath,
      `${dir}/my-stream - video.mp4`,
      "Export renders from the record's path; a re-download that skips the record leaves " +
        "the project unexportable",
    );
  });
});

Deno.test("a PROXY piece does not demote a video the record already has", async () => {
  await withTempDir(async (dir) => {
    const h = harness({
      id: "s3",
      title: "My Stream",
      streamer: "someone",
      chatPath: null,
      vodPath: "",
    });
    h.orch.net.fmp4 = async (_url, destPath, o) => {
      await writeArtifact(destPath);
      o.onProgress({ downloadedSec: 5, totalSec: 100, bytes: 512, percent: 0.05 });
      return { fragments: [] };
    };
    const quality = (name: string, height: number) =>
      ({ name, height, width: 1280, fps: 60, playlistUrl: "https://x", bandwidth: 1 }) as never;

    // HQ first, so the record holds a video; then the proxy must leave it alone.
    await h.orch.startPiece({
      streamId: "s3",
      destDir: dir,
      kind: "hq",
      vodId: "123",
      slug: "my-stream",
      quality: quality("720p", 720),
    });
    const afterHq = h.streams.current().vodPath;
    assertEquals(afterHq, `${dir}/my-stream - video.mp4`, "the HQ pass establishes the video");

    await h.orch.startPiece({
      streamId: "s3",
      destDir: dir,
      kind: "proxy",
      vodId: "123",
      slug: "my-stream",
      quality: quality("540p", 540),
    });

    assertEquals(
      h.streams.current().vodPath,
      afterHq,
      "a proxy arriving after the video must not demote the recorded render source",
    );
    assert(
      await Deno.stat(`${dir}/my-stream - proxy.mp4`).then(() => true).catch(() => false),
      "the proxy file itself must still land, or this test would pass by downloading nothing",
    );
  });
});

Deno.test("a piece still completes with no stream repo to attach to", async () => {
  await withTempDir(async (dir) => {
    const store = new Map<string, string>();
    const orch = new DownloadOrchestrator(
      {
        get: (_id: string, key: string) => Promise.resolve(store.get(key) ?? null),
        set: (_id: string, key: string, v: string) => {
          store.set(key, v);
          return Promise.resolve();
        },
      } as never,
      { ffmpeg: "/usr/bin/ffmpeg", ffprobe: "/usr/bin/ffprobe" } as never,
    );
    let fetched = false;
    orch.net.chat = async (_vodId, destPath) => {
      await writeArtifact(destPath);
      fetched = true;
      return 1;
    };
    await orch.startPiece({ streamId: "s9", destDir: dir, kind: "chat", vodId: "1", slug: "s" });
    assert(fetched, "the piece must still download when there is no record to attach to");
  });
});
