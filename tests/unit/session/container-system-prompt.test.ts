// An app-agent spawn with the REAL container scripts: every `docker exec ... node -e
// <script> ...` runs as `node -e <script> ...` on this host, so the attempt directory
// lands in this host's /tmp/gateway-orch-<uuid>. Only the CLI launch is faked.
let workspace = '';
let inspection: unknown;
const execs: { script: string; input: string }[] = [];
const launches: { args: string[]; prompt?: { content: string; mode: number } }[] = [];
let duringExec: ((script: string) => void) | undefined;
jest.mock('child_process', () => {
  const real = jest.requireActual('child_process');
  const { promisify } = jest.requireActual('util');
  const { EventEmitter } = jest.requireActual('events');
  const fs = jest.requireActual('fs');
  const execFile = jest.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async () => ({ stdout: JSON.stringify([inspection]), stderr: '' }) });
  const spawn = jest.fn((bin: string, args: string[], options: object) => {
    if (bin !== 'docker') return real.spawn(bin, args, options);
    const script = args.includes('node') ? args[args.indexOf('node') + 2] : '';
    // The CLI, under CONTAINER_SUPERVISOR or (wrongly) without one.
    if (!script || script.includes('GATEWAY_CONTAINER_ATTEMPT:dir')) {
      // The CLI launch: read the prompt now, the way the CLI reads it at startup.
      const at = args.indexOf('--append-system-prompt-file');
      const file = at >= 0 ? args[at + 1] : undefined;
      launches.push({ args, prompt: file && fs.existsSync(file) ? { content: fs.readFileSync(file, 'utf8'), mode: fs.statSync(file).mode & 0o777 } : undefined });
      const proc = new EventEmitter();
      Object.assign(proc, { pid: 4343, stdin: { writable: true, write: jest.fn(), end: jest.fn(), on: jest.fn() }, stdout: new EventEmitter(), stderr: new EventEmitter(), kill: jest.fn(() => { setImmediate(() => proc.emit('exit', 0, 'SIGTERM')); return true; }) });
      return proc;
    }
    const input: Buffer[] = [];
    const child = real.spawn(process.execPath, args.slice(args.indexOf('node') + 1).map((arg: string) => arg.replace('/workspace/CLAUDE.md', workspace + '/CLAUDE.md')), options);
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (data?: string | Buffer) => { if (data) input.push(Buffer.from(data)); execs.push({ script, input: Buffer.concat(input).toString('utf8') }); duringExec?.(script); return end(data); };
    return child;
  });
  return { ...real, execFile, spawn };
});
jest.mock('os', () => {
  const real = jest.requireActual('os');
  return { ...real, homedir: () => process.env.TEST_HOME ?? real.homedir() };
});

import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';
import type { RuntimeProfile } from '../../../src/session/runtime-profile';

// ~200 KB of Thai: three bytes per character, so the 64 KiB pipe chunks that carry the
// setup exec's stdin split characters, and a decode per chunk would corrupt the prompt.
const CONTEXT = 'บริบทของแอปเอเจนต์ '.repeat(3600) + 'end-of-context';
const OVERLAY = 'Overlay rules';
let root: string;
let before: Set<string>;
const attempts = () => readdirSync('/tmp').filter(name => name.startsWith('gateway-orch-') && !before.has(name)).map(name => '/tmp/' + name);

beforeEach(() => {
  execs.length = 0; launches.length = 0; duringExec = undefined;
  before = new Set(readdirSync('/tmp').filter(name => name.startsWith('gateway-orch-')));
  root = mkdtempSync(join(tmpdir(), 'container-prompt-'));
  process.env.TEST_HOME = root;
  workspace = join(root, 'workspace'); mkdirSync(workspace); mkdirSync(join(root, 'media'));
  writeFileSync(join(workspace, 'CLAUDE.md'), CONTEXT);
  writeFileSync(join(root, 'ticket.json'), JSON.stringify({ url: 'x', token: 'bridge-token', socket: join(workspace, 'bridge.sock'), tools: [] }));
  writeFileSync(join(root, 'mcp.json'), JSON.stringify({ mcpServers: { gateway: { env: { GATEWAY_ORCHESTRATION_TICKET_FILE: join(root, 'ticket.json') } } } }));
  inspection = { State: { Running: true }, HostConfig: { Privileged: false, NetworkMode: 'app_default', PidMode: '', IpcMode: 'private', CapDrop: ['ALL'], SecurityOpt: ['no-new-privileges'] }, Mounts: [{ Source: workspace, Destination: '/workspace', RW: true }] };
});
afterEach(() => {
  delete process.env.TEST_HOME;
  for (const directory of attempts()) rmSync(directory, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

function session(): SessionProcess {
  const agent = { id: 'a', type: 'app-agent', container: 'app-test', workspace, description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] } } as unknown as AgentConfig;
  const gateway = { gateway: { headless: true, timezone: 'UTC', logDir: join(root, 'logs') }, agents: [agent] } as GatewayConfig;
  const store = { getContextReset: () => undefined, loadSession: async () => [], loadTelegramSession: async () => [] } as any;
  return new SessionProcess('session:c', 'api', agent, gateway, store, undefined, { role: 'agent', mcpConfigPath: join(root, 'mcp.json'), overlay: OVERLAY, capacityReserved: true } as RuntimeProfile);
}

const posix = process.platform === 'win32' ? test.skip : test;

posix('the prompt is written by the docker exec that creates the attempt, so a spawn costs no extra exec', async () => {
  const sp = session();
  await sp.start();
  // One exec reads /workspace/CLAUDE.md; ONE more creates the attempt with its ticket, mcp.json and prompt.
  expect(execs).toHaveLength(2);
  const [read, setup] = execs;
  expect(read.script).toContain('/workspace/CLAUDE.md');
  expect(setup.script).toContain('ticket.json');
  expect(JSON.parse(setup.input).prompt).toBe(`${CONTEXT}\n\n${OVERLAY}`);
  const [{ args, prompt }] = launches;
  const file = args[args.indexOf('--append-system-prompt-file') + 1];
  expect(file).toMatch(/^\/tmp\/gateway-orch-[a-f0-9-]+\/system-prompt\.md$/);
  expect(prompt).toEqual({ content: `${CONTEXT}\n\n${OVERLAY}`, mode: 0o600 });
  for (const arg of args) expect(arg).not.toContain('บริบทของแอปเอเจนต์');
  await sp.stop();
  expect(existsSync(file)).toBe(false);
  expect(existsSync(file.replace('system-prompt.md', 'ticket.json'))).toBe(false);
});

posix.each([
  ['reading /workspace/CLAUDE.md', '/workspace/CLAUDE.md'],
  ['creating the attempt directory', 'ticket.json'],
])('a stop() while start() is %s starts no CLI and leaves no ticket or prompt in the container', async (_label, marker) => {
  const sp = session();
  let stopping: Promise<void> | undefined;
  duringExec = script => { if (script.includes(marker) && !stopping) stopping = sp.stop(); };
  await sp.start();
  await stopping;
  expect(stopping).toBeDefined();
  expect(launches).toHaveLength(0);
  expect(attempts()).toHaveLength(1);
  for (const directory of attempts()) {
    expect(existsSync(directory + '/ticket.json')).toBe(false);
    expect(existsSync(directory + '/system-prompt.md')).toBe(false);
  }
  expect(sp.isRunning()).toBe(false);
});
