// Issue #559: the appended system prompt used to travel as ONE argv entry on
// every non-Windows host. Linux caps a single argument at MAX_ARG_STRLEN
// (128 KiB including the NUL), so a large prompt failed every spawn with E2BIG.
const spawned: { bin: string; args: string[]; promptFile?: { content: string; mode: number }; proc: import('events').EventEmitter }[] = [];
let spawnError: string | undefined;
// While set, SIGTERM does not end the fake CLI: the test emits its 'exit' itself.
let holdExit = false;
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
      const proc = new EventEmitter();
      Object.assign(proc, { pid: 4242 + spawned.length, stdin: { writable: true, write: jest.fn(), end: jest.fn(), on: jest.fn() }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(() => { if (!holdExit) setImmediate(() => proc.emit('exit', 0, 'SIGTERM')); return true; }) });
      spawned.push({ bin, args, promptFile, proc });
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
// Connectors resolved for the next spawn, one fixed-name file per entry (connector-<i>.json).
let connectors: Record<string, unknown> = {};
jest.mock('../../../src/connectors/resolve', () => ({
  ...jest.requireActual('../../../src/connectors/resolve'),
  resolveEnabledConnectors: () => connectors,
}));
// A worker's fake child must not become a managed process group: stopping one signals its pgid.
// A test that needs one sets `supervised`; the group stop is then a fake the test can hold open.
let supervised = false;
let groupStop: (group: number) => Promise<boolean> = async () => true;
jest.mock('../../../src/orchestration/process-supervisor', () => ({
  ...jest.requireActual('../../../src/orchestration/process-supervisor'),
  processSupervisorSupported: () => supervised,
  recordProcessRoot: () => {},
  stopProcessGroup: jest.fn((group: number) => groupStop(group)),
}));
let containerStop: (directory: string) => Promise<boolean> = async () => true;
let attempts = 0;
const containerWrites: { args: string[]; input: string }[] = [];
jest.mock('../../../src/orchestration/container', () => {
  const real = jest.requireActual('../../../src/orchestration/container');
  return {
    ...real,
    // The real one writes the prompt in the same docker exec as the ticket (see
    // container-system-prompt.test.ts); record what it was asked to write.
    prepareContainerProfile: jest.fn(async (_agent: unknown, _profile: unknown, systemPrompt?: (directory: string) => Promise<string | undefined>) => {
      const directory = '/tmp/gateway-orch-0f0f0f0f-0000-4000-8000-' + String(attempts++).padStart(12, '0');
      containerWrites.push({ args: [directory + '/system-prompt.md'], input: (await systemPrompt?.(directory)) ?? '' });
      return { directory, config: directory + '/mcp.json' };
    }),
    stopContainerProfile: jest.fn((_container: string, directory: string) => containerStop(directory)),
    containerNode: jest.fn(async (_container: string, script: string, args: string[] = [], input = '') => {
      if (script.includes('/workspace/CLAUDE.md')) return 'Container context';
      containerWrites.push({ args, input });
      return '';
    }),
  };
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionProcess } from '../../../src/session/process';
import { OrchestrationError } from '../../../src/orchestration/types';
import { stopContainerProfile } from '../../../src/orchestration/container';
import { stopProcessGroup } from '../../../src/orchestration/process-supervisor';
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
  spawned.length = 0; logged.length = 0; containerWrites.length = 0; spawnError = undefined; holdExit = false; connectors = {};
  supervised = false; groupStop = async () => true; containerStop = async () => true; attempts = 0;
  jest.mocked(stopProcessGroup).mockClear(); jest.mocked(stopContainerProfile).mockClear();
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

const promptFiles = () => readdirSync(root).filter(name => name.startsWith('system-prompt-'));

test('a stop() while start() is still preparing abandons the spawn: no CLI and no prompt file are left behind', async () => {
  const sp = session();
  let release!: () => void;
  const real = (sp as any).buildInitialPrompt.bind(sp);
  jest.spyOn(sp as any, 'buildInitialPrompt').mockImplementation(() => new Promise(resolve => { release = () => resolve(real()); }));
  const starting = sp.start();
  await sp.stop();
  release();
  await starting;
  expect(spawned).toHaveLength(0);
  expect(promptFiles()).toEqual([]);
  expect(sp.isRunning()).toBe(false);
});

test('a respawn while an earlier stop() still waits for its exit keeps its own prompt file and child', async () => {
  const sp = session();
  await sp.start();
  holdExit = true;
  const stopping = sp.stop();
  await sp.start();
  expect(spawned).toHaveLength(2);
  const file = (n: number) => spawned[n].args[spawned[n].args.indexOf('--append-system-prompt-file') + 1];
  expect(file(1)).not.toBe(file(0));
  spawned[0].proc.emit('exit', 0, 'SIGTERM');
  await stopping;
  // The first stop removed only the first spawn's prompt; the second child is still this session's.
  expect(existsSync(file(0))).toBe(false);
  expect(existsSync(file(1))).toBe(true);
  expect(sp.isRunning()).toBe(true);
  holdExit = false;
  await sp.stop();
  expect(existsSync(file(1))).toBe(false);
});

test('a respawn while an earlier stop() still waits for its exit keeps the connector files and MCP config it rewrote', async () => {
  const agent = { id: 'a', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] } } as unknown as AgentConfig;
  const sp = new SessionProcess('session:1', 'api', agent,
    { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig,
    { getContextReset: () => undefined, loadSession: async () => [] } as any, undefined,
    { role: 'worker', hostExecution: true, mcpConfigPath: join(root, 'mcp.json'), overlay: OVERLAY, context: 'c', capacityReserved: true } as RuntimeProfile);
  const files = () => readdirSync(root).filter(name => name.startsWith('connector-') || name === 'managed-connectors.json').sort();
  connectors = { alpha: { command: 'alpha' }, beta: { command: 'beta' } };
  await sp.start();
  expect(files()).toEqual(['connector-0.json', 'connector-1.json', 'managed-connectors.json']);
  holdExit = true;
  const stopping = sp.stop();
  connectors = { alpha: { command: 'alpha' } };
  await sp.start();
  spawned[0].proc.emit('exit', 0, 'SIGTERM');
  await stopping;
  // The first stop removed only what the second spawn did not write again.
  expect(files()).toEqual(['connector-0.json', 'managed-connectors.json']);
  expect(sp.isRunning()).toBe(true);
  holdExit = false;
  await sp.stop();
  expect(files()).toEqual([]);
});

