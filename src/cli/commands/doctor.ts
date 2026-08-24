import { CliConfigView, resolveUrl, resolveKey } from '../http-client';
import { detectManager } from '../manager';

/**
 * `doctor` — quick health check of the CLI's view of the gateway: is config
 * present, is a key resolvable, which manager owns the process, and does the
 * server answer. Never prints the key itself.
 */
export async function runDoctor(flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];

  const hasKeys = !!(config.keys && config.keys.length);
  checks.push({ name: 'config', ok: hasKeys, detail: hasKeys ? `${config.keys!.length} api key(s)` : 'no config / no api keys found' });

  const key = resolveKey({ flagKey: typeof flags.key === 'string' ? flags.key : undefined, env: process.env, config });
  checks.push({ name: 'apiKey', ok: !!key, detail: key ? 'resolved (hidden)' : 'none resolved (set --key or $CLAUDE_GATEWAY_API_KEY)' });

  const baseUrl = resolveUrl({ flagUrl: typeof flags.url === 'string' ? flags.url : undefined, env: process.env, config });
  checks.push({ name: 'url', ok: true, detail: baseUrl });

  const manager = detectManager();
  checks.push({ name: 'manager', ok: manager !== 'unknown', detail: manager });

  let health = false;
  try {
    const controller = new AbortController();
    const t = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    clearTimeout(t);
    health = res.ok;
  } catch {
    health = false;
  }
  checks.push({ name: 'health', ok: health, detail: health ? 'gateway responding' : 'no response' });

  const allOk = checks.every((c) => c.ok);
  const lines = checks.map((c) => `  [${c.ok ? 'ok' : '!!'}] ${c.name.padEnd(8)} ${c.detail}`);
  process.stderr.write(['claude-gateway doctor', ...lines, ''].join('\n'));
  process.stdout.write(JSON.stringify({ ok: allOk, checks }, null, 2) + '\n');
  return allOk ? 0 : 1;
}
