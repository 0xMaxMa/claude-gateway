import { DatabaseSync } from 'node:sqlite';
import { chmodSync, mkdirSync } from 'fs';
import { dirname } from 'path';
import { randomUUID } from 'crypto';

export interface ProviderAdmissionPolicy {
  enabled: boolean;
  failureThreshold: number;
  initialCooldownMs: number;
  secondCooldownMs: number;
  maxCooldownMs: number;
  probeLeaseMs: number;
  recoverySpacingMs: number;
  /** Operator-controlled generation; increment only after repairing a blocked route. */
  recoveryGeneration: number;
}
export const PROVIDER_ADMISSION_DEFAULTS: ProviderAdmissionPolicy = {
  enabled: true, failureThreshold: 3, initialCooldownMs: 120000,
  secondCooldownMs: 300000, maxCooldownMs: 900000, probeLeaseMs: 120000,
  recoverySpacingMs: 1000, recoveryGeneration: 1,
};
export type ProviderFailureReason = 'transport' | 'server' | 'rate_limit' | 'quota' | 'authentication' | 'configuration' | 'first_response_timeout';
export interface ProviderFailure { reason: ProviderFailureReason; retryAt?: number; blocked?: boolean; }

/** Policy consumes structured evidence only. In particular, error prose and an
 * idle/tool/startup timeout do not establish a provider outage. First-token
 * timeouts are only counted against the caller's conservative route scope. */
export function providerFailure(error: unknown, now = Date.now()): ProviderFailure | undefined {
  const e = error as { code?: string; providerOrigin?: boolean; providerCodes?: unknown; status?: number; retryAfterMs?: number; resetAt?: number; timeout?: { phase?: string } } | null;
  if (!e || ['ABORT_ERR', 'CANCELLED', 'GATEWAY_SHUTDOWN', 'INTERRUPTED'].includes(e.code ?? '')) return;
  if (e.code === 'TIMEOUT' && !e.providerOrigin) return e.timeout?.phase === 'first_response' ? { reason: 'first_response_timeout' } : undefined;
  if (!e.providerOrigin) return;
  const codes = (Array.isArray(e.providerCodes) ? e.providerCodes.filter((c): c is string => typeof c === 'string') : []).map(c => c.toLowerCase());
  const has = (...values: string[]) => values.some(v => codes.includes(v));
  const retryAt = Number.isSafeInteger(e.resetAt) && e.resetAt! > now && e.resetAt! <= now + 30 * 86400000 ? e.resetAt
    : Number.isSafeInteger(e.retryAfterMs) && e.retryAfterMs! > 0 ? now + Math.min(e.retryAfterMs!, 30 * 86400000) : undefined;
  if (has('authentication_error', 'invalid_api_key', 'unauthenticated') || e.status === 401 || e.status === 403) return { reason: 'authentication', blocked: true };
  if (has('model_not_found', 'invalid_model')) return { reason: 'configuration', blocked: true };
  if (has('insufficient_quota', 'quota_exceeded', 'billing_error', 'payment_required', 'insufficient_credits', 'insufficient_balance') || e.status === 402) return { reason: 'quota', retryAt, blocked: !retryAt };
  if (has('rate_limit', 'rate_limit_error', 'rate_limit_exceeded', 'too_many_requests') || e.status === 429) return { reason: 'rate_limit', retryAt };
  if (has('overloaded_error', 'service_unavailable', 'server_error', 'api_error') || (e.status !== undefined && e.status >= 500 && e.status <= 599)) return { reason: 'server', retryAt };
  if (has('provider_transport_error', 'econnreset', 'econnrefused', 'etimedout', 'enotfound', 'eai_again', 'und_err_connect_timeout', 'und_err_socket')) return { reason: 'transport', retryAt };
  if (e.code === 'TIMEOUT' && e.timeout?.phase === 'first_response') return { reason: 'first_response_timeout' };
  return;
}

interface Circuit {
  scope: string; generation: number; failures: number; stage: number; episode: string;
  reason: ProviderFailureReason | null; retry_at: number | null; blocked: number;
  probe: string | null; lease_until: number; recovery: number; updated_at: number;
}
export interface ProviderWaiting {
  state: 'waiting_for_provider'; reason: ProviderFailureReason; episode: string;
  nextRetryAt?: number; requiresConfigurationChange: boolean;
}
export interface ProviderPermit { scope: string; generation: number; probe?: string; }
export type ProviderAdmission = { permit: ProviderPermit; waiting?: never } | { waiting: ProviderWaiting; permit?: never };

/** A shared durable admission gate, not a task scheduler. Transactions fence
 * half-open inference across agents and processes; only real inference closes
 * a circuit. No task revisions, inputs, receipts or provider secrets live here. */
