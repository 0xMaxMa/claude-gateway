// Issue #559: the appended system prompt used to travel as ONE argv entry on
// every non-Windows host. Linux caps a single argument at MAX_ARG_STRLEN
// (128 KiB including the NUL), so a large prompt failed every spawn with E2BIG.
const spawned: { bin: string; args: string[]; promptFile?: { content: string; mode: number } }[] = [];
let spawnError: string | undefined;
jest.mock('child_process', () => {
  const real = jest.requireActual('child_process');
  const { EventEmitter } = jest.requireActual('events');
  const fs = jest.requireActual('fs');
  return {
    ...real,
    spawn: jest.fn((bin: string, args: string[]) => {
      if (spawnError) throw Object.assign(new Error(`spawn ${spawnError}`), { code: spawnError, errno: -7, syscall: 'spawn', spawnargs: args });
      const at = args.indexOf('--append-system-prompt-file');
      const file = at >= 0 ? args[at + 1] : undefined;
      // A host file is read now, the way the CLI reads it at startup.
      const promptFile = file && fs.existsSync(file) ? { content: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 } : undefined;
      spawned.push({ bin, args, promptFile });
      const proc = new EventEmitter();
      Object.assign(proc, { pid: 4242, stdin: { writable: true, write: jest.fn(), end: jest.fn(), on: jest.fn() }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(() => { setImmediate(() => proc.emit('exit', 0, 'SIGTERM')); return true; }) });
      return proc;
    }),
  };
});
// runtimeProfileArgs reads ~/.claude/settings.json; keep the host's file out of these tests.
let home: string | undefined;
jest.mock('os', () => {
  const real = jest.requireActual('os');
  return { ...real, homedir: () => home ?? real.homedir() };
});
const logged: { level: string; message: string; meta?: unknown }[] = [];
jest.mock('../../../src/logger', () => {
  const real = jest.requireActual('../../../src/logger');
  const record = (level: string) => (message: string, meta?: unknown) => { logged.push({ level, message, meta }); };
  return { ...real, createLogger: () => ({ debug: record('debug'), info: record('info'), warn: record('warn'), error: record('error') }) };
});
const containerWrites: { args: string[]; input: string }[] = [];
jest.mock('../../../src/orchestration/container', () => {
  const real = jest.requireActual('../../../src/orchestration/container');
  return {
    ...real,
    // The real one writes the prompt in the same docker exec as the ticket (see
    // container-system-prompt.test.ts); record what it was asked to write.
    prepareContainerProfile: jest.fn(async (_agent: unknown, _profile: unknown, systemPrompt?: (directory: string) => Promise<string | undefined>) => {
      const directory = '/tmp/gateway-orch-0f0f0f0f-0000-4000-8000-000000000000';
      containerWrites.push({ args: [directory + '/system-prompt.md'], input: (await systemPrompt?.(directory)) ?? '' });
      return { directory, config: directory + '/mcp.json' };
    }),
    stopContainerProfile: jest.fn(async () => true),
    containerNode: jest.fn(async (_container: string, script: string, args: string[] = [], input = '') => {
      if (script.includes('/workspace/CLAUDE.md')) return 'Container context';
      containerWrites.push({ args, input });
      return '';
    }),
  };
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionProcess } from '../../../src/session/process';
import { OrchestrationError } from '../../../src/orchestration/types';
import { responseFailureMessage } from '../../../src/orchestration/response-errors';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
import type { RuntimeProfile } from '../../../src/session/runtime-profile';

const MAX_ARG_STRLEN = 128 * 1024;
// ~200 KB of mostly Thai text: three UTF-8 bytes per character, so it crosses the
// per-argument limit with far fewer characters than ASCII would.
const CONTEXT = 'บริบทของเอเจนต์ '.repeat(4200) + 'end-of-context';
const OVERLAY = 'Overlay rules';
let root: string;
let workspace: string;

beforeEach(() => {
  spawned.length = 0; logged.length = 0; containerWrites.length = 0; spawnError = undefined;
  root = mkdtempSync(join(tmpdir(), 'prompt-file-'));
  workspace = join(root, 'workspace'); mkdirSync(workspace);
  home = root;
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: {} }));
});
afterEach(() => { home = undefined; rmSync(root, { recursive: true, force: true }); });

