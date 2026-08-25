import { CliConfigView, resolveUrl, resolveLocalUrl, resolveKey } from '../http-client';
import { detectManager } from '../manager';
import { printJson } from '../output';

/**
 * `doctor` — quick health check of the CLI's view of the gateway: is config
 * present, is a key resolvable, which manager owns the process, and does the
 * server answer. Never prints the key itself.
 */

interface Check {
  name: string;
  ok: boolean;
  detail: string;
}

/** Probe `<baseUrl>/health`. The abort timer is cleared in `finally`: a
 *  rejected fetch would otherwise skip clearTimeout and leave a live timer
 *  holding the event loop open — and an unreachable gateway is exactly the
 *  case `doctor` is run for. */
async function probe(baseUrl: string, timeoutMs = 3000): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

export async function runDoctor(flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  const checks: Check[] = [];

  const hasKeys = !!(config.keys && config.keys.length);
  checks.push({ name: 'config', ok: hasKeys, detail: hasKeys ? `${config.keys!.length} api key(s)` : 'no config / no api keys found' });

  const key = resolveKey({ flagKey: typeof flags.key === 'string' ? flags.key : undefined, env: process.env, config });
  checks.push({ name: 'apiKey', ok: !!key, detail: key ? 'resolved (hidden)' : 'none resolved (set --key or $CLAUDE_GATEWAY_API_KEY)' });

  const flagUrl = typeof flags.url === 'string' ? flags.url : undefined;
  // The URL the CLI's own API calls will use (publicUrl/env win here) — that is
  // what `doctor` is diagnosing, so `health` reports on this one.
  const baseUrl = resolveUrl({ flagUrl, env: process.env, config });
  checks.push({ name: 'url', ok: true, detail: baseUrl });

  const manager = detectManager();
  checks.push({ name: 'manager', ok: manager !== 'unknown', detail: manager });

  checks.push({ name: 'health', ok: await probe(baseUrl), detail: '' });

  // When a gateway is running on this host behind a different URL (typically a
  // reverse proxy in config.gateway.publicUrl), probe it directly too. Without
  // this, the most confusing failure — proxy unreachable while the gateway is
  // perfectly healthy — shows up as `manager: foreground` next to
  // `health: no response`, with nothing to explain the contradiction.
  const localUrl = resolveLocalUrl({ flagUrl, env: process.env, config });
  if (manager !== 'unknown' && localUrl !== baseUrl) {
    checks.push({ name: 'localUrl', ok: true, detail: localUrl });
    checks.push({ name: 'localHealth', ok: await probe(localUrl), detail: '' });
  }

  for (const c of checks) {
    if (c.name === 'health' || c.name === 'localHealth') {
      c.detail = c.ok ? 'gateway responding' : 'no response';
    }
  }

  const allOk = checks.every((c) => c.ok);
  const lines = checks.map((c) => `  [${c.ok ? 'ok' : '!!'}] ${c.name.padEnd(11)} ${c.detail}`);
  const local = checks.find((c) => c.name === 'localHealth');
  if (local && local.ok && !checks.find((c) => c.name === 'health')!.ok) {
    lines.push('  note: the gateway is up locally but its public URL did not answer — check the reverse proxy.');
  }
  process.stderr.write(['claude-gateway doctor', ...lines, ''].join('\n'));
  printJson({ ok: allOk, checks }, flags);
  return allOk ? 0 : 1;
}
