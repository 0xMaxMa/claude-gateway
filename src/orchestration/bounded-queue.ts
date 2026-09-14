/** Independent bounded queues keep slow audio/event consumers off producers. */
export class BoundedQueue<T> implements AsyncIterable<T> {
  private items: Array<{ value: T; size: number }> = [];
  private waiters: Array<{ resolve: (value: IteratorResult<T>) => void; reject: (error: Error) => void }> = [];
  private bytes = 0;
  private ended = false;
  private error?: Error;
  constructor(private readonly maxBytes: number, private readonly size: (item: T) => number) {}
  push(value: T): void {
    if (this.ended) return;
    const size = this.size(value);
    if (size > this.maxBytes || this.bytes + size > this.maxBytes) { this.close(Object.assign(new Error('CONSUMER_TOO_SLOW'), { code: 'CONSUMER_TOO_SLOW' })); throw Object.assign(new Error('CONSUMER_TOO_SLOW'), { code: 'CONSUMER_TOO_SLOW' }); }
    const waiter = this.waiters.shift();
    if (waiter) waiter.resolve({ value, done: false });
    else { this.items.push({ value, size }); this.bytes += size; }
  }
  close(error?: Error): void {
    if (this.ended) return;
    this.ended = true; this.error = error;
    if (error) { this.items = []; this.bytes = 0; }
    for (const waiter of this.waiters.splice(0)) error ? waiter.reject(error) : waiter.resolve({ value: undefined as T, done: true });
  }
  [Symbol.asyncIterator](): AsyncIterator<T> {
    return { next: () => {
      const item = this.items.shift();
      if (item) { this.bytes -= item.size; return Promise.resolve({ value: item.value, done: false }); }
      if (this.error) return Promise.reject(this.error);
      if (this.ended) return Promise.resolve({ value: undefined as T, done: true });
      return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
    }, return: async () => { this.close(); return { value: undefined as T, done: true }; } };
  }
}
