import { createHash, randomBytes } from 'crypto';
import { closeSync, chmodSync, mkdirSync, openSync } from 'fs';
import { dirname } from 'path';
import { DatabaseSync } from 'node:sqlite';
import type { ApiKey } from '../types';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');

/** Opaque cookies; only token/key digests are stored. Opening is lazy so a
 * read-only install can still start and accept admin API keys. */
export class DashboardSessions {
  private db?: DatabaseSync;
  constructor(private readonly filename: string = ':memory:') {}

  private database(): DatabaseSync {
    if (this.db) return this.db;
    if (this.filename !== ':memory:') {
      mkdirSync(dirname(this.filename), {recursive:true, mode:0o700});
      closeSync(openSync(this.filename, 'a', 0o600));
      chmodSync(this.filename, 0o600);
    }
    const db = new DatabaseSync(this.filename);
    try {
      db.exec(`PRAGMA busy_timeout=1000;
        CREATE TABLE IF NOT EXISTS sessions (
          token_hash TEXT PRIMARY KEY, key_hash TEXT NOT NULL, expires_at INTEGER NOT NULL
        );
        CREATE INDEX IF NOT EXISTS sessions_expiry ON sessions(expires_at);`);
      this.db = db;
      return db;
    } catch (error) { db.close(); throw error; }
  }

  issue(key: string, ttlMs: number): string {
    this.prune();
    const token = randomBytes(32).toString('hex');
    this.database().prepare('INSERT INTO sessions VALUES (?, ?, ?)')
      .run(digest(token), digest('dashboard-admin-key:' + key), Date.now() + ttlMs);
    return token;
  }

  valid(token: string, keys: ApiKey[]): boolean {
    if (!/^[a-f0-9]{64}$/.test(token)) return false;
    const row = this.database().prepare('SELECT key_hash, expires_at FROM sessions WHERE token_hash=?')
      .get(digest(token)) as {key_hash:string; expires_at:number} | undefined;
    if (!row) return false;
    if (row.expires_at <= Date.now() || !keys.some(key => key.admin && digest('dashboard-admin-key:' + key.key) === row.key_hash)) {
      this.revoke(token);
      return false;
    }
    return true;
  }

  revoke(token: string): void {
    if (/^[a-f0-9]{64}$/.test(token)) this.database().prepare('DELETE FROM sessions WHERE token_hash=?').run(digest(token));
  }
  prune(): void { this.database().prepare('DELETE FROM sessions WHERE expires_at<=?').run(Date.now()); }
  close(): void { this.db?.close(); this.db = undefined; }
}
