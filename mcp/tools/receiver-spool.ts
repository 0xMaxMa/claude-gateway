import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, unlinkSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Receiver-local handoff journal. Persist before returning to the platform
 * client; only remove after the gateway confirms its SQLite admission. */
export class ReceiverSpool {
  private active = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly directory: string, private readonly callback: string, private readonly request: typeof fetch = fetch) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref();
    void this.flush();
  }
  enqueue(input: unknown): void {
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > 131072) throw new Error('Ingress payload too large');
    if (readdirSync(this.directory).filter(file => file.endsWith('.json')).length >= 1000) throw new Error('Ingress spool full');
    const key = createHash('sha256').update(payload).digest('hex');
    const temporary = join(this.directory, `${key}.${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(descriptor, payload); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, join(this.directory, `${key}.json`));
    this.syncDirectory();
    void this.flush();
  }
  private syncDirectory(): void {
    const descriptor = openSync(this.directory, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  async flush(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const files = readdirSync(this.directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file)).map(file => ({ file, created: statSync(join(this.directory, file)).mtimeMs })).sort((a, b) => a.created - b.created);
      for (const { file } of files.slice(0, 100)) {
        const location = join(this.directory, file);
        const response = await this.request(this.callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: readFileSync(location, 'utf8'), signal: AbortSignal.timeout(10000) });
        if (!response.ok) break;
        unlinkSync(location); this.syncDirectory();
      }
    } catch { /* persisted message is retried on next tick or process restart */ }
    finally { this.active = false; }
  }
  close(): void { clearInterval(this.timer); }
}
