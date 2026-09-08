import * as path from 'path';
import { CliConfigView, expandHome, resolveUrlPlan, resolveReachableUrl, resolveKey, request } from '../http-client';
import { printResult, writeCommandHelp } from '../output';
import { createRl, ask } from '../prompt';
import { redactLine } from '../redact';

/**
 * `app list|start|stop|restart|uninstall|install` — a thin CLI wrapper over the
 * existing `/v1/apps` REST API (src/api/apps-router.ts). This never talks to
 * Docker directly: every action is the same admin-gated HTTP call the
 * dashboard's App Store UI makes, so authorization and behavior can't drift
 * between the two clients.
 *
 * `install` is the one asynchronous action — the server returns a `jobId`
 * immediately (HTTP 202) and does the clone/build/start in the background.
 * Without `--wait` this command reports only that the job was accepted (never
 * "installed"); `--wait` polls `GET /v1/apps/jobs/:jobId` here and reports the
 * real outcome. Either way, `claude-gateway api GET /v1/apps/jobs/<jobId>` is
 * always available to check a job started elsewhere (e.g. --wait was skipped,
 * or the CLI was interrupted).
 */

const VERBS = ['list', 'start', 'stop', 'restart', 'uninstall', 'install'] as const;
type Verb = (typeof VERBS)[number];

function isVerb(v: string | undefined): v is Verb {
  return !!v && (VERBS as readonly string[]).includes(v);
}

/** How long `install --wait` polls before giving up and telling the caller to
 *  poll by hand — generous because a cold Docker build can legitimately take
 *  minutes (matches the installer's own default build budget, see
 *  AppRestoreConfig.buildTimeoutMs in src/apps/installer.ts). */
const WAIT_TIMEOUT_MS = 30 * 60 * 1000;
const WAIT_POLL_INTERVAL_MS = 1500;

const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** `--env KEY=VALUE[,KEY=VALUE...]` → the `env_vars` object the install/­
 *  reconfigure body expects. Mirrors `service.ts`'s `--env` parsing (same
 *  comma-separated shape) minus the systemd-only reserved-key check, which has
 *  no equivalent here — an app's reserved names are declared in its own
 *  `app.yaml`, not known to this command, so the server is the one place that
 *  can validate them. Returns null (message already on stderr) on malformed
 *  input. */
function parseEnvFlag(raw: string | boolean | undefined): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.trim() === '') {
    process.stderr.write('--env requires a comma-separated list of KEY=VALUE pairs.\n');
    return null;
  }
  const out: Record<string, string> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`Invalid --env entry "${trimmed}" — expected KEY=VALUE.\n`);
      return null;
    }
    const key = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    if (!ENV_KEY_RE.test(key)) {
      process.stderr.write(`Invalid --env key "${key}" — must match [A-Za-z_][A-Za-z0-9_]*.\n`);
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** `--ports NAME=PORT[,NAME=PORT...]` → the `ports` host-port-override object.
 *  Only the shape (integer values) is checked here; the port-number floor/ban
 *  list and "is this a port the app declares" are enforced server-side (see
 *  parsePortsField in apps-router.ts), since this command has no access to the
 *  app's app.yaml to check port names against. */
function parsePortsFlag(raw: string | boolean | undefined): Record<string, number> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.trim() === '') {
    process.stderr.write('--ports requires a comma-separated list of NAME=PORT pairs.\n');
    return null;
  }
  const out: Record<string, number> = {};
  for (const pair of raw.split(',')) {
    const trimmed = pair.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) {
      process.stderr.write(`Invalid --ports entry "${trimmed}" — expected NAME=PORT.\n`);
      return null;
    }
    const name = trimmed.slice(0, eq);
    const value = trimmed.slice(eq + 1);
    const port = Number(value);
    if (!Number.isInteger(port)) {
      process.stderr.write(`Invalid --ports value for "${name}" — "${value}" is not an integer.\n`);
      return null;
    }
    out[name] = port;
  }
  return out;
}

/** One of the three install-source body shapes the API accepts (see
 *  `POST /v1/apps/install` in API.md). Only one key is ever set. */
export interface InstallSourceBody {
  registry_app?: string;
  github_url?: string;
  local_path?: string;
}

