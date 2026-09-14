import { DatabaseSync } from 'node:sqlite';
import { chmodSync } from 'fs';
import { OrchestrationError } from './types';

/** A separate SQLite file holds an OS-released instance lock. This connection
 * contains no application data and never shares task/history transactions.
 * Unlike PID files it survives crashes without stale-file deletion races. */
export function acquireInstanceLock(filename: string): () => void {
  const lock = new DatabaseSync(filename);
  try {
    chmodSync(filename, 0o600);
    lock.exec('PRAGMA busy_timeout=0; BEGIN EXCLUSIVE;');
  } catch {
    lock.close();
    throw new OrchestrationError('ORCHESTRATION_ALREADY_RUNNING');
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    try { lock.exec('ROLLBACK'); } finally { lock.close(); }
  };
}
