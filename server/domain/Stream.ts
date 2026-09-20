import type { Stream, StreamStatus } from "shared/types";
import { generateUuid } from "@/infrastructure/uuid.ts";

export interface NewStreamInput {
  vodPath: string;
  chatPath?: string | null | undefined;
  sourceUrl?: string | null | undefined;
  title?: string | undefined;
  streamer?: string | undefined;
  game?: string | null | undefined;
  duration?: number | undefined;
  /** The project's folder, when the caller already decided where the media goes. */
  projectDir?: string | null | undefined;
}

export function createStream(input: NewStreamInput): Stream {
  return {
    id: generateUuid(),
    vodPath: input.vodPath,
    chatPath: input.chatPath ?? null,
    sourceUrl: input.sourceUrl ?? null,
    title: input.title ?? null,
    streamer: input.streamer ?? null,
    game: input.game ?? null,
    duration: input.duration ?? null,
    // WHEN THE PROJECT WAS CREATED, deliberately not the VOD's own date: the Library's
    // "Recent" list sorts on this field, so it means "most recently added project". The
    // VOD's broadcast date lives in the folder name instead (`vodFolderName`), which is
    // where it reads usefully anyway. One field, one meaning.
    createdAt: new Date().toISOString(),
    status: "pending",
    projectDir: input.projectDir ?? null,
  };
}

export function withStatus(stream: Stream, status: StreamStatus): Stream {
  return { ...stream, status };
}

export function withChat(stream: Stream, chatPath: string | null): Stream {
  return { ...stream, chatPath };
}

export function withDownloaded(stream: Stream, vodPath: string, chatPath: string | null): Stream {
  return { ...stream, vodPath, chatPath, status: "pending" };
}
