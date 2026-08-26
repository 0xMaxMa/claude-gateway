import * as path from 'path';
import { parseCliArgs } from './args';
import { GENERATED_COMMANDS, GENERATED_NOUNS } from './commands.generated';
import { GeneratedCommand } from './types';
import { loadCliConfig, resolveUrlPlan, resolveKey, request, CliConfigView } from './http-client';
import { printResult } from './output';
import { paletteFor, Paint } from './colors';
import { runGatewayLifecycle } from './commands/gateway';
import { runService } from './commands/service';
import { runUpdate, runClaude } from './commands/update';
import { runDoctor } from './commands/doctor';
import { runDebugBundle } from './commands/debug-bundle';
import { runAgents } from './commands/agents';
import { runChannels } from './commands/channels';

/** Flags that are always boolean regardless of command — never consume the next
 *  token as a value (see parseCliArgs). */
const GLOBAL_BOOLEAN_FLAGS = new Set(['help', 'json', 'yes', 'print']);
const HELP_ALIASES = new Set(['help', '--help', '-h']);
const VERSION_ALIASES = new Set(['version', '--version', '-V']);

/**
 * CLI entry point. Returns a process exit code. Never boots the server — the
 * boot entry (src/index.ts) only calls this when argv[2] is a CLI command.
 *
 * Convention: stdout carries the command's result (JSON, pretty by default or
 * compact with `--json`); human-facing help and errors go to stderr, so result
 * output is never polluted.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseCliArgs(rest, GLOBAL_BOOLEAN_FLAGS);
  const wantHelp = flags.help === true;

  if (!command || HELP_ALIASES.has(command)) {
    printGeneralHelp();
    return 0;
  }
  if (VERSION_ALIASES.has(command)) {
    process.stdout.write(readVersion() + '\n');
    return 0;
  }
  // Flags with no command (`claude-gateway --config /etc/cg.json`) — the shape
  // old service units used. There is nothing to run, so this is the same
  // "here's what I can do" answer as a bare invocation, never a server boot.
  if (command.startsWith('-')) {
    printGeneralHelp();
    return 0;
  }

  const config = loadCliConfig(typeof flags.config === 'string' ? flags.config : undefined);

  try {
    switch (command) {
      case 'api':
        return await runApiPassthrough(positionals, flags, config);
      case 'gateway':
        return await runGatewayLifecycle(positionals, flags, config);
      case 'service':
        return await runService(positionals, flags, config);
      case 'update':
        return await runUpdate('claude-gateway', positionals, flags);
      case 'claude':
        return await runClaude(positionals, flags);
      case 'doctor':
        return await runDoctor(flags, config);
      case 'debug-bundle':
        return await runDebugBundle(flags);
      case 'agents':
        return await runAgents(positionals, flags, config);
      case 'channels':
        return await runChannels(positionals, flags, config);
    }

    // Resource nouns (generated).
    if (!GENERATED_NOUNS.includes(command)) {
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printGeneralHelp();
      return 1;
    }
    return await runResourceCommand(command, rest, wantHelp, config);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runResourceCommand(
  noun: string,
  rest: string[],
  wantHelp: boolean,
  config: CliConfigView,
): Promise<number> {
  // First pass just to find the verb — a plain positional, so it parses the
  // same regardless of which flags turn out to be boolean for this command.
  const verb = parseCliArgs(rest, GLOBAL_BOOLEAN_FLAGS).positionals[0];
  if (!verb) {
    // `crons --help` is a help request (exit 0); a bare `crons` is a usage
    // error (exit 1) even though both print the same listing.
    printNounHelp(noun);
    return wantHelp ? 0 : 1;
  }
  const cmd = GENERATED_COMMANDS.find((c) => c.noun === noun && c.verb === verb);
  if (!cmd) {
    process.stderr.write(`Unknown command: ${noun} ${verb}\n\n`);
    printNounHelp(noun);
    return 1;
  }
  if (wantHelp) {
    printCommandHelp(cmd);
    return 0;
  }

  // Re-parse now that the command's own boolean flags (e.g. `--force`) are
  // known, so one placed right before a positional doesn't swallow it.
  const booleanFlags = new Set([...GLOBAL_BOOLEAN_FLAGS, ...cmd.flags.filter((f) => f.boolean).map((f) => f.name)]);
  const { positionals, flags } = parseCliArgs(rest, booleanFlags);
  const restPositionals = positionals.slice(1);
  // Positional path args
  if (restPositionals.length < cmd.args.length) {
    const missing = cmd.args.slice(restPositionals.length).map((a) => `<${a}>`).join(' ');
    process.stderr.write(`Missing argument(s): ${missing}\n\n`);
    printCommandHelp(cmd);
    return 1;
  }
  let apiPath = cmd.path;
  cmd.args.forEach((argName, idx) => {
    apiPath = apiPath.replace(`:${argName}`, encodeURIComponent(restPositionals[idx]));
  });

  // Flags → query / body
  const query: Record<string, string | undefined> = {};
  let body: Record<string, unknown> | undefined;
  if (typeof flags.data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(flags.data);
    } catch {
      process.stderr.write('Invalid --data: must be a JSON object.\n');
      return 1;
    }
    // `JSON.parse` also accepts primitives and arrays. Merging flags into one
    // of those throws further down (`'name' in 5`), surfacing a TypeError
    // instead of the message above.
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      process.stderr.write('Invalid --data: must be a JSON object.\n');
      return 1;
    }
    body = parsed as Record<string, unknown>;
  }
  const missingRequired: string[] = [];
  for (const f of cmd.flags) {
    const val = flags[f.name];
    if (val === undefined) {
      if (f.required && !(body && f.name in body)) missingRequired.push(`--${f.name}`);
      continue;
    }
    if (f.in === 'query') {
      query[f.name] = String(val);
    } else {
      body = body ?? {};
      body[f.name] = f.boolean ? val === true || val === 'true' : val;
    }
  }
  if (missingRequired.length) {
    process.stderr.write(`Missing required flag(s): ${missingRequired.join(' ')}\n\n`);
    printCommandHelp(cmd);
    return 1;
  }

  const { baseUrl, fallbackUrl } = resolveUrlPlan({ flagUrl: strFlag(flags.url), env: process.env, config });
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const result = await request({
    method: cmd.method,
    path: apiPath,
    baseUrl,
    fallbackBaseUrl: fallbackUrl,
    key,
    query,
    body: cmd.method === 'GET' ? undefined : body,
  });
  printResult(result.data, flags.json === true);
  return 0;
}

async function runApiPassthrough(
  positionals: string[],
  flags: Record<string, string | boolean>,
  config: CliConfigView,
): Promise<number> {
  const method = (positionals[0] || '').toUpperCase();
  const apiPath = positionals[1];
  if (!method || !apiPath) {
    process.stderr.write('Usage: claude-gateway api <METHOD> <path> [--data <json>] [--query k=v]\n');
    return 1;
  }
  if (!apiPath.startsWith('/')) {
    process.stderr.write('Path must start with "/" (e.g. /v1/agents)\n');
    return 1;
  }
  let body: unknown;
  if (typeof flags.data === 'string') {
    try {
      body = JSON.parse(flags.data);
    } catch {
      process.stderr.write('Invalid --data: must be valid JSON.\n');
      return 1;
    }
  }
  const { baseUrl, fallbackUrl } = resolveUrlPlan({ flagUrl: strFlag(flags.url), env: process.env, config });
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const result = await request({ method, path: apiPath, baseUrl, fallbackBaseUrl: fallbackUrl, key, body });
  printResult(result.data, flags.json === true);
  return 0;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function strFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function readVersion(): string {
  try {
    // dist/cli/index.js → package.json at the package root
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return (require(path.join(__dirname, '..', '..', 'package.json')) as { version: string }).version;
  } catch {
    return 'unknown';
  }
}

function usageFor(c: GeneratedCommand): string {
  const positionals = c.args.map((a) => `<${a}>`).join(' ');
  const flagStr = c.flags
    .map((f) => (f.boolean ? `[--${f.name}]` : f.required ? `--${f.name} <v>` : `[--${f.name} <v>]`))
    .join(' ');
  return `${c.noun} ${c.verb}${positionals ? ' ' + positionals : ''}${flagStr ? ' ' + flagStr : ''}`.trim();
}

/** Two-column rows in the general help. The name column is padded to
 *  NAME_W; a name wider than that puts its description on the next line.
 *  Wide enough for the longest name (`service install|status|uninstall`, 32)
 *  plus a readable gap, so no core command wraps. Exported for the test that
 *  holds this table and the dispatcher to the same set of commands. */
