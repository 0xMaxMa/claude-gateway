import { scrubText } from '../../agent/incident';
import { TaskFailure } from '../types';
/** Retain bounded error evidence, never a raw process transcript or credentials. */
export function taskFailure(error: unknown, fallback = 'WORKER_FAILED'): TaskFailure {
  const value = error as {code?: unknown; message?: unknown};
  const code = typeof value?.code === 'string' && /^[A-Z0-9_]{1,80}$/.test(value.code) ? value.code : fallback;
  const message = typeof value?.message === 'string' ? value.message : 'Worker execution did not complete.';
  const secrets = Object.entries(process.env).filter(([key,v]) => /TOKEN|SECRET|PASSWORD|API_KEY/i.test(key) && v && v.length >= 8).map(([,v]) => v!);
  return {code, message: scrubText(message, secrets).slice(0,2048), observedAt: Date.now()};
}
export function shutdownFailure(): TaskFailure {
  return {code:'GATEWAY_SHUTDOWN',message:'Gateway shutdown interrupted this worker. This is not a finding about the issue. Inspect existing changes before continuing; do not blindly repeat side effects.',observedAt:Date.now()};
}