export class ProviderAdmissionStore {
  private readonly db: DatabaseSync;
  constructor(filename: string, private readonly clock: () => number = Date.now) {
    if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(filename);
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.db.exec(`PRAGMA busy_timeout=1000; PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS provider_circuits (
        scope TEXT PRIMARY KEY, generation INTEGER NOT NULL, failures INTEGER NOT NULL,
        stage INTEGER NOT NULL, episode TEXT NOT NULL, reason TEXT, retry_at INTEGER,
        blocked INTEGER NOT NULL, probe TEXT, lease_until INTEGER NOT NULL,
        recovery INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS provider_admission_counters (name TEXT PRIMARY KEY, value INTEGER NOT NULL);`);
  }
  private transaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  private row(scope: string): Circuit | undefined { return this.db.prepare('SELECT * FROM provider_circuits WHERE scope=?').get(scope) as unknown as Circuit | undefined; }
  private count(name: string): void { this.db.prepare('INSERT INTO provider_admission_counters VALUES(?,1) ON CONFLICT(name) DO UPDATE SET value=value+1').run(name); }
  private waiting(row: Circuit, now: number): ProviderWaiting | undefined {
    if (!row.reason) return;
    if (!row.blocked && (row.retry_at ?? 0) <= now && (!row.probe || row.lease_until <= now)) return;
    return { state: 'waiting_for_provider', reason: row.reason, episode: row.episode,
      nextRetryAt: row.blocked ? undefined : Math.max(row.retry_at ?? 0, row.probe ? row.lease_until : 0), requiresConfigurationChange: Boolean(row.blocked) };
  }
  inspect(scope: string, policy: ProviderAdmissionPolicy): ProviderWaiting | undefined {
    if (!policy.enabled) return;
    const row = this.row(scope); return row && this.waiting(row, this.clock());
  }
  recovered(scope: string): boolean { const row = this.row(scope); return Boolean(row && !row.reason); }
  acquire(scope: string, policy: ProviderAdmissionPolicy): ProviderAdmission {
    if (!policy.enabled) return { permit: { scope, generation: -1 } };
    return this.transaction(() => {
      const now = this.clock();
      this.db.prepare('INSERT OR IGNORE INTO provider_circuits VALUES(?,0,0,0,?,NULL,NULL,0,NULL,0,0,?)').run(scope, randomUUID(), now);
      const row = this.row(scope)!;
      const waiting = this.waiting(row, now);
      if (waiting) { this.count('suppressed'); return { waiting }; }
      if (row.reason) {
        const probe = randomUUID();
        this.db.prepare('UPDATE provider_circuits SET probe=?,lease_until=?,updated_at=? WHERE scope=?').run(probe, now + policy.probeLeaseMs, now, scope);
        this.count('probes');
        return { permit: { scope, generation: row.generation, probe } };
      }
      return { permit: { scope, generation: row.generation } };
    });
  }
  renew(permit: ProviderPermit, policy: ProviderAdmissionPolicy): void {
    if (permit.probe) this.db.prepare('UPDATE provider_circuits SET lease_until=? WHERE scope=? AND generation=? AND probe=?')
      .run(this.clock() + policy.probeLeaseMs, permit.scope, permit.generation, permit.probe);
  }
  release(permit: ProviderPermit): void {
    if (permit.probe) this.db.prepare('UPDATE provider_circuits SET probe=NULL,lease_until=0 WHERE scope=? AND generation=? AND probe=?').run(permit.scope, permit.generation, permit.probe);
  }
  settle(permit: ProviderPermit, result: 'success' | ProviderFailure, policy: ProviderAdmissionPolicy): boolean {
    if (permit.generation < 0) return false;
    return this.transaction(() => {
      const row = this.row(permit.scope), now = this.clock();
      // An old healthy in-flight worker cannot close a newer outage; an expired
      // probe cannot overwrite its replacement after a crash/restart.
      if (!row || row.generation !== permit.generation || (row.reason && (row.probe ?? undefined) !== permit.probe)) return false;
      if (result === 'success') {
        if (permit.probe && row.recovery < 2) {
          this.db.prepare('UPDATE provider_circuits SET generation=generation+1,failures=0,recovery=recovery+1,probe=NULL,lease_until=0,retry_at=?,updated_at=? WHERE scope=?').run(now + policy.recoverySpacingMs, now, permit.scope);
        } else {
          this.db.prepare('UPDATE provider_circuits SET generation=generation+1,failures=0,stage=0,reason=NULL,retry_at=NULL,blocked=0,probe=NULL,lease_until=0,recovery=0,updated_at=? WHERE scope=?').run(now, permit.scope);
          if (permit.probe) this.count('recoveries');
        }
        const recovered = !permit.probe || row.recovery >= 2;
        permit.generation++;
        delete permit.probe;
        return recovered;
      }
      const failures = row.failures + 1;
      const opens = Boolean(row.reason || permit.probe || result.blocked || result.retryAt || failures >= policy.failureThreshold);
      if (!opens) { this.db.prepare('UPDATE provider_circuits SET failures=?,updated_at=? WHERE scope=?').run(failures, now, permit.scope); return false; }
      const stage = Math.min(2, row.reason ? row.stage + 1 : 0);
      const delay = [policy.initialCooldownMs, policy.secondCooldownMs, policy.maxCooldownMs][stage];
      this.db.prepare(`UPDATE provider_circuits SET generation=generation+1,failures=?,stage=?,episode=?,reason=?,retry_at=?,blocked=?,probe=NULL,lease_until=0,recovery=0,updated_at=? WHERE scope=?`)
        .run(failures, stage, row.reason ? row.episode : randomUUID(), result.reason, Math.max(now + delay, result.retryAt ?? 0), result.blocked ? 1 : 0, now, permit.scope);
      this.count('outages');
      return false;
    });
  }
  counters(): Record<string, number> { return Object.fromEntries(this.db.prepare('SELECT name,value FROM provider_admission_counters').all().map(r => [String(r.name), Number(r.value)])); }
  coalesced(count: number): void {
    if (Number.isSafeInteger(count) && count > 0) this.db.prepare("INSERT INTO provider_admission_counters VALUES('coalesced_notifications',?) ON CONFLICT(name) DO UPDATE SET value=value+excluded.value").run(count);
  }
  close(): void { this.db.close(); }
}
