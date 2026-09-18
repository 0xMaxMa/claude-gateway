import { OrchestrationStore, payloadHash } from './store';
import { OrchestrationError } from './types';

export interface ContextDeliveryScope {
  conversationId: string;
  principalId: string;
  bindingId: string;
  cliSessionId: string;
  resume: boolean;
}

export interface ContextDeliveryPlan {
  readonly fresh: boolean;
  /** Select complete changed/new values and stage their fingerprints. */
  select<T>(bucket: string, items: T[], key: (value: T) => string): T[];
  includes(bucket: string, key: string): boolean;
  mark(bucket: string, key: string, value: unknown): void;
  /** Call only after successful, noninterrupted CLI completion. False means stale. */
  commit(): boolean;
  /** A compact boundary forgets delivery knowledge, never canonical history. */
  invalidate(): void;
}

/** Durable knowledge of what this CLI context has seen; contains no prompt payloads. */
export class ContextDelivery {
  constructor(private readonly store: OrchestrationStore) {
    store.run(`CREATE TABLE IF NOT EXISTS context_delivery(
      conversation_id TEXT NOT NULL REFERENCES conversations(id),
      principal_id TEXT NOT NULL,
      binding_id TEXT NOT NULL REFERENCES conversation_bindings(id),
      cli_session_id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      fingerprints_json TEXT NOT NULL,
      PRIMARY KEY(conversation_id,principal_id,binding_id))`);
    store.run(`CREATE TABLE IF NOT EXISTS context_delivery_generations(
      conversation_id TEXT PRIMARY KEY REFERENCES conversations(id),generation INTEGER NOT NULL)`);
  }

  /** Trusted runtime hook for manual compact, including plans not yet committed. */
  invalidateConversation(conversationId: string): void {
    this.store.transaction(() => {
      this.store.run(`INSERT INTO context_delivery_generations VALUES(?,1)
        ON CONFLICT(conversation_id) DO UPDATE SET generation=generation+1`, conversationId);
      this.store.run("UPDATE context_delivery SET revision=revision+1,fingerprints_json='[]' WHERE conversation_id=?", conversationId);
    });
  }

  begin(scope: ContextDeliveryScope): ContextDeliveryPlan {
    const { conversationId, principalId, bindingId, cliSessionId, resume } = scope;
    const store = this.store;
    store.assertMember(conversationId, principalId);
    if (!store.get('SELECT id FROM conversation_bindings WHERE id=? AND conversation_id=?', bindingId, conversationId))
      throw new OrchestrationError('ACCESS_DENIED');
    if (!cliSessionId) throw new OrchestrationError('INVALID_INPUT');
    const ids = [conversationId, principalId, bindingId];
    const row = store.get('SELECT * FROM context_delivery WHERE conversation_id=? AND principal_id=? AND binding_id=?', ...ids);
    const revision = row ? Number(row.revision) : 0;
    const generation = Number(store.get('SELECT generation FROM context_delivery_generations WHERE conversation_id=?', conversationId)?.generation ?? 0);
    const fresh = !resume || row?.cli_session_id !== cliSessionId || row.fingerprints_json === '[]';
    // Existing installations have no checkpoint: replay once, then remember only
    // the data delivered by the successful turn. A failed bootstrap writes nothing.
    const hashes = new Map<string, string>(resume && row?.cli_session_id === cliSessionId
      ? JSON.parse(String(row.fingerprints_json)) : []);
    const entryKey = (bucket: string, key: string) => JSON.stringify([bucket, key]);
    let closed = false;
    return {
      fresh,
      select<T>(bucket: string, items: T[], key: (value: T) => string): T[] {
        return items.filter(value => {
          const id = entryKey(bucket, key(value)), hash = payloadHash(value);
          if (hashes.get(id) === hash) return false;
          hashes.set(id, hash);
          return true;
        });
      },
      includes: (bucket, key) => hashes.has(entryKey(bucket, key)),
      mark: (bucket, key, value) => { hashes.set(entryKey(bucket, key), payloadHash(value)); },
      commit(): boolean {
        if (closed) return false;
        closed = true;
        return store.transaction(() => {
          if (Number(store.get('SELECT generation FROM context_delivery_generations WHERE conversation_id=?', conversationId)?.generation ?? 0) !== generation) return false;
          const serialized = JSON.stringify([...hashes]);
          const result = row
            ? store.run(`UPDATE context_delivery SET cli_session_id=?,revision=revision+1,fingerprints_json=?
                WHERE conversation_id=? AND principal_id=? AND binding_id=? AND revision=?`,
              cliSessionId, serialized, ...ids, revision)
            : store.run('INSERT OR IGNORE INTO context_delivery VALUES(?,?,?,?,1,?)', ...ids, cliSessionId, serialized);
          return Number(result.changes) === 1;
        });
      },
      invalidate(): void {
        closed = true;
        // Keep a revision tombstone even if no successful turn has committed yet;
        // otherwise an older bootstrap plan could resurrect pre-compact knowledge.
        store.run(`INSERT INTO context_delivery VALUES(?,?,?,?,1,'[]')
          ON CONFLICT(conversation_id,principal_id,binding_id) DO UPDATE SET
          revision=context_delivery.revision+1,fingerprints_json='[]'`, ...ids, cliSessionId);
        hashes.clear();
      },
    };
  }
}
