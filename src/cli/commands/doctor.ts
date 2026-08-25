import { CliConfigView, resolveUrl, resolveLocalUrl, resolveKey } from '../http-client';
import { detectManager } from '../manager';
import { printJson } from '../output';
import { paletteFor } from '../colors';

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

interface ProbeResult {
  /** True only for a 2xx — the CLI can actually use this URL. */
  ok: boolean;
  /** True when something answered at all, whatever the status. */
  answered: boolean;
  /** The HTTP status, when there was one. */
  status?: number;
  detail: string;
}

/** Probe `<baseUrl>/health`.
 *
 *  An HTTP status is reported verbatim rather than collapsed into "no
 *  response": a reverse proxy that replies 401 is *up*, and saying otherwise
 *  sends the operator to debug a proxy that is working fine.
 *
 *  The abort timer is cleared in `finally`: a rejected fetch would otherwise
 *  skip clearTimeout and leave a live timer holding the event loop open — and
 *  an unreachable gateway is exactly the case `doctor` is run for. */
async function probe(baseUrl: string, timeoutMs = 3000): Promise<ProbeResult> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(`${baseUrl}/health`, { signal: controller.signal });
    if (res.ok) return { ok: true, answered: true, detail: 'gateway responding' };
    return {
      ok: false,
      answered: true,
      status: res.status,
      detail: `HTTP ${res.status} (answered, but not a healthy gateway)`,
    };
  } catch (err) {
    const aborted = (err as { name?: string } | undefined)?.name === 'AbortError';
    return {
      ok: false,
      answered: false,
      detail: aborted ? `no response (timed out after ${timeoutMs}ms)` : 'no response',
    };
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

  const health = await probe(baseUrl);
  checks.push({ name: 'health', ok: health.ok, detail: health.detail });

  // When a gateway is running on this host behind a different URL (typically a
  // reverse proxy in config.gateway.publicUrl), probe it directly too. Without
  // this, the most confusing failure — proxy unreachable while the gateway is
  // perfectly healthy — shows up as `manager: foreground` next to
  // `health: no response`, with nothing to explain the contradiction.
  const localUrl = resolveLocalUrl({ flagUrl, env: process.env, config });
  let localOk = false;
  if (manager !== 'unknown' && localUrl !== baseUrl) {
    checks.push({ name: 'localUrl', ok: true, detail: localUrl });
    const localHealth = await probe(localUrl);
    localOk = localHealth.ok;
    checks.push({ name: 'localHealth', ok: localHealth.ok, detail: localHealth.detail });
  }

  const allOk = checks.every((c) => c.ok);
  const c = paletteFor(process.stderr);
  // Pad before colouring so escape codes never count toward the column width.
  const lines = checks.map(
    (chk) => `  ${chk.ok ? c.green('[ok]') : c.red('[!!]')} ${c.bold(chk.name.padEnd(11))} ${chk.detail}`,
  );
  // Explain the contradiction the two probes can produce, and blame the right
  // component: a public URL that answered with a status is not an unreachable
  // proxy, it is a reachable one rejecting the request.
  if (localOk && !health.ok) {
    const note = health.answered
      ? `note: the gateway is up locally, but its public URL answered HTTP ${health.status} — the proxy in front of it rejected this request.`
      : 'note: the gateway is up locally but its public URL did not answer — check the reverse proxy.';
    lines.push(`  ${c.yellow(note)}`);
  }
  process.stderr.write([`${c.bold('claude-gateway doctor')}`, ...lines, ''].join('\n'));
  printJson({ ok: allOk, checks }, flags);
  return allOk ? 0 : 1;
}