export const NAME_W = 36;

/** Usage strings in a resource noun's help (`crons list --limit <v>`) run much
 *  longer than a core command name, so that listing gets its own width. */
export const NOUN_NAME_W = 48;

export const CORE_HELP: ReadonlyArray<readonly [string, string]> = [
  ['gateway status|restart|stop', 'Manage the gateway process (manager-aware)'],
  ['service install|status|uninstall', 'Run the gateway as a systemd-user or PM2 service'],
  ['update [check]', 'Check for / install a newer claude-gateway'],
  ['claude version|update [check]', 'Inspect / update the Claude Code binary'],
  ['doctor', 'Check config/env/connectivity'],
  ['debug-bundle', 'Write a small redacted diagnostics bundle'],
  ['agents list|create|update', 'Create/manage agents (interactive wizard)'],
  ['channels pending|approve|deny', 'Approve/deny incoming Telegram/Discord pairing requests'],
  ['api <METHOD> <path>', 'Call any endpoint directly (escape hatch)'],
  ['version', 'Print the gateway version'],
];

/** Render one `  name   description` row, padding before colouring so ANSI
 *  escapes never count toward the column width. A name at or past `width` puts
 *  its description on the next line, aligned with the others, rather than
 *  pushing it out of the column — which is what the two-line form is for.
 *  Shared by every help listing so they cannot drift apart. */
