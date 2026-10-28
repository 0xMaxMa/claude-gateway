/**
 * SandboxPool lifecycle (#609) against a fake docker CLI: a sandbox a session holds
 * is never reaped or replaced, and the app's environment never reaches the argv.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type Call = { args: string[]; env?: NodeJS.ProcessEnv; envFile?: string };
const calls: Call[] = [];
const containers = new Map<string, any>();
let base: any;

jest.mock('child_process', () => {
  const real = jest.requireActual('child_process');
  const { promisify } = jest.requireActual('util');
  const execFile = jest.fn();
  Object.defineProperty(execFile, promisify.custom, { value: async (_bin: string, args: string[], options: { env?: NodeJS.ProcessEnv }) => {
    const at = args.indexOf('--env-file');
    calls.push({ args, env: options?.env, envFile: at >= 0 ? jest.requireActual('fs').readFileSync(args[at + 1], 'utf8') : undefined });
    const [verb] = args;
    if (verb === 'inspect') {
      const name = args[args.length - 1];
      const found = name === base.Name.slice(1) ? base : containers.get(name);
      if (!found) throw Object.assign(new Error('missing'), { stderr: `Error: No such container: ${name}` });
      return { stdout: JSON.stringify([found]), stderr: '' };
    }
    if (verb === 'create') {
      const name = args[args.indexOf('--name') + 1];
      const labels = Object.fromEntries(args.flatMap((a, i) => args[i - 1] === '--label' ? [a.split('=')] : []).map(([k, ...v]) => [k, v.join('=')]));
      containers.set(name, { Name: '/' + name, State: { Running: false }, Config: { Labels: labels } });
    }
    if (verb === 'start') containers.get(args[1])!.State.Running = true;
    if (verb === 'rm') for (const name of args.slice(2)) containers.delete(name);
    if (verb === 'ps') return { stdout: [...containers.keys()].join('\n'), stderr: '' };
    return { stdout: '', stderr: '' };
  } });
  return { ...real, execFile };
});

import { SandboxPool, sandboxContainerName } from '../../src/apps/conversation-sandbox';
import type { AgentConfig } from '../../src/types';

let root: string;
let agent: AgentConfig;
const A = { source: 'telegram', chatId: '111' };
const verbs = () => calls.map(c => c.args[0]);
let clock = Date.now();
/** Moves past the pool's few-second convergence cache. */
const later = () => { clock += 6_000; };
jest.spyOn(Date, 'now').mockImplementation(() => clock);

beforeEach(() => {
  calls.length = 0; containers.clear();
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sandbox-pool-')));
  fs.mkdirSync(path.join(root, 'agents', 'bot'), { recursive: true });
  fs.mkdirSync(path.join(root, 'ws'));
  fs.writeFileSync(path.join(root, 'ws', 'CLAUDE.md'), 'composed');
  fs.symlinkSync(path.join(root, 'ws'), path.join(root, 'agents', 'bot', 'workspace'));
  agent = { id: 'bot', description: 'test', type: 'app-agent', container: 'demo-agent', isolateMemory: true, workspace: path.join(root, 'agents', 'bot', 'workspace'), env: '', claude: { model: 'm', dangerouslySkipPermissions: false, extraFlags: [] } };
  base = {
    Name: '/demo-agent', Image: 'sha256:abc', State: { Running: true },
    Config: { User: '1000:1000', Env: ['APP_TOKEN=s3cret', 'PATH=/app/bin', 'MULTI=a\nb'], Cmd: ['sh', '-c', 'exec sleep infinity'], Labels: {} },
    HostConfig: {}, NetworkSettings: { Networks: { demo_default: {} } }, Mounts: [],
  };
});

afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

it('creates the sandbox with the app environment in a private env file, never on the argv or in the docker CLI environment', async () => {
  const pool = new SandboxPool();
  expect(await pool.ensure(agent, A)).toBe(sandboxContainerName(agent, A));
  const create = calls.find(c => c.args[0] === 'create')!;
  expect(create.args.join(' ')).not.toContain('s3cret');
  expect(create.envFile).toBe('APP_TOKEN=s3cret\nPATH=/app/bin\n');
  // The docker CLI keeps the gateway's own PATH and DOCKER_* settings.
  expect(create.env).toBeUndefined();
  expect(fs.existsSync(create.args[create.args.indexOf('--env-file') + 1])).toBe(false);
  expect(verbs()).toContain('start');
});

it('opens a just-converged sandbox without asking docker again', async () => {
  const pool = new SandboxPool();
  await pool.ensure(agent, A);
  calls.length = 0;
  await pool.ensure(agent, A);
  (await pool.acquire(agent, A)).release();
  expect(calls).toEqual([]);
});

it('reuses a running sandbox whose spec is unchanged', async () => {
  const pool = new SandboxPool();
  await pool.ensure(agent, A);
  calls.length = 0;
  later();
  await pool.ensure(agent, A);
  expect(verbs()).not.toContain('create');
  expect(verbs()).not.toContain('rm');
});

it('never reaps a sandbox a session holds, and reaps it once released and idle', async () => {
  const pool = new SandboxPool();
  const lease = await pool.acquire(agent, A);
  await pool.reap(clock + 24 * 3600_000);
  expect(containers.has(lease.container)).toBe(true);
  lease.release();
  lease.release(); // idempotent: one release per lease
  await pool.reap(clock + 10_000);
  expect(containers.has(lease.container)).toBe(true); // used moments ago
  await pool.reap(clock + 31 * 60_000);
  expect(containers.has(lease.container)).toBe(false);
});

it('keeps a held sandbox when its spec changes, and replaces it once released', async () => {
  const pool = new SandboxPool();
  const lease = await pool.acquire(agent, A);
  fs.mkdirSync(path.join(root, 'ws', 'tools')); // a new workspace entry changes the mounts
  calls.length = 0;
  later();
  const second = await pool.acquire(agent, A);
  expect(verbs()).not.toContain('rm');
  lease.release(); second.release();
  calls.length = 0;
  later();
  await pool.ensure(agent, A);
  expect(verbs()).toEqual(expect.arrayContaining(['rm', 'create', 'start']));
});

it('reaps a sandbox left by an earlier gateway run once idle since this one started', async () => {
  containers.set('demo-agent-c-00000000000000000000', { State: { Running: true }, Config: { Labels: { 'ai.claude-gateway.sandbox': '1' } } });
  const pool = new SandboxPool();
  await pool.reap(clock);
  expect(containers.size).toBe(1);
  await pool.reap(clock + 31 * 60_000);
  expect(containers.size).toBe(0);
});
