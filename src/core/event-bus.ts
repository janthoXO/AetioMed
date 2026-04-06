export type Handler<T> = (payload: T) => void | Promise<void>

// Extensions augment this to register their event shapes
// eslint-disable-next-line @typescript-eslint/no-empty-object-type
export interface EventMap {}

export class EventBus {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private readonly handlers = new Map<string, Set<Handler<any>>>()

  on<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): () => void
  on(event: string, handler: Handler<unknown>): () => void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  on(event: string, handler: Handler<any>): () => void {
    if (!this.handlers.has(event)) this.handlers.set(event, new Set())
    this.handlers.get(event)!.add(handler)
    return () => this.handlers.get(event)?.delete(handler) // returns unsubscribe
  }

  off<K extends keyof EventMap>(event: K, handler: Handler<EventMap[K]>): void
  off(event: string, handler: Handler<unknown>): void
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  off(event: string, handler: Handler<any>): void {
    this.handlers.get(event)?.delete(handler)
  }

  async emit<K extends keyof EventMap>(event: K, payload: EventMap[K]): Promise<void>
  async emit(event: string, payload?: unknown): Promise<void>
  async emit(event: string, payload?: unknown): Promise<void> {
    const set = this.handlers.get(event)
    if (set) {
      await Promise.all([...set].map(fn => fn(payload)))
    }
  }
}
