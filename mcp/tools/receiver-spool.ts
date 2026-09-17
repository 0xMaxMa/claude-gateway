import { mediaGroupKey, mergeMediaGroup, type ChannelInput } from './telegram/media-group';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readdirSync, openSync, closeSync, writeFileSync, fsyncSync, renameSync, readFileSync, unlinkSync, statSync, existsSync } from 'node:fs';
import { join } from 'node:path';

type RetryState = { queuedAt: number; attempts: number; nextAttemptAt: number; recoveryBatch?: string; sealedMessageIds?: string[] };
type Entry = { file: string; payload: string; input: ChannelInput; modified: number; state: RetryState; albumMessageIds?: string[] };
const MAX_BACKOFF_MS = 5 * 60_000;
const STALE_STARTUP_AGE_MS = 5 * 60_000;

/** Persist raw provider payloads until SQLite admission. Retry state is separate
 * so old journals remain readable and provider deduplication identities stay intact. */
export class ReceiverSpool {
  private active = false;
  private cursor = 0;
  private lastQueuedAt = 0;
  private reportedInvalidEntry = false;
  private readonly timer: ReturnType<typeof setInterval>;
  constructor(private readonly directory: string, private readonly callback: string, private readonly request: typeof fetch = fetch, private readonly mediaGroupWaitMs = 2000) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.pruneAlbumReceipts();
    const snapshot = this.entries();
    this.lastQueuedAt = Math.max(0, ...snapshot.map(entry => entry.state.queuedAt));
    const batches = new Map<string, string>();
    for (const entry of snapshot) {
      if (entry.state.recoveryBatch) batches.set(this.conversation(entry.input), entry.state.recoveryBatch);
    }
    for (const entry of snapshot) {
      const conversation = this.conversation(entry.input);
      if (Date.now() - entry.state.queuedAt > STALE_STARTUP_AGE_MS && !batches.has(conversation)) batches.set(conversation, randomUUID());
    }
    // Quarantine the entire startup conversation, including its newer tail.
    // Persist the batch before sending anything so retries/restarts share one notice.
    for (const entry of snapshot) {
      const batch = batches.get(this.conversation(entry.input));
      if (batch) this.saveState(entry.file, { ...entry.state, recoveryBatch: batch });
    }
    this.timer = setInterval(() => { void this.flush(); }, 1000); this.timer.unref();
    void this.flush();
  }
  private conversation(input: ChannelInput): string {
    const m = input?.meta ?? {};
    return JSON.stringify([m.source ?? m.channel ?? '', m.account_id ?? '', m.chat_id ?? '', m.message_thread_id ?? m.thread_id ?? m.thread_ts ?? '']);
  }
  private atomicWrite(file: string, payload: string): void {
    const temporary = join(this.directory, `${randomUUID()}.tmp`);
    const descriptor = openSync(temporary, 'wx', 0o600);
    try { writeFileSync(descriptor, payload); fsyncSync(descriptor); } finally { closeSync(descriptor); }
    renameSync(temporary, join(this.directory, file));
    this.syncDirectory();
  }
  private state(file: string, queuedAt: number): RetryState {
    try {
      const state = JSON.parse(readFileSync(join(this.directory, `${file}.retry`), 'utf8')) as RetryState;
      const timestamp = (value: number) => Number.isFinite(value) && value >= 0 && value <= Number.MAX_SAFE_INTEGER;
      if (!state || !timestamp(state.queuedAt) || !timestamp(state.nextAttemptAt)
        || !Number.isSafeInteger(state.attempts) || state.attempts < 0
        || (state.sealedMessageIds !== undefined && (!Array.isArray(state.sealedMessageIds) || state.sealedMessageIds.length > 10 || state.sealedMessageIds.some(id => typeof id !== 'string' || !id)))
        || (state.recoveryBatch !== undefined && (typeof state.recoveryBatch !== 'string' || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(state.recoveryBatch)))) {
        throw new Error('Invalid ingress retry state');
      }
      return state;
    }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      return { queuedAt, attempts: 0, nextAttemptAt: 0 };
    }
  }
  private saveState(file: string, state: RetryState): void { this.atomicWrite(`${file}.retry`, JSON.stringify(state)); }
  private entries(): Entry[] {
    const entries: Entry[] = [];
    const blocked = new Set<string>();
    for (const file of readdirSync(this.directory).filter(file => /^[a-f0-9]{64}\.json$/.test(file))) {
      let input: ChannelInput | undefined;
      try {
        const location = join(this.directory, file);
        const modified = statSync(location).mtimeMs;
        const payload = readFileSync(location, 'utf8');
        input = JSON.parse(payload) as ChannelInput;
        if (!input || typeof input !== 'object' || typeof input.content !== 'string'
          || !input.meta || typeof input.meta !== 'object' || Array.isArray(input.meta)
          || Object.values(input.meta).some(value => typeof value !== 'string')) {
          input = undefined;
          throw new Error('Invalid ingress payload');
        }
        // Validate nested album metadata inside the per-record boundary, so a
        // damaged album cannot abort delivery for unrelated conversations.
        let albumMessageIds: string[] | undefined;
        if (mediaGroupKey(input)) {
          const ids: unknown = JSON.parse(input.meta.message_ids_json);
          if (!Array.isArray(ids) || !ids.length || ids.length > 10 || ids.some(id=>typeof id !== 'string' || !id)) {
            throw new Error('Invalid ingress album members');
          }
          albumMessageIds = ids;
        }
        entries.push({ file, modified, payload, input, state: this.state(file, modified), albumMessageIds });
      } catch {
        // An identifiable conversation must not skip its damaged head. Other
        // conversations remain usable; preserve all bytes for operator recovery.
        if (input) blocked.add(this.conversation(input));
        if (!this.reportedInvalidEntry) {
          this.reportedInvalidEntry = true;
          process.stderr.write('Receiver spool retained an unreadable or invalid entry; inspect the local journal.\n');
        }
      }
    }
    return entries.filter(entry => !blocked.has(this.conversation(entry.input)))
      .sort((a, b) => a.state.queuedAt - b.state.queuedAt || a.file.localeCompare(b.file));
  }

  enqueue(input: unknown): void {
    const group = mediaGroupKey(input as ChannelInput);
    let albumKey = group;
    if (group) {
      const messageId = (input as ChannelInput).meta.message_id;
      const initial = this.state(`${group}.json`, Date.now());
      if (initial.sealedMessageIds) {
        if (initial.sealedMessageIds.includes(messageId)) return;
        // An attempted body is immutable: late members use their own stable
        // first-message identity, never an expanded body under an existing ID.
        albumKey = createHash('sha256').update(JSON.stringify([group, messageId])).digest('hex');
      }
      const target = `${albumKey}.json`;
      const state = this.state(target, Date.now());
      if (state.sealedMessageIds?.includes(messageId)) return;
      let prior: ChannelInput | undefined;
      try { prior = JSON.parse(readFileSync(join(this.directory, target), 'utf8')); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      input = mergeMediaGroup(prior, input as ChannelInput);
    }
    const payload = JSON.stringify(input);
    if (Buffer.byteLength(payload) > 131072) throw new Error('Ingress payload too large');
    const key = albumKey ?? createHash('sha256').update(payload).digest('hex');
    const file = `${key}.json`;
    const location = join(this.directory, file);
    const present = existsSync(location);
    if (!present && readdirSync(this.directory).filter(file => file.endsWith('.json')).length >= 1000) throw new Error('Ingress spool full');
    // Preserve admission order even when an album's quiet window is reset.
    const queuedAt = present ? statSync(location).mtimeMs : Math.max(Date.now(), this.lastQueuedAt + 0.01);
    const state = this.state(file, queuedAt);
    this.lastQueuedAt = Math.max(this.lastQueuedAt, state.queuedAt);
    this.saveState(file, state);
    this.atomicWrite(file, payload);
    void this.flush();
  }
  private pruneAlbumReceipts(): void {
    const receipts = readdirSync(this.directory).filter(file => /^[a-f0-9]{64}\.json\.retry$/.test(file)
      && !existsSync(join(this.directory, file.slice(0, -6))))
      .map(file => ({ file, modified: statSync(join(this.directory, file)).mtimeMs }))
      .sort((a, b) => b.modified - a.modified);
    let changed = false;
    for (const [index, receipt] of receipts.entries()) {
      if (index < 1000 && Date.now() - receipt.modified < 24 * 60 * 60_000) continue;
      // Do not remove an unknown/corrupt sidecar as part of receipt cleanup.
      try {
        if (!this.state(receipt.file.slice(0, -6), receipt.modified).sealedMessageIds) continue;
        unlinkSync(join(this.directory, receipt.file)); changed = true;
      } catch { /* Preserve unrecognized bytes for operator recovery. */ }
    }
    if (changed) this.syncDirectory();
  }
  private syncDirectory(): void {
    const descriptor = openSync(this.directory, 'r');
    try { fsyncSync(descriptor); } finally { closeSync(descriptor); }
  }
  private defer(entry: Entry, response?: Response): void {
    const attempts = Math.min(Number.MAX_SAFE_INTEGER, entry.state.attempts + 1);
    const exponential = Math.min(MAX_BACKOFF_MS, 1000 * 2 ** Math.min(attempts - 1, 9));
    const header = response?.headers.get('retry-after');
    const retryAfter = header ? (/^\d+(\.\d+)?$/.test(header) ? Number(header) * 1000 : Date.parse(header) - Date.now()) : 0;
    // Bound our exponential policy; honor a longer server-requested pause.
    const delay = Math.max(exponential, Number.isFinite(retryAfter) ? Math.min(24 * 60 * 60_000, retryAfter) : 0);
    this.saveState(entry.file, { ...entry.state, attempts, nextAttemptAt: Date.now() + delay });
  }
  async flush(): Promise<void> {
    if (this.active) return;
    this.active = true;
    try {
      const conversations = new Map<string, Entry[]>();
      for (const entry of this.entries()) {
        const conversation = this.conversation(entry.input);
        const entries = conversations.get(conversation) ?? [];
        entries.push(entry);
        conversations.set(conversation, entries);
      }
      const groups = [...conversations.values()];
      // Rotate conversation heads, then drain successful conversations round-robin.
      // Failed/waiting heads block only their own ordered tail.
      const start = this.cursor % Math.max(groups.length, 1);
      this.cursor = start + Math.min(100, groups.length);
      const pending = [...groups.slice(start), ...groups.slice(0, start)];
      let attempts = 0;
      while (pending.length && attempts < 100) {
        const group = pending.shift()!;
        const entry = group.shift()!;
        if (entry.state.nextAttemptAt > Date.now()) continue;
        // Another callback may have yielded while this unsealed album grew.
        // Refresh its full body and quiet window next pass before sealing it.
        if (readFileSync(join(this.directory, entry.file), 'utf8') !== entry.payload) continue;
        if (mediaGroupKey(entry.input) && Date.now() - entry.modified < this.mediaGroupWaitMs) continue;
        const body = entry.state.recoveryBatch ? JSON.stringify({ ...entry.input, meta: { ...entry.input.meta, ingress_recovery_batch: entry.state.recoveryBatch } }) : entry.payload;
        if (entry.albumMessageIds && !entry.state.sealedMessageIds) {
          entry.state = { ...entry.state, sealedMessageIds: entry.albumMessageIds };
          this.saveState(entry.file, entry.state);
        }
        attempts++;
        let response: Response;
        try {
          response = await this.request(this.callback, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(10000) });
        } catch { this.defer(entry); continue; }
        if (!response.ok) { this.defer(entry, response); continue; }
        const location = join(this.directory, entry.file);
        if (readFileSync(location, 'utf8') === entry.payload) {
          unlinkSync(location);
          const retry = join(this.directory, `${entry.file}.retry`);
          // Pending retries never expire. Acknowledged album receipts retain
          // member IDs for bounded platform-redelivery deduplication.
          if (entry.state.sealedMessageIds) this.saveState(entry.file, { ...entry.state, attempts: 0, nextAttemptAt: 0 });
          else if (existsSync(retry)) unlinkSync(retry);
          this.syncDirectory();
          if (entry.state.sealedMessageIds) this.pruneAlbumReceipts();
          if (group.length) pending.push(group);
        }
      }
    } catch { /* Keep persisted input on filesystem failure. */ }
    finally { this.active = false; }
  }
  close(): void { clearInterval(this.timer); }
}
