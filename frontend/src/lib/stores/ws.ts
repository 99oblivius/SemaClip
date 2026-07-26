import { writable, type Readable } from 'svelte/store';
import type { WsEvent } from '$shared/types';

type WsState = { connected: boolean; events: WsEvent[] };

function createWsStore(): Readable<WsState> & {
  connect: () => void;
  onEvent: <T extends WsEvent>(handler: (event: T) => void) => () => void;
} {
  let socket: WebSocket | null = null;
  const handlers = new Set<(event: WsEvent) => void>();

  const { subscribe, update, set } = writable<WsState>({ connected: false, events: [] });

  function connect() {
    if (socket?.readyState === WebSocket.OPEN) return;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    socket = new WebSocket(wsUrl);
    socket.onopen = () => set({ connected: true, events: [] });
    socket.onclose = () => set({ connected: false, events: [] });
    socket.onmessage = (msg) => {
      try {
        const event = JSON.parse(msg.data) as WsEvent;
        update((s) => ({ ...s, events: [...s.events.slice(-99), event] }));
        for (const h of handlers) h(event);
      } catch {
        // Malformed message — ignore.
      }
    };
  }

  function onEvent<T extends WsEvent>(handler: (event: T) => void): () => void {
    const wrapped = (event: WsEvent) => handler(event as T);
    handlers.add(wrapped);
    return () => handlers.delete(wrapped);
  }

  return { subscribe, connect, onEvent };
}

export const wsStore = createWsStore();
