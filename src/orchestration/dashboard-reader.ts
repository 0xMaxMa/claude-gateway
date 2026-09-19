import { Worker } from 'worker_threads';
import { join } from 'path';

/** One isolated reader per gateway, bounded requests and coalesced snapshots. */
export class DashboardReader {
  constructor(private readonly workerPath = join(__dirname, 'dashboard-reader-worker.js')) {}
  private worker?: Worker;
  private nextId = 0;
  private pending = new Map<number, { resolve(value: any): void; reject(error: Error): void; timer: NodeJS.Timeout }>();
  private inflight = new Map<string, Promise<any>>();
  private cache = new Map<string, { until: number; value: any }>();
  private closed = false;
  read(operation: 'summary' | 'report' | 'task' | 'session' | 'compaction' | 'charts', filename: string, options: Record<string, unknown> = {}): Promise<any> {
    if (this.closed) return Promise.reject(new Error('Dashboard reader is closed'));
    const key = JSON.stringify([operation, filename, options]);
    const cached = this.cache.get(key);
    if (cached && cached.until > Date.now()) return Promise.resolve(cached.value);
    const existing = this.inflight.get(key);
    if (existing) return existing;
    if (this.pending.size >= 64) return Promise.reject(new Error('Dashboard reader is busy'));
    if (!this.worker) {
      const worker = this.worker = new Worker(this.workerPath);
      worker.on('message', ({ id, value, error }) => {
        const request = this.pending.get(id);
        if (!request) return;
        clearTimeout(request.timer); this.pending.delete(id);
        if (!this.pending.size) worker.unref();
        if (error) request.reject(new Error(error)); else request.resolve(value);
      });
      worker.on('error', () => this.fail(worker));
      worker.on('exit', () => this.fail(worker));
      worker.unref();
    }
    const id = ++this.nextId;
    const promise = new Promise<any>((resolve, reject) => {
      const timer = setTimeout(() => { this.fail(this.worker!); }, 15000);
      timer.unref();
      this.pending.set(id, { resolve, reject, timer });
      this.worker!.ref();
      this.worker!.postMessage({ id, operation, filename, options });
    }).then(value => {
      if (operation === 'summary' || operation === 'charts') {
        if (this.cache.size >= 64) this.cache.delete(this.cache.keys().next().value!);
        this.cache.set(key, { until: Date.now() + (operation === 'charts' ? 10000 : 2000), value });
      }
      return value;
    }).finally(() => this.inflight.delete(key));
    this.inflight.set(key, promise);
    return promise;
  }
  private fail(worker: Worker): void {
    if (worker !== this.worker) return;
    this.worker = undefined;
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(new Error('Dashboard reader unavailable')); }
    this.pending.clear(); this.cache.clear();
    void worker.terminate();
  }
  async close(): Promise<void> {
    this.closed = true;
    const worker = this.worker;
    if (worker) { this.fail(worker); await worker.terminate(); }
  }
}