/**
 * Classify a single `<source>` positional the same way an operator would read
 * it, so `app install` needs no separate `--registry-app`/`--github-url`/
 * `--local-path` flags for the common case:
 *   - `https://...` / `http://...`         → a GitHub URL (server validates the host)
 *   - starts with `/`, `./`, `../`, or `~`  → a local path (resolved to absolute —
 *                                             the API requires one)
 *   - anything else                         → a registry app name
 * This is a pure client-side convenience; the server still validates the value
 * makes sense for the mode it was sent in.
 */
export function parseInstallSource(source: string): InstallSourceBody {
  if (/^https?:\/\//i.test(source)) return { github_url: source };
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source.startsWith('~')) {
    return { local_path: path.resolve(expandHome(source)) };
  }
  return { registry_app: source };
}

function strFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** Same non-interactive-refusal convention as `service install|uninstall`
 *  (src/cli/commands/service.ts): `--yes` skips the prompt; a non-TTY stdin
 *  without it refuses rather than hanging forever, so this is safe in scripts
 *  and CI. Only `uninstall` uses this — start/stop/restart/install are not
 *  "delete this app's containers and installed files" actions. */
async function confirm(flags: Record<string, string | boolean>, question: string): Promise<boolean> {
  if (flags.yes === true) return true;
  if (!process.stdin.isTTY) {
    process.stderr.write('Refusing to uninstall non-interactively without --yes.\n');
    return false;
  }
  const rl = createRl();
  try {
    const answer = (await ask(rl, `${question} (y/N): `)).trim().toLowerCase();
    return answer === 'y' || answer === 'yes';
  } finally {
    rl.close();
  }
}

interface JobState {
  id: string;
  status: 'pending' | 'running' | 'completed' | 'failed';
  logs?: string[];
  error?: string;
  result?: unknown;
}

/** Poll `GET /v1/apps/jobs/:jobId` until it settles, streaming new log lines
 *  to stderr as they appear (redacted defensively — see redact.ts — even
 *  though install logs are documented to name secrets, never their values).
 *  stdout gets exactly one JSON result, printed once the job is done, so
 *  `--json` output stays a single parseable value. */