export function helpRow(name: string, desc: string, paint: Paint, width = NAME_W): string[] {
  if (name.length >= width) return [`  ${paint(name)}`, `  ${' '.repeat(width)}${desc}`];
  return [`  ${paint(name.padEnd(width))}${desc}`];
}

function printGeneralHelp(): void {
  const nouns = [...GENERATED_NOUNS].sort();
  const c = paletteFor(process.stderr);
  // readVersion() falls back to 'unknown'; render that as a plain banner rather than "vunknown".
  const version = readVersion();
  // The brand tone is reserved for this banner — the one place the program
  // introduces itself. Elsewhere the name is just bold, so colour stays a
  // signal rather than decoration.
  const name = c.brand('claude-gateway');
  const banner =
    version === 'unknown'
      ? `${name} — control a running gateway from the command line`
      : `${name} ${c.dim(`v${version}`)} — control a running gateway from the command line`;
  const lines = [
    banner,
    '',
    `${c.bold('Usage:')} claude-gateway <command> [args] [--flags]`,
    '',
    c.bold('Start the gateway in the foreground:'),
    ...helpRow('gateway start', 'Start the gateway server (the only command that boots it)', c.green),
    '',
    c.bold('Core commands:'),
    ...CORE_HELP.flatMap(([n, d]) => helpRow(n, d, c.cyan)),
    '',
    `${c.bold('Resource commands:')} ${nouns.map((n) => c.cyan(n)).join(', ')}`,
    `  Run \`claude-gateway <resource> --help\` for its verbs.`,
    '',
    `${c.bold('Global flags:')} --url <url>  --key <key>  --json (compact/minified output)  --data <json>  --help`,
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

function printNounHelp(noun: string): void {
  const cmds = GENERATED_COMMANDS.filter((c) => c.noun === noun);
  const p = paletteFor(process.stderr);
  const lines = [`${p.bold('claude-gateway')} ${p.cyan(noun)} — commands:`, ''];
  for (const c of cmds) lines.push(...helpRow(usageFor(c), c.summary, p.cyan, NOUN_NAME_W));
  process.stderr.write(lines.join('\n') + '\n');
}

function printCommandHelp(c: GeneratedCommand): void {
  const p = paletteFor(process.stderr);
  const lines = [
    `${p.bold('claude-gateway')} ${p.cyan(usageFor(c))}`,
    '',
    `  ${c.summary}`,
    `  ${p.dim(`${c.method} ${c.path}  (auth: ${c.auth})`)}`,
  ];
  if (c.flags.length) {
    lines.push('', `  ${p.bold('Flags:')}`);
    for (const f of c.flags) {
      lines.push(`    --${f.name.padEnd(16)} ${f.in}${f.required ? ' (required)' : ''}  ${f.description ?? ''}`.trimEnd());
    }
  }
  process.stderr.write(lines.join('\n') + '\n');
}
