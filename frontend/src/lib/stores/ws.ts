import { writable, type Readable } from 'svelte/store';
import type { WsEvent } from '$shared/types';

type WsState = { connected: boolean; events: WsEvent[] };

function createWsStore(): Readable<WsState> & {
  connect: () => void;
  disconnect: () => void;
  onEvent: <T extends WsEvent>(handler: (event: T) => void) => () => void;
} {
  let socket: WebSocket | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let intentionalClose = false;
  const handlers = new Set<(event: WsEvent) => void>();

  const { subscribe, update, set } = writable<WsState>({ connected: false, events: [] });

  /** Exponential backoff with a cap: 0.5s, 1s, 2s, 4s … max 15s. */
  function scheduleReconnect() {
    if (reconnectTimer !== null) return;
    const delay = Math.min(15000, 500 * Math.pow(2, reconnectAttempt));
    reconnectAttempt++;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, delay);
  }

  function connect() {
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) return;
    const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
    socket = new WebSocket(wsUrl);
    socket.onopen = () => {
      reconnectAttempt = 0;
      set({ connected: true, events: [] });
    };
    socket.onclose = () => {
      set({ connected: false, events: [] });
      scheduleReconnect();
    };
    socket.onerror = () => {
      // onclose follows in browsers; nothing to do beyond letting it fire.
    };
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

  function disconnect() {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (socket) {
      // Mark intentional so onclose doesn't schedule a reconnect.
      socket.onclose = null;
      socket.close();
      socket = null;
    }
    set({ connected: false, events: [] });
  }

  function onEvent<T extends WsEvent>(handler: (event: T) => void): () => void {
    const wrapped = (event: WsEvent) => handler(event as T);
    handlers.add(wrapped);
    return () => handlers.delete(wrapped);
  }

  return { subscribe, connect, disconnect, onEvent };
}

export const wsStore = createWsStore();