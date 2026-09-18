import { upgradeWebSocket } from "hono/deno";
import type { EventBus } from "@/application/ports/outbound.ts";
import {
  ENGINE_EVENT_TOPIC,
  JOB_STATUS_TOPIC,
  STREAM_STATUS_TOPIC,
  DOWNLOAD_PROGRESS_TOPIC,
  STREAM_CHANGED_TOPIC,
} from "@/application/ports/outbound.ts";
import type { WsEvent } from "shared/types";

const TOPICS = [
  ENGINE_EVENT_TOPIC,
  JOB_STATUS_TOPIC,
  STREAM_STATUS_TOPIC,
  DOWNLOAD_PROGRESS_TOPIC,
  STREAM_CHANGED_TOPIC,
];

/**
 * Creates the upgradeWebSocket middleware. On open, subscribes to all
 * event bus topics and forwards events to the client as JSON.
 * On close, unsubscribes.
 */
export function wsHandler(bus: EventBus) {
  return upgradeWebSocket(() => {
    let unsubs: Array<() => void> = [];

    return {
      onOpen(_evt: Event, ws: { readyState: number; send: (data: string) => void }) {
        const send = (event: unknown) => {
          if (ws.readyState === 1) ws.send(JSON.stringify(event as WsEvent));
        };
        unsubs = TOPICS.map((topic) => bus.subscribe<unknown>(topic, send));
      },
      onClose() {
        for (const unsub of unsubs) unsub();
        unsubs = [];
      },
    };
  });
}
