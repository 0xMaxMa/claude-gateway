import { scrubText } from '../../agent/incident';
import { InventoryRejection, TaskFailure } from '../types';
/** Environment values that look like credentials, for redaction from persisted evidence. */
export function collectEnvSecrets(): string[] {
  return Object.entries(process.env).filter(([key,v]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && v && v.length >= 8).map(([,v]) => v!);
}
/** Bound and sanitize one advertised tool name before it is persisted or logged as evidence.
 * A raw tool name is not guaranteed credential-free, so scrub secrets first; the charset then
 * keeps only name-shaped characters plus the angle brackets used by the `<placeholder>` tokens. */
export function sanitizeToolName(name: unknown, secrets: string[]): string {
  return typeof name === 'string' ? scrubText(name, secrets).replace(/[^a-zA-Z0-9_.:<>-]/g, '?').slice(0, 160) : '<invalid-name>';
}
/** Preserve bounded, sanitized inventory-rejection evidence across error conversion.
 * The names were sanitized at the validation boundary; re-scrub and re-bound here anyway
 * because this is the durable gate and a caller may construct the error directly. */
function inventoryEvidence(value: {inventoryKind?: unknown; rejectedTools?: unknown}, secrets: string[]): InventoryRejection | undefined {
  const kind = value?.inventoryKind;
  if (kind !== 'missing' && kind !== 'malformed' && kind !== 'unexpected') return undefined;
  const rejectedTools = (Array.isArray(value?.rejectedTools) ? value.rejectedTools : []).slice(0, 100)
    .map(name => sanitizeToolName(name, secrets));
  return { kind, rejectedTools };
}
/** Retain bounded error evidence, never a raw process transcript or credentials. */
export function taskFailure(error: unknown, fallback = 'WORKER_FAILED'): TaskFailure {
  const value = error as {code?: unknown; message?: unknown; inventoryKind?: unknown; rejectedTools?: unknown};
  const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : fallback;
  const message = typeof value?.message === 'string' ? value.message : 'Worker execution did not complete.';
  const secrets = collectEnvSecrets();
  const inventory = inventoryEvidence(value, secrets);
  return {code, message: scrubText(message, secrets).slice(0,2048), observedAt: Date.now(), ...(inventory ? {inventory} : {})};
}
export function shutdownFailure(): TaskFailure {
  return {code:'GATEWAY_SHUTDOWN',message:'Gateway shutdown interrupted this worker. This is not a finding about the issue. Inspect existing changes before continuing; do not blindly repeat side effects.',observedAt:Date.now()};
}
