import * as path from 'path';
import { parseCliArgs } from './args';
import { GENERATED_COMMANDS, GENERATED_NOUNS } from './commands.generated';
import { GeneratedCommand } from './types';
import { loadCliConfig, resolveUrl, resolveKey, request, CliConfigView } from './http-client';
import { runGatewayLifecycle } from './commands/gateway';
import { runDoctor } from './commands/doctor';
import { runDebugBundle } from './commands/debug-bundle';

/**
 * CLI entry point. Returns a process exit code. Never boots the server — the
 * boot entry (src/index.ts) only calls this when argv[2] is a CLI command.
 *
 * Convention: stdout carries the command's result (JSON); human-facing help and
 * errors go to stderr, so `--json` output is never polluted.
 */
export async function runCli(argv: string[]): Promise<number> {
  const [command, ...rest] = argv;
  const { positionals, flags } = parseCliArgs(rest);
  const wantHelp = flags.help === true;

  if (!command || command === 'help') {
    printGeneralHelp();
    return 0;
  }
  if (command === 'version' || command === '--version') {
    process.stdout.write(readVersion() + '\n');
    return 0;
  }

  const config = loadCliConfig(typeof flags.config === 'string' ? flags.config : undefined);

  try {
    switch (command) {
      case 'api':
        return await runApiPassthrough(positionals, flags, config);
      case 'gateway':
        return await runGatewayLifecycle(positionals, flags, config);
      case 'doctor':
        return await runDoctor(flags, config);
      case 'debug-bundle':
        return await runDebugBundle(flags);
      case 'logs':
        process.stderr.write('logs: not yet implemented — use `debug-bundle` for a shareable snapshot.\n');
        return 1;
    }

    // Resource nouns (generated).
    if (!GENERATED_NOUNS.includes(command)) {
      process.stderr.write(`Unknown command: ${command}\n\n`);
      printGeneralHelp();
      return 1;
    }
    return await runResourceCommand(command, positionals, flags, wantHelp, config);
  } catch (err) {
    process.stderr.write(`Error: ${(err as Error).message}\n`);
    return 1;
  }
}

async function runResourceCommand(
  noun: string,
  positionals: string[],
  flags: Record<string, string | boolean>,
  wantHelp: boolean,
  config: CliConfigView,
): Promise<number> {
  const verb = positionals[0];
  if (!verb || (wantHelp && !verb)) {
    printNounHelp(noun);
    return verb ? 0 : 1;
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
    try {
      body = JSON.parse(flags.data);
    } catch {
      process.stderr.write('Invalid --data: must be a JSON object.\n');
      return 1;
    }
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

  const baseUrl = resolveUrl({ flagUrl: strFlag(flags.url), env: process.env, config });
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const result = await request({
    method: cmd.method,
    path: apiPath,
    baseUrl,
    key,
    query,
    body: cmd.method === 'GET' ? undefined : body,
  });
  printResult(result.data);
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
  const baseUrl = resolveUrl({ flagUrl: strFlag(flags.url), env: process.env, config });
  const key = resolveKey({ flagKey: strFlag(flags.key), env: process.env, config });
  const result = await request({ method, path: apiPath, baseUrl, key, body });
  printResult(result.data);
  return 0;
}

// ─── helpers ──────────────────────────────────────────────────────────────────

function strFlag(v: string | boolean | undefined): string | undefined {
  return typeof v === 'string' ? v : undefined;
}

function printResult(data: unknown): void {
  process.stdout.write((typeof data === 'string' ? data : JSON.stringify(data, null, 2)) + '\n');
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

function printGeneralHelp(): void {
  const nouns = [...GENERATED_NOUNS].sort();
  const lines = [
    'claude-gateway — control a running gateway from the command line',
    '',
    'Usage: claude-gateway <command> [args] [--flags]',
    '  (running with no command boots the server, unchanged)',
    '',
    'Core commands:',
    '  gateway status|restart|stop   Manage the gateway process (manager-aware)',
    '  doctor                        Check config/env/connectivity',
    '  debug-bundle                  Write a small redacted diagnostics bundle',
    '  api <METHOD> <path>           Call any endpoint directly (escape hatch)',
    '  version                       Print the gateway version',
    '',
    `Resource commands: ${nouns.join(', ')}`,
    '  Run `claude-gateway <resource> --help` for its verbs.',
    '',
    'Global flags: --url <url>  --key <key>  --json  --data <json>  --help',
  ];
  process.stderr.write(lines.join('\n') + '\n');
}

function printNounHelp(noun: string): void {
  const cmds = GENERATED_COMMANDS.filter((c) => c.noun === noun);
  const lines = [`claude-gateway ${noun} — commands:`, ''];
  for (const c of cmds) lines.push(`  ${usageFor(c).padEnd(48)} ${c.summary}`);
  process.stderr.write(lines.join('\n') + '\n');
}

function printCommandHelp(c: GeneratedCommand): void {
  const lines = [
    `claude-gateway ${usageFor(c)}`,
    '',
    `  ${c.summary}`,
    `  ${c.method} ${c.path}  (auth: ${c.auth})`,
  ];
  if (c.flags.length) {
    lines.push('', '  Flags:');
    for (const f of c.flags) {
      lines.push(`    --${f.name.padEnd(16)} ${f.in}${f.required ? ' (required)' : ''}  ${f.description ?? ''}`.trimEnd());
    }
  }
  process.stderr.write(lines.join('\n') + '\n');
}