function session(type?: 'app-agent'): SessionProcess {
  const agent = { id: 'a', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] }, ...(type ? { type, container: 'app-test' } : {}) } as unknown as AgentConfig;
  const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
  const store = { getContextReset: () => undefined, loadSession: async () => [], loadTelegramSession: async () => [] } as any;
  const profile: RuntimeProfile = { role: 'agent', mcpConfigPath: join(root, 'mcp.json'), overlay: OVERLAY, ...(type ? {} : { context: CONTEXT }), capacityReserved: true } as RuntimeProfile;
  return new SessionProcess('session:1', 'api', agent, gateway, store, undefined, profile);
}

test('a 200 KB prompt on a POSIX host goes through a private 0600 file whose bytes equal the prompt', async () => {
  expect(Buffer.byteLength(`${CONTEXT}\n\n${OVERLAY}`)).toBeGreaterThan(MAX_ARG_STRLEN);
  const sp = session();
  await sp.start();
  const [{ args, promptFile }] = spawned;
  expect(args).not.toContain('--append-system-prompt');
  expect(args).toContain('--append-system-prompt-file');
  for (const arg of args) expect(Buffer.byteLength(arg) + 1).toBeLessThan(MAX_ARG_STRLEN);
  expect(promptFile?.content).toBe(`${CONTEXT}\n\n${OVERLAY}`);
  if (process.platform !== 'win32') expect(promptFile?.mode).toBe(0o600);
  const file = args[args.indexOf('--append-system-prompt-file') + 1];
  await sp.stop();
  expect(existsSync(file)).toBe(false);
});

test('a small prompt takes the same file path, so every host behaves alike', async () => {
  const sp = new SessionProcess('session:2', 'api', { id: 'a', workspace, claude: { model: 'm', extraFlags: [] } } as unknown as AgentConfig,
    { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [] } as unknown as GatewayConfig,
    { getContextReset: () => undefined, loadSession: async () => [] } as any, undefined,
    { role: 'agent', mcpConfigPath: join(root, 'mcp.json'), overlay: 'o', context: 'c', capacityReserved: true } as RuntimeProfile);
  await sp.start();
  expect(spawned[0].args).not.toContain('--append-system-prompt');
  expect(spawned[0].promptFile?.content).toBe('c\n\no');
  await sp.stop();
});

test('an app-agent prompt is written inside the container attempt directory over stdin and argv carries only that container path', async () => {
  const sp = session('app-agent');
  await sp.start();
  const [{ bin, args }] = spawned;
  expect(bin).toBe('docker');
  expect(args).not.toContain('--append-system-prompt');
  const file = args[args.indexOf('--append-system-prompt-file') + 1];
  expect(file).toBe('/tmp/gateway-orch-0f0f0f0f-0000-4000-8000-000000000000/system-prompt.md');
  const write = containerWrites.find(w => w.args.includes(file));
  expect(write?.input).toBe(`Container context\n\n${OVERLAY}`);
  // The prompt never touches the host or the argv of the docker CLI.
  for (const arg of args) expect(arg).not.toContain(OVERLAY);
  expect(existsSync(file)).toBe(false);
  await sp.stop();
});

test.each(['E2BIG', 'ENAMETOOLONG'])('a synchronous %s from spawn becomes PROCESS_ARGS_TOO_LARGE with a size-only log line', async code => {
  spawnError = code;
  const sp = session();
  const failure = await sp.start().then(() => undefined, (error: unknown) => error);
  expect(failure).toBeInstanceOf(OrchestrationError);
  expect(failure).toMatchObject({ code: 'PROCESS_ARGS_TOO_LARGE' });
  expect(responseFailureMessage(failure)).toMatch(/PROCESS_ARGS_TOO_LARGE/);
  expect(responseFailureMessage(failure)).not.toMatch(/GATEWAY_INTERNAL_ERROR/);
  const line = logged.find(entry => entry.level === 'error' && JSON.stringify(entry.meta ?? {}).includes(code));
  expect(line?.meta).toMatchObject({ code, argCount: expect.any(Number), largestArgBytes: expect.any(Number), totalArgBytes: expect.any(Number) });
  for (const entry of logged) expect(JSON.stringify(entry)).not.toContain('บริบทของเอเจนต์');
  await sp.stop();
});

test('any other synchronous spawn failure is logged before it propagates', async () => {
  spawnError = 'EINVAL';
  const sp = session();
  await expect(sp.start()).rejects.toMatchObject({ code: 'EINVAL' });
  expect(logged.some(entry => entry.level === 'error' && JSON.stringify(entry.meta ?? {}).includes('EINVAL'))).toBe(true);
  for (const entry of logged) expect(JSON.stringify(entry)).not.toContain('บริบทของเอเจนต์');
  await sp.stop();
});
