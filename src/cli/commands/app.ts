import * as fs from 'fs';
import * as path from 'path';
import { unknownFlagNames, parseKeyValueList } from '../args';
import { parseDotenv } from '../../load-dotenv';
import { CliConfigView, expandHome, resolveUrlPlan, resolveReachableUrl, resolveKey, request, TransportError } from '../http-client';
import { printResult, writeCommandHelp } from '../output';
import { confirmAction } from '../prompt';
import { redactLine, redactLines } from '../redact';
import type { JobState } from '../../apps/installer';

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

/** Every flag `app` accepts, in any verb — the six every command takes plus
 *  `install`'s own. Anything else is a typo and is reported: this command
 *  builds its request body from named flags, so a dropped `--evn` would install
 *  an app with none of the environment the caller meant to give it, and exit 0.
 *  Same rule (and same reasoning) as `runResourceCommand` in ../index.ts. */
const APP_FLAG_NAMES: ReadonlySet<string> = new Set([
  'help',
  'json',
  'yes',
  'url',
  'key',
  'config',
  'version',
  'commit',
  'env',
  'env-file',
  'ports',
  'wait',
]);

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
/** A port as an operator writes one: decimal digits, nothing else. Deliberately
 *  stricter than `Number()`, which happily accepts `0x1F90`, `1e3`, `+8080` and
 *  ` 8080 ` — all integers by `Number.isInteger`, none of them a form the
 *  server, a compose file, or the person reading `docker ps` would recognise.
 *  `0x1F90` silently becoming 8080 is the worst of them: it binds a port the
 *  caller never named. Leading zeros are left to the server's range check. */
const PORT_RE = /^\d+$/;

/** `--env KEY=VALUE[,KEY=VALUE...]` → the `env_vars` object the install body
 *  expects. Shares its list parsing with `service --env` (see
 *  parseKeyValueList in ../args.ts); the systemd-only reserved-key check has
 *  no equivalent here — an app's reserved names are declared in its own
 *  app.yaml, not known to this command, so the server is the one place that
 *  can validate them. Returns null (message already on stderr) on malformed
 *  input. */
