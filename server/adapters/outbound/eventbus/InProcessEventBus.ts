import type { EventBus, EventHandler } from "@/application/ports/outbound.ts";

type Handlers = Set<EventHandler>;

/** In-process pub/sub. Topics are strings; handlers called synchronously on publish. */
export class InProcessEventBus implements EventBus {
  private readonly topics = new Map<string, Handlers>();

  publish<T>(topic: string, event: T): void {
    const handlers = this.topics.get(topic);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        h(event as unknown);
      } catch (err) {
        console.error(`EventBus handler error [${topic}]:`, err);
      }
    }
  }

  subscribe<T>(topic: string, handler: EventHandler<T>): () => void {
    let handlers = this.topics.get(topic);
    if (!handlers) {
      handlers = new Set();
      this.topics.set(topic, handlers);
    }
    handlers.add(handler as EventHandler);
    return () => {
      handlers?.delete(handler as EventHandler);
      if (handlers && handlers.size === 0) this.topics.delete(topic);
    };
  }
}
