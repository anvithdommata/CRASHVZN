/** Minimal push → async-iterator bridge for streaming adapter events. */
export class EventQueue<T> implements AsyncIterable<T> {
  private items: T[] = [];
  private waiters: ((r: IteratorResult<T>) => void)[] = [];
  private closed = false;

  push(item: T): void {
    if (this.closed) return;
    const w = this.waiters.shift();
    if (w) w({ value: item, done: false });
    else this.items.push(item);
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w({ value: undefined as never, done: true });
  }

  get isClosed(): boolean {
    return this.closed;
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: () => {
        const item = this.items.shift();
        if (item !== undefined) return Promise.resolve({ value: item, done: false });
        if (this.closed) return Promise.resolve({ value: undefined as never, done: true });
        return new Promise((resolve) => this.waiters.push(resolve));
      },
    };
  }
}

/**
 * The one turn an adapter may have in flight. A turn is active from `begin()` until its queue is
 * closed (done, error, or `fail()`); only then can the next one begin.
 */
export class TurnSlot<T> {
  private queue: EventQueue<T> | null = null;

  /** Starts a turn. Throws if one is still running. */
  begin(): EventQueue<T> {
    if (this.active) throw new Error("A turn is already running; wait for it or interrupt().");
    this.queue = new EventQueue<T>();
    return this.queue;
  }

  /** The running turn's queue, or null when no turn is running. */
  get active(): EventQueue<T> | null {
    return this.queue && !this.queue.isClosed ? this.queue : null;
  }

  /** Ends the running turn (if any) with a final event. */
  end(last: T): void {
    const q = this.active;
    if (!q) return;
    q.push(last);
    q.close();
  }
}