async function waitForJob(
  baseUrl: string,
  key: string | undefined,
  jobId: string,
  flags: Record<string, string | boolean>,
): Promise<number> {
  const compact = flags.json === true;
  const deadline = Date.now() + WAIT_TIMEOUT_MS;
  let seenLogs = 0;
  for (;;) {
    const result = await request({ method: 'GET', path: `/v1/apps/jobs/${encodeURIComponent(jobId)}`, baseUrl, key });
    const job = result.data as JobState;
    const logs = job.logs ?? [];
    for (; seenLogs < logs.length; seenLogs++) {
      process.stderr.write(redactLine(logs[seenLogs]) + '\n');
    }
    if (job.status === 'completed') {
      printResult(job, compact);
      return 0;
    }
    if (job.status === 'failed') {
      printResult(job, compact);
      process.stderr.write(`Install failed: ${job.error ?? 'unknown error'}\n`);
      return 1;
    }
    if (Date.now() >= deadline) {
      process.stderr.write(
        `Still ${job.status} after ${Math.round(WAIT_TIMEOUT_MS / 60000)}m — giving up waiting, but the job itself keeps running.\n` +
          `Check it with: claude-gateway api GET /v1/apps/jobs/${jobId}\n`,
      );
      return 1;
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
  }
}

export async function runApps(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb || flags.help === true) {
    // An explicit `--help` succeeds; a missing verb is a usage error.
    printHelp(flags.help === true);
    return flags.help === true ? 0 : 1;
  }
  if (!isVerb(verb)) {
    process.stderr.write(`Unknown: app ${verb} (expected ${VERBS.join('|')})\n\n`);
    printHelp(false);
    return 1;
  }

  const baseUrl = await resolveReachableUrl(resolveUrlPlan({ flagUrl: strFlag(flags.url), env: process.env, config }));
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const compact = flags.json === true;

  if (verb === 'list') {
    const result = await request({ method: 'GET', path: '/v1/apps', baseUrl, key });
    printResult(result.data, compact);
    return 0;
  }

  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    const name = positionals[1];
    if (!name) {
      process.stderr.write(`Missing argument: app ${verb} <name>\n\n`);
      printHelp(false);
      return 1;
    }
    const result = await request({ method: 'POST', path: `/v1/apps/${encodeURIComponent(name)}/${verb}`, baseUrl, key });
    printResult(result.data, compact);
    return 0;
  }

  if (verb === 'uninstall') {
    const name = positionals[1];
    if (!name) {
      process.stderr.write('Missing argument: app uninstall <name>\n\n');
      printHelp(false);
      return 1;
    }
    // No new implicit data deletion beyond what the API already does: this
    // removes the app's containers and installed files, but never its backups
    // (see DELETE /v1/apps/:name in apps-router.ts) — the confirmation prompt
    // says exactly that, not a vaguer "delete everything".
    if (!(await confirm(flags, `Uninstall app "${name}"? This removes its containers and installed files (backups are kept).`))) {
      process.stderr.write('Aborted — the app was left in place.\n');
      return 1;
    }
    const result = await request({ method: 'DELETE', path: `/v1/apps/${encodeURIComponent(name)}`, baseUrl, key });
    printResult(result.data, compact);
    return 0;
  }

  // verb === 'install'
  const source = positionals[1];
  if (!source) {
    process.stderr.write('Missing argument: app install <source>\n\n');
    printHelp(false);
    return 1;
  }
  const sourceBody = parseInstallSource(source);
  const version = strFlag(flags.version);
  const commit = strFlag(flags.commit);
  if (version !== undefined && !sourceBody.registry_app) {
    process.stderr.write('--version only applies to a registry source (a plain app name).\n');
    return 1;
  }
  if (commit !== undefined && !sourceBody.github_url) {
    process.stderr.write('--commit only applies to a GitHub source (an http(s):// URL).\n');
    return 1;
  }
  const envVars = parseEnvFlag(flags.env);
  if (envVars === null) return 1;
  const portOverrides = parsePortsFlag(flags.ports);
  if (portOverrides === null) return 1;

  const body: Record<string, unknown> = { ...sourceBody };
  if (version !== undefined) body.version = version;
  if (commit !== undefined) body.commit = commit;
  if (Object.keys(envVars).length) body.env_vars = envVars;
  if (Object.keys(portOverrides).length) body.ports = portOverrides;

  const result = await request({ method: 'POST', path: '/v1/apps/install', baseUrl, key, body });
  const jobId = (result.data as { jobId?: string } | undefined)?.jobId;
  if (flags.wait === true && jobId) {
    return await waitForJob(baseUrl, key, jobId, flags);
  }
  printResult(result.data, compact);
  // Accepted is not installed — the job runs in the background. Never claim
  // success here; only --wait (or a manual poll) reports the real outcome.
  if (jobId) {
    process.stderr.write(
      `Install accepted (job ${jobId}) — this does not mean it finished. Check it with:\n` +
        `  claude-gateway api GET /v1/apps/jobs/${jobId}\n` +
        `or re-run with --wait to follow it here.\n`,
    );
  }
  return 0;
}

function printHelp(requested: boolean): void {
  const rows: Array<[string, string]> = [
    ['app list', 'List installed apps and their status'],
    ['app start <name>', 'Start a stopped app'],
    ['app stop <name>', 'Stop a running app'],
    ['app restart <name>', 'Restart an app'],
    ['app uninstall <name> [--yes]', "Remove an app's containers and installed files (keeps backups)"],
    [
      'app install <source> [--version <v>] [--commit <sha>] [--env K=V,...] [--ports NAME=PORT,...] [--wait]',
      'Install from the registry (plain name), a GitHub URL, or a local path (/, ./, ../, ~)',
    ],
  ];
  const width = Math.max(...rows.map(([usage]) => usage.length)) + 2;
  const lines = rows.map(([usage, desc]) => `  ${usage.padEnd(width)}${desc}`);
  lines.push(
    '',
    '  <source> is classified by shape: an http(s):// URL is a GitHub source, a path starting',
    '  with /, ./, ../, or ~ is a local (symlinked) source, anything else is a registry app name.',
    '  install is asynchronous — it returns a jobId immediately (never reports "installed" on',
    '  its own). Poll it with `claude-gateway api GET /v1/apps/jobs/<jobId>`, or pass --wait to',
    '  have this command poll and report the real outcome.',
  );
  writeCommandHelp(
    requested,
    'app',
    'manage installed Docker-compose apps (wraps the /v1/apps REST API)',
    'claude-gateway app <list|start|stop|restart|uninstall|install> [args] [--flags]',
    lines,
  );
}