test('a respawn while an earlier stop() still waits for its exit keeps the session directory holding its mcp-config.json', async () => {
  const agent = { id: 'a', workspace, description: 'fixture', env: '', allow_tools: true, claude: { model: 'fixture', extraFlags: [] } } as unknown as AgentConfig;
  const sp = new SessionProcess('session-dir', 'api', agent,
    { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig,
    { getContextReset: () => undefined, loadSession: async () => [] } as any);
  const config = join(workspace, '.sessions', 'session-dir', 'mcp-config.json');
  await sp.start();
  expect(existsSync(config)).toBe(true);
  holdExit = true;
  const stopping = sp.stop();
  await sp.start();
  spawned[0].proc.emit('exit', 0, 'SIGTERM');
  await stopping;
  expect(existsSync(config)).toBe(true);
  holdExit = false;
  await sp.stop();
  expect(existsSync(join(workspace, '.sessions', 'session-dir'))).toBe(false);
});

// Respawn while an earlier stop() is still awaiting: the stale stop and the turn that
// called it act only on the spawn they stopped, never on the one that replaced it.
const held = () => { let release!: (value: boolean) => void; const promise = new Promise<boolean>(resolve => { release = resolve; }); return { promise, release }; };
const tick = () => new Promise(resolve => setTimeout(resolve, 20));
function worker(type?: 'app-agent'): SessionProcess {
  const agent = { id: 'a', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] }, ...(type ? { type, container: 'app-test' } : {}) } as unknown as AgentConfig;
  return new SessionProcess('session:w', 'api', agent,
    { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig,
    { getContextReset: () => undefined, loadSession: async () => [] } as any, undefined,
    { role: 'worker', mcpConfigPath: join(root, 'mcp.json'), overlay: OVERLAY, ...(type ? {} : { hostExecution: true, context: 'c' }), capacityReserved: true } as RuntimeProfile);
}

test('a stale stop() signals only the child it stopped, not the one a respawn attached during its group stop', async () => {
  supervised = true;
  const sp = worker();
  await sp.start();
  const group = held();
  groupStop = () => group.promise;
  holdExit = true;
  const stopping = sp.stop();
  await sp.start();
  const [{ proc: first }, { proc: second }] = spawned as { proc: any }[];
  group.release(true);
  await tick();
  expect(first.kill).toHaveBeenCalledWith('SIGTERM');
  expect(second.kill).not.toHaveBeenCalled();
  expect((sp as any).managedProcessGroup).toBe(second.pid);
  first.emit('exit', 0, 'SIGTERM');
  await stopping;
  expect(sp.isRunning()).toBe(true);
  groupStop = async () => true;
  holdExit = false;
  await sp.stop();
  expect(jest.mocked(stopProcessGroup).mock.calls.map(([pid]) => pid)).toEqual([first.pid, second.pid]);
});

test('a stale stop() neither clears nor orphans the container attempt a respawn attached during its container stop', async () => {
  const sp = worker('app-agent');
  await sp.start();
  const container = held();
  containerStop = () => container.promise;
  holdExit = true;
  const stopping = sp.stop();
  spawned[0].proc.emit('exit', 0, 'SIGTERM');
  await sp.start();
  const directory = (n: number) => '/tmp/gateway-orch-0f0f0f0f-0000-4000-8000-' + String(n).padStart(12, '0');
  expect((sp as any).containerAttempt?.directory).toBe(directory(1));
  container.release(true);
  await tick();
  expect((sp as any).containerAttempt?.directory).toBe(directory(1));
  expect((spawned[1].proc as any).kill).not.toHaveBeenCalled();
  await stopping;
  expect(sp.isRunning()).toBe(true);
  containerStop = async () => true;
  holdExit = false;
  await sp.stop();
  expect(jest.mocked(stopContainerProfile).mock.calls.map(([, dir]) => dir)).toEqual([directory(0), directory(1)]);
});
