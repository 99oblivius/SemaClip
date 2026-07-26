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
    createdAt: new Date().toISOString(),
    status: "pending",
  };
}

export function withStatus(stream: Stream, status: StreamStatus): Stream {
  return { ...stream, status };
}

export function withDownloaded(stream: Stream, vodPath: string, chatPath: string | null): Stream {
  return { ...stream, vodPath, chatPath, status: "pending" };
}