function parseEnvFlag(raw: string | boolean | undefined): Record<string, string> | null {
  const pairs = parseKeyValueList('env', raw, 'KEY=VALUE');
  if (pairs === null) return null;
  const out: Record<string, string> = {};
  for (const { key, value } of pairs) {
    if (!ENV_KEY_RE.test(key)) {
      process.stderr.write(`Invalid --env key "${key}" — must match [A-Za-z_][A-Za-z0-9_]*.\n`);
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** `--env-file <path>` → the same `env_vars` map `--env` builds, read from a
 *  dotenv file so a secret never has to appear in the command line at all.
 *  That matters here specifically: every value passed as `--env API_KEY=…` is
 *  visible to any local user in `/proc/<pid>/cmdline` for as long as the
 *  command runs, and is written verbatim into the caller's shell history.
 *  Same flag name and same purpose as `service install --env-file`, and the
 *  file is parsed by the shared `parseDotenv()` so an `.env` that works for
 *  the gateway works here too. Returns null (message already on stderr) when
 *  the file cannot be read or holds an invalid key. */
function parseEnvFileFlag(raw: string | boolean | undefined): Record<string, string> | null {
  if (raw === undefined) return {};
  if (typeof raw !== 'string' || raw.trim() === '') {
    // Distinct from "not passed": the schema-less parser hands over a flag
    // with nothing after it as boolean `true`, and reading that as "omitted"
    // would install the app with none of the secrets the caller meant to give.
    process.stderr.write('--env-file requires a path.\n');
    return null;
  }
  const file = path.resolve(expandHome(raw));
  let text: string;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    process.stderr.write(`Could not read --env-file ${file}: ${(err as Error).message}\n`);
    return null;
  }
  const out: Record<string, string> = {};
  for (const { key, value } of parseDotenv(text)) {
    if (!ENV_KEY_RE.test(key)) {
      // The key, never the value — this message goes to a terminal, and the
      // file it is describing is the one holding the secrets.
      process.stderr.write(`Invalid key "${key}" in ${file} — must match [A-Za-z_][A-Za-z0-9_]*.\n`);
      return null;
    }
    out[key] = value;
  }
  return out;
}

/** `--ports NAME=PORT[,NAME=PORT...]` → the `ports` host-port-override object.
 *  Only the shape (decimal port numbers) is checked here; the port-number
 *  floor/ban list and "is this a port the app declares" are enforced
 *  server-side (see parsePortsField in apps-router.ts), since this command has
 *  no access to the app's app.yaml to check port names against. */
function parsePortsFlag(raw: string | boolean | undefined): Record<string, number> | null {
  const pairs = parseKeyValueList('ports', raw, 'NAME=PORT');
  if (pairs === null) return null;
  const out: Record<string, number> = {};
  for (const { key, value } of pairs) {
    // Note this rejects an empty value too: `Number('')` is 0, not NaN, so a
    // bare "web=" (a typo dropping the port number) would otherwise become
    // port 0 — which the server rejects, but with a confusing "must be at
    // least 1024" instead of the malformed input it actually is.
    if (!PORT_RE.test(value.trim())) {
      process.stderr.write(`Invalid --ports value for "${key}" — "${value}" is not a decimal port number.\n`);
      return null;
    }
    out[key] = Number(value.trim());
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
 *   - `/...`, `./...`, `../...`, `~`, `~/...` → a local path (resolved to absolute —
 *                                             the API requires one)
 *   - anything else                         → a registry app name
 * This is a pure client-side convenience; the server still validates the value
 * makes sense for the mode it was sent in.
 *
 * A bare `~other-user/...` (not `~` or `~/`) deliberately falls through to the
 * registry-app case rather than being treated as local: `expandHome()` only
 * expands the current user's home, so resolving that form would silently
 * produce a bogus path with a literal `~other-user` path segment instead of
 * either the intended home directory or a clear error.
 */
export function parseInstallSource(source: string): InstallSourceBody {
  if (/^https?:\/\//i.test(source)) return { github_url: source };
  if (source.startsWith('/') || source.startsWith('./') || source.startsWith('../') || source === '~' || source.startsWith('~/')) {
    return { local_path: path.resolve(expandHome(source)) };
  }
  return { registry_app: source };
}

function strFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

/** The job as it goes to stdout: the same object, with its log lines redacted
 *  exactly like the copy streamed to stderr. `printResult(job)` serialises the
 *  whole `JobState`, `logs` included, so printing it raw would undo — in the
 *  same command — the redaction two lines above it. */
function redactedJob(job: JobState): JobState {
  return job.logs ? { ...job, logs: redactLines(job.logs) } : job;
}

/** Poll `GET /v1/apps/jobs/:jobId` until it settles, streaming new log lines
 *  to stderr as they appear (redacted defensively — see redact.ts — even
 *  though install logs are documented to name secrets, never their values).
 *  stdout gets exactly one JSON result, printed once the job is done, so
 *  `--json` output stays a single parseable value.
 *
 *  A single poll that fails to reach the gateway (a brief network blip, or
 *  the gateway momentarily busy building the very app being installed) is
 *  reported and retried rather than aborting the whole wait — the install job
 *  itself keeps running server-side regardless of whether this one poll could
 *  reach it, so throwing here would trade a transient hiccup for a spurious
 *  "it failed" when the job was fine. */
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
    let job: JobState;
    try {
      const result = await request({ method: 'GET', path: `/v1/apps/jobs/${encodeURIComponent(jobId)}`, baseUrl, key });
      job = result.data as JobState;
    } catch (err) {
      if (!(err instanceof TransportError)) {
        // The gateway answered with an error — most commonly 404 "Job not
        // found" if it restarted mid-install (job state is in-memory, see
        // AppInstaller.getJob in src/apps/installer.ts) or 401/403 if the key
        // was revoked. Retrying for up to 30 minutes would never help here,
        // unlike a transport failure below.
        process.stderr.write(`Could not poll job ${jobId}: ${(err as Error).message}\n`);
        return 1;
      }
      if (Date.now() >= deadline) {
        process.stderr.write(
          `Still waiting on job ${jobId}, and the last poll failed: ${(err as Error).message}\n` +
            `Check it with: claude-gateway api GET /v1/apps/jobs/${jobId}\n`,
        );
        return 1;
      }
      process.stderr.write(`Poll failed, retrying: ${(err as Error).message}\n`);
      await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_INTERVAL_MS));
      continue;
    }
    const logs = job.logs ?? [];
    for (; seenLogs < logs.length; seenLogs++) {
      process.stderr.write(redactLine(logs[seenLogs]) + '\n');
    }
    if (job.status === 'completed') {
      printResult(redactedJob(job), compact);
      return 0;
    }
    if (job.status === 'failed') {
      printResult(redactedJob(job), compact);
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

/** `install`'s request body, or null when the caller's own input was wrong
 *  (message already on stderr). Built before any network call so a bad flag is
 *  reported on its own — see the note in `runApp`. */
function buildInstallBody(source: string, flags: Record<string, string | boolean>): Record<string, unknown> | null {
  const sourceBody = parseInstallSource(source);
  const version = strFlag(flags.version);
  const commit = strFlag(flags.commit);
  if (version !== undefined && !sourceBody.registry_app) {
    process.stderr.write('--version only applies to a registry source (a plain app name).\n');
    return null;
  }
  if (commit !== undefined && !sourceBody.github_url) {
    process.stderr.write('--commit only applies to a GitHub source (an http(s):// URL).\n');
    return null;
  }
  const envVars = parseEnvFlag(flags.env);
  if (envVars === null) return null;
  const fileEnv = parseEnvFileFlag(flags['env-file']);
  if (fileEnv === null) return null;
  const portOverrides = parsePortsFlag(flags.ports);
  if (portOverrides === null) return null;

  // `--env` wins on a conflict: it is the more specific of the two, named
  // right here in the invocation, and it is how `docker run` resolves the same
  // overlap — so a one-off `--env PORT=…` overrides the checked-in file
  // without editing it.
  const env = { ...fileEnv, ...envVars };

  const body: Record<string, unknown> = { ...sourceBody };
  if (version !== undefined) body.version = version;
  if (commit !== undefined) body.commit = commit;
  if (Object.keys(env).length) body.env_vars = env;
  if (Object.keys(portOverrides).length) body.ports = portOverrides;
  return body;
}

export async function runApp(
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
  const unknown = unknownFlagNames(flags, APP_FLAG_NAMES);
  if (unknown.length) {
    process.stderr.write(`Unknown flag(s): ${unknown.map((f) => `--${f}`).join(' ')}\n\n`);
    printHelp(false);
    return 1;
  }

  // Everything wrong with the invocation itself is reported before the first
  // network call. `resolveReachableUrl()` probes /health and, when it falls
  // back, writes "Cannot reach the gateway at … using …" to stderr — printed
  // above the "Missing argument" that is the actual problem, that reads as a
  // connectivity failure for a command that was never going to make a request.
  const name = positionals[1];
  if (verb !== 'list' && !name) {
    process.stderr.write(`Missing argument: app ${verb} <${verb === 'install' ? 'source' : 'name'}>\n\n`);
    printHelp(false);
    return 1;
  }
  const installBody = verb === 'install' ? buildInstallBody(name, flags) : undefined;
  if (installBody === null) return 1;

  const baseUrl = await resolveReachableUrl(resolveUrlPlan({ flagUrl: strFlag(flags.url), env: process.env, config }));
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const compact = flags.json === true;

  if (verb === 'list') {
    const result = await request({ method: 'GET', path: '/v1/apps', baseUrl, key });
    printResult(result.data, compact);
    return 0;
  }

  if (verb === 'start' || verb === 'stop' || verb === 'restart') {
    const result = await request({ method: 'POST', path: `/v1/apps/${encodeURIComponent(name)}/${verb}`, baseUrl, key });
    printResult(result.data, compact);
    return 0;
  }

  if (verb === 'uninstall') {
    // No new implicit data deletion beyond what the API already does: this
    // removes the app's containers and installed files, but never its backups
    // (see DELETE /v1/apps/:name in apps-router.ts) — the confirmation prompt
    // says exactly that, not a vaguer "delete everything". Only `uninstall`
    // asks; start/stop/restart/install destroy nothing.
    if (!(await confirmAction(flags, 'uninstall', `Uninstall app "${name}"? This removes its containers and installed files (backups are kept).`))) {
      process.stderr.write('Aborted — the app was left in place.\n');
      return 1;
    }
    const result = await request({ method: 'DELETE', path: `/v1/apps/${encodeURIComponent(name)}`, baseUrl, key });
    printResult(result.data, compact);
    return 0;
  }

  // verb === 'install'
  const result = await request({ method: 'POST', path: '/v1/apps/install', baseUrl, key, body: installBody });
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
      'app install <source> [--version <v>] [--commit <sha>] [--env K=V,...] [--env-file <path>] [--ports NAME=PORT,...] [--wait]',
      'Install from the registry (plain name), a GitHub URL, or a local path (/, ./, ../, ~)',
    ],
  ];
  const width = Math.max(...rows.map(([usage]) => usage.length)) + 2;
  const lines = rows.map(([usage, desc]) => `  ${usage.padEnd(width)}${desc}`);
  lines.push(
    '',
    '  --env-file reads KEY=VALUE lines from a dotenv file, so secrets need not appear in the',
    '  command line (where /proc and shell history expose them); --env wins on a conflict.',
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
