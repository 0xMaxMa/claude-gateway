import { CliConfigView, resolveUrl, resolveLocalUrl, resolveKey } from '../http-client';
import { probeHealth, HealthProbe } from '../health';
import { detectManager } from '../manager';
import { printJson, helpStream, writeCommandHelp } from '../output';
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
  /** A real gap worth the operator's attention, but not a failure: some
   *  deployments (LINE-only, localhost-only) are legitimately fine without the
   *  thing being warned about. Never fails the command, like `info`, but
   *  rendered distinctly so it doesn't read as "nothing to see here". */
  warn?: boolean;
}

function printHelp(): void {
  const c = paletteFor(helpStream(true));
  writeCommandHelp(
    true,
    'doctor',
    'check config, key resolution, manager and connectivity',
    'claude-gateway doctor [--url <url>] [--key <key>] [--config <path>] [--json]',
    [
      `  Exits 0 when every check passes. Rows marked ${c.dim('[--]')} are informational and ${c.yellow('[warn]')}`,
      '  rows are advisory — neither fails the command. The key itself is never printed.',
    ],
  );
}

export async function runDoctor(flags: Record<string, string | boolean>, config: CliConfigView): Promise<number> {
  if (flags.help === true) {
    printHelp();
    return 0;
  }
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

  // Resolved once and shared with the alt-address block below: both ask the
  // same question ("where does the gateway on this host listen?") and reading
  // the pidfile twice could answer it two different ways mid-command.
  const localUrl = resolveLocalUrl({ env: process.env, config });

  const manager = detectManager();
  // How the gateway on THIS host is supervised is a verdict only while this
  // host is what is being diagnosed. Pointed at another gateway (--url or
  // $CLAUDE_GATEWAY_URL), a laptop with no local install reports `unknown` and
  // used to fail the whole command even though config, key, url and health all
  // passed — the same false verdict this command already avoids for the
  // publicHealth row.
  const diagnosingThisHost = baseUrl === localUrl;
  checks.push({
    name: 'manager',
    ok: manager !== 'unknown',
    detail: diagnosingThisHost ? manager : `${manager} (local; not the target of this check)`,
    info: !diagnosingThisHost,
  });

  const health = await probeHealth(baseUrl);
  checks.push({ name: 'health', ok: health.ok, detail: health.detail });

  // #472: gateway.publicUrl backs every feature that hands out a public link
  // (generate_image reference edits, share_file, /cli). Nothing else in
  // `doctor` checks for its presence — the row below (`publicUrl`/`publicHealth`)
  // only exists when the value happens to be set, and stays silent otherwise.
  // Gated on `diagnosingThisHost` like `manager` above: this is this host's own
  // config file, so it is noise (and a config leak) when --url points elsewhere.
  if (diagnosingThisHost) {
    const gatewayPublicUrl = (config.publicUrl ?? '').trim().replace(/\/+$/, '');
    if (!gatewayPublicUrl) {
      checks.push({
        name: 'gatewayPublicUrl',
        ok: true,
        warn: true,
        detail: 'not set — generate_image reference edits, share_file, and /cli will not work (see README "gateway.publicUrl")',
      });
    } else if (/\$\{[^}]+\}/.test(gatewayPublicUrl)) {
      // `loadCliConfig` (http-client.ts) reads config.json directly and does not
      // interpolate ${VAR} placeholders like the gateway process's own loader
      // does — this CLI invocation may not even share that env. Probing the
      // literal placeholder string always fails, which would report a healthy,
      // correctly configured gateway as broken. Configured-but-unverifiable is
      // not a failure.
      checks.push({
        name: 'gatewayPublicUrl',
        ok: true,
        info: true,
        detail: `configured (${gatewayPublicUrl}) — contains an unresolved \${VAR}; reachability cannot be checked from the CLI`,
      });
    } else {
      const shareHealth = await probeHealth(gatewayPublicUrl);
      // `answered`, not `ok`: a proxy that answers 401/403 to an unauthenticated
      // probe is up and doing its job, not unreachable — same reasoning as the
      // publicHealth note below. Only "nothing answered at all" is a real fail.
      checks.push({
        name: 'gatewayPublicUrl',
        ok: shareHealth.answered,
        detail: shareHealth.answered ? `reachable (${gatewayPublicUrl})` : `unreachable: ${shareHealth.detail}`,
      });
    }
  }

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

  const allOk = checks.every((c) => c.info || c.warn || c.ok);
  const c = paletteFor(process.stderr);
  // Pad before colouring so escape codes never count toward the column width.
  const lines = checks.map((chk) => {
    // `warn`/`info` are checked first: an advisory row is marked distinctly
    // whether it passed or not, so the reader can tell the verdict rows from
    // the context.
    const mark = chk.warn ? c.yellow('[warn]') : chk.info ? c.dim('[--]') : chk.ok ? c.green('[ok]') : c.red('[!!]');
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
