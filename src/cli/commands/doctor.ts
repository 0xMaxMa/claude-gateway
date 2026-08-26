import { CliConfigView, resolveUrl, resolveLocalUrl, resolveKey } from '../http-client';
import { probeHealth, HealthProbe } from '../health';
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
  /** Informational only: reported, but never fails the command. Used for the
   *  URL the CLI is *not* using — its state is context, not a verdict. */
  info?: boolean;
}

export async function runDoctor(flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  const checks: Check[] = [];

  const hasKeys = !!(config.keys && config.keys.length);
  checks.push({ name: 'config', ok: hasKeys, detail: hasKeys ? `${config.keys!.length} api key(s)` : 'no config / no api keys found' });

  const key = resolveKey({ flagKey: typeof flags.key === 'string' ? flags.key : undefined, env: process.env, config });
  checks.push({ name: 'apiKey', ok: !!key, detail: key ? 'resolved (hidden)' : 'none resolved (set --key or $CLAUDE_GATEWAY_API_KEY)' });

  const flagUrl = typeof flags.url === 'string' ? flags.url : undefined;
  // The URL the CLI's own API calls will use — that is what `doctor` diagnoses,
  // so `health` reports on this one and only this one decides the exit code.
  const baseUrl = resolveUrl({ flagUrl, env: process.env, config });
  checks.push({ name: 'url', ok: true, detail: baseUrl });

  const manager = detectManager();
  checks.push({ name: 'manager', ok: manager !== 'unknown', detail: manager });

  const health = await probeHealth(baseUrl);
  checks.push({ name: 'health', ok: health.ok, detail: health.detail });

  // A gateway fronted by a reverse proxy has two addresses for one process.
  // Probe the one the CLI is *not* using as well: without it, the most
  // confusing states — proxy down while the gateway is healthy, or the reverse
  // — appear as a single contradictory line with nothing to explain it. The
  // second probe is informational: the CLI does not use that address, so its
  // state must not decide this command's exit code.
  // Deliberately resolved without `flagUrl`: this is the address of the gateway
  // *on this host*, which is the useful context when the CLI has been pointed
  // somewhere else. Passing the flag through would make it echo the target back
  // as its own alternative, and then offer this host's publicUrl as context for
  // a question about another host entirely.
  const localUrl = resolveLocalUrl({ env: process.env, config });
  const publicUrl = (config.publicUrl ?? '').replace(/\/+$/, '');
  const alt =
    baseUrl === localUrl
      ? publicUrl && publicUrl !== baseUrl
        ? { urlName: 'publicUrl', healthName: 'publicHealth', url: publicUrl }
        : undefined
      : manager !== 'unknown'
        ? { urlName: 'localUrl', healthName: 'localHealth', url: localUrl }
        : undefined;

  let altHealth: HealthProbe | undefined;
  if (alt) {
    checks.push({ name: alt.urlName, ok: true, detail: alt.url, info: true });
    altHealth = await probeHealth(alt.url);
    checks.push({ name: alt.healthName, ok: altHealth.ok, detail: altHealth.detail, info: true });
  }

  const allOk = checks.every((c) => c.info || c.ok);
  const c = paletteFor(process.stderr);
  // Pad before colouring so escape codes never count toward the column width.
  const lines = checks.map((chk) => {
    const mark = chk.ok ? c.green('[ok]') : chk.info ? c.dim('[--]') : c.red('[!!]');
    return `  ${mark} ${c.bold(chk.name.padEnd(12))} ${chk.detail}`;
  });
  // Name the right component. A public URL that answered with a status is not
  // an unreachable proxy, it is a reachable one rejecting the request — and a
  // proxy that requires its own credentials is doing its job, not failing.
  if (alt && altHealth) {
    if (alt.urlName === 'publicUrl' && health.ok && !altHealth.ok) {
      lines.push(
        `  ${c.yellow(
          altHealth.answered
            ? `note: the CLI is using the local address; the public URL answered HTTP ${altHealth.status}, so the proxy in front of the gateway rejected an unauthenticated request. External clients are unaffected if they authenticate with the proxy.`
            : 'note: the CLI is using the local address; the public URL did not answer at all — external clients would not reach the gateway.',
        )}`,
      );
    } else if (alt.urlName === 'localUrl' && altHealth.ok && !health.ok) {
      lines.push(
        `  ${c.yellow(
          health.answered
            ? `note: the gateway is up locally, but the URL the CLI was told to use answered HTTP ${health.status} — the proxy in front of it rejected this request. Drop --url / $CLAUDE_GATEWAY_URL to use ${localUrl} instead.`
            : `note: the gateway is up locally but the URL the CLI was told to use did not answer. Drop --url / $CLAUDE_GATEWAY_URL to use ${localUrl} instead.`,
        )}`,
      );
    }
  }
  process.stderr.write([`${c.bold('claude-gateway doctor')}`, ...lines, ''].join('\n'));
  printJson({ ok: allOk, checks }, flags);
  return allOk ? 0 : 1;
}
