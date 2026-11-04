/**
 * Records golden files, git and session fixtures from routers, plus stable process examples.
 *
 * Run:   npm run contracts:fixtures           (rewrites contracts/files-git/fixtures)
 * Check: tests/unit/files-contracts.test.ts   (fails when a fixture is stale or breaks its schema)
 *
 * The routers run in process on a throwaway root, and git reads a throwaway global config. Values that change from run
 * to run or release to release (the temp path, the time a folder is created, a random trash name, the gateway version)
 * are replaced by fixed ones, so a fixture changes only when a response does.
 */
import { execFileSync } from 'child_process';
import express from 'express';
import * as fs from 'fs';
import * as net from 'net';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../src/agent/runner';
import { createCapabilitiesRouter } from '../src/api/capabilities';
import { createFilesRouter } from '../src/api/files-router';
import { createGitRouter } from '../src/api/git-router';
import { createProcessesRouter } from '../src/api/processes-router';
import { GatewayRouter } from '../src/api/gateway-router';
import { overlaps } from '../src/files/paths';
import { createCwdResolver } from '../src/files/session-cwd';
import type { AgentConfig, ApiKey, GatewayConfig, Logger } from '../src/types';

export const CONTRACTS_DIR = path.join(__dirname, '..', 'contracts', 'files-git');
export const FIXTURES_DIR = path.join(CONTRACTS_DIR, 'fixtures');

/** The root every fixture shows, in place of the throwaway one. */
const SHOWN_ROOT = '/home/user/projects';
const FIXED_TIME = new Date('2026-01-02T03:04:05.000Z');

export type SchemaName = 'FilesList' | 'FilesMkdirResponse' | 'FilesDeleteResponse' | 'GitStatus' | 'GitSummary' | 'Capabilities' | 'Error'
  | 'SessionCreateResponse' | 'SessionList' | 'SessionError' | 'ProcessesList' | 'ProcessesFolder' | 'ProcessesStartResponse' | 'ProcessesStopResponse' | 'ProcessesError';

export interface Fixture {
  request: { method: 'GET' | 'POST' | 'DELETE'; url: string; key: 'admin' | 'reader'; body?: unknown };
  status: number;
  schema: SchemaName;
  body: unknown;
}

const KEYS: Record<Fixture['request']['key'], ApiKey> = {
  admin: { key: 'k-admin', agents: '*', write: true, admin: true },
  reader: { key: 'k-reader', agents: '*' },
};

const quiet: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as unknown as Logger;

const GIT_ENV = {
  ...process.env,
  GIT_AUTHOR_NAME: 'Ann Dev', GIT_AUTHOR_EMAIL: 'ann@example.com', GIT_COMMITTER_NAME: 'Ann Dev', GIT_COMMITTER_EMAIL: 'ann@example.com',
  GIT_AUTHOR_DATE: '2026-01-02T03:04:05Z', GIT_COMMITTER_DATE: '2026-01-02T03:04:05Z', GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
};
const git = (cwd: string, ...args: string[]) => execFileSync('git', ['-c', 'init.defaultBranch=main', ...args], { cwd, env: GIT_ENV, stdio: 'pipe' });

function repo(dir: string, remote?: string): void {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, 'init', '-q');
  fs.writeFileSync(path.join(dir, 'README.md'), 'hi\n');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-qm', 'First commit');
  if (remote) git(dir, 'remote', 'add', 'origin', remote);
  fs.writeFileSync(path.join(dir, 'notes.md'), 'untracked\n');
}

/** Every folder under the root gets one fixed mtime, so `modified_at` is stable. */
function pinTimes(dir: string): void {
  for (const d of fs.readdirSync(dir, { withFileTypes: true })) {
    if (d.isDirectory() && d.name !== '.git') pinTimes(path.join(dir, d.name));
  }
  fs.utimesSync(dir, FIXED_TIME, FIXED_TIME);
}

function seed(root: string, outside: string): void {
  fs.mkdirSync(outside, { recursive: true });
  repo(path.join(root, 'app'), 'https://ann:secret-token@github.com/acme/app.git');
  fs.mkdirSync(path.join(root, 'site', 'web'), { recursive: true });
  fs.mkdirSync(path.join(root, 'site', '.venv'));
  fs.mkdirSync(path.join(root, 'site', 'node_modules', 'left-pad'), { recursive: true });
  repo(path.join(root, 'site', 'api'));
  fs.mkdirSync(path.join(root, 'Bad Name'));
  fs.mkdirSync(path.join(root, '.deleting-old-00000000-0000-0000-0000-000000000000'));
  fs.symlinkSync(outside, path.join(root, 'escape'));
  fs.symlinkSync(path.join(root, 'site'), path.join(root, 'alias'));
  fs.mkdirSync(path.join(root, 'busy'));
  fs.mkdirSync(path.join(root, 'locked', 'sub'), { recursive: true });
  fs.writeFileSync(path.join(root, 'locked', 'sub', 'f.txt'), 'x');
  fs.writeFileSync(path.join(root, 'notes.txt'), 'x');
  pinTimes(root);
}

type Step = [name: string, req: Fixture['request'], schema: SchemaName, prepare?: () => void];

const runners: AgentRunner[] = [];

/** Times a session or a mark carries change every run. */
function fixedTimes(value: unknown): unknown {
  return JSON.parse(JSON.stringify(value)
    .replace(/"(createdAt|lastActive)":\d+/g, `"$1":${FIXED_TIME.getTime()}`)
    .replace(/"expiresAt":"[^"]+"/g, `"expiresAt":"${FIXED_TIME.toISOString()}"`));
}

/** Runs every step against fresh routers and returns the fixtures keyed by their path under FIXTURES_DIR. */
export async function recordFixtures(): Promise<Record<string, Fixture>> {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'contracts-')));
  const root = path.join(base, 'projects');
  const outside = path.join(base, 'outside');
  const gitConfig = path.join(base, 'gitconfig');
  fs.writeFileSync(gitConfig, '[init]\n\tdefaultBranch = main\n');
  const savedEnv = { GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL, GIT_CONFIG_NOSYSTEM: process.env.GIT_CONFIG_NOSYSTEM };
  Object.assign(process.env, { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1' });
  try {
    seed(root, outside);
    const config = { gateway: { orchestration: true, files: { root } }, agents: [] } as unknown as GatewayConfig;
    const app = express();
    app.use(express.json());
    app.use('/api', createCapabilitiesRouter(Object.values(KEYS), config));
    app.use('/api', createFilesRouter(Object.values(KEYS), root, { logger: quiet, inUse: (dir) => overlaps(path.join(root, 'busy'), dir) }));
    app.use('/api', createGitRouter(Object.values(KEYS), root, quiet));
    const workspace = path.join(base, 'agents', 'alfred', 'workspace');
    fs.mkdirSync(workspace, { recursive: true });
    const agent: AgentConfig = { id: 'alfred', description: 'alfred', workspace, env: '', claude: { model: 'claude-test', dangerouslySkipPermissions: true, extraFlags: [] } };
    const gateway: GatewayConfig = { gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', orchestration: false, api: { keys: Object.values(KEYS) }, files: { root, trusted: ['site/web'] } }, agents: [agent] };
    const runner = new AgentRunner(agent, gateway, quiet, createCwdResolver(gateway, quiet));
    runners.push(runner);
    const sessions = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', agent]]), undefined, gateway).getApp();
    const thrower = express();
    thrower.use(express.json());
    thrower.use('/api', createFilesRouter(Object.values(KEYS), root, { logger: quiet, inUse: () => { throw new Error('boom'); } }));
    const disabled = express();
    disabled.use('/api', createCapabilitiesRouter(Object.values(KEYS), { gateway: { files: { enabled: false } }, agents: [] } as unknown as GatewayConfig));

    const steps: Step[] = [
      ['capabilities/admin', { method: 'GET', url: '/api/v1/capabilities', key: 'admin' }, 'Capabilities'],
      ['capabilities/reader', { method: 'GET', url: '/api/v1/capabilities', key: 'reader' }, 'Capabilities'],
      ['files-list/root', { method: 'GET', url: '/api/v1/files', key: 'reader' }, 'FilesList'],
      ['files-list/nested', { method: 'GET', url: '/api/v1/files?path=site', key: 'reader' }, 'FilesList'],
      ['files-list/include_hidden', { method: 'GET', url: '/api/v1/files?path=site&include_hidden=true', key: 'reader' }, 'FilesList'],
      ['files-list/path_escape', { method: 'GET', url: '/api/v1/files?path=escape', key: 'reader' }, 'Error'],
      ['files-list/invalid_name', { method: 'GET', url: '/api/v1/files?path=..', key: 'reader' }, 'Error'],
      ['files-list/invalid_path', { method: 'GET', url: '/api/v1/files?path=%2Fetc', key: 'reader' }, 'Error'],
      ['files-list/not_found', { method: 'GET', url: '/api/v1/files?path=nope', key: 'reader' }, 'Error'],
      ['files-mkdir/created', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'demo' } }, 'FilesMkdirResponse'],
      ['files-mkdir/created_nested_git', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'site/docs', git_init: true } }, 'FilesMkdirResponse'],
      ['files-mkdir/already_exists', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'APP' } }, 'Error'],
      ['files-mkdir/not_found', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'nope/new' } }, 'Error'],
      ['files-mkdir/symlink_in_path', { method: 'POST', url: '/api/v1/files/mkdir', key: 'admin', body: { path: 'alias/new' } }, 'Error'],
      ['files-mkdir/forbidden_key', { method: 'POST', url: '/api/v1/files/mkdir', key: 'reader', body: { path: 'demo2' } }, 'Error'],
      ['files-delete/confirm_mismatch', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'site/web', confirm: 'site/web' } }, 'Error'],
      ['files-delete/invalid_path_root', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: '', confirm: '' } }, 'Error'],
      ['files-delete/symlink_in_path', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'alias/web', confirm: 'web' } }, 'Error'],
      ['files-delete/in_use', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'busy', confirm: 'busy' } }, 'Error'],
      ['files-delete/deleted_nested', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'site/node_modules', confirm: 'node_modules' } }, 'FilesDeleteResponse'],
      ['files-delete/deleted_with_warning', { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'locked', confirm: 'locked' } }, 'FilesDeleteResponse', () => fs.chmodSync(path.join(root, 'locked', 'sub'), 0o555)],
      ['git-status/repo', { method: 'GET', url: '/api/v1/git/status?path=app', key: 'reader' }, 'GitStatus'],
      ['git-status/not_a_git_repo', { method: 'GET', url: '/api/v1/git/status?path=site/web', key: 'reader' }, 'Error'],
      ['git-summary/nested', { method: 'GET', url: '/api/v1/git/summary?path=site', key: 'reader' }, 'GitSummary'],
    ];
    const sessionSteps: Step[] = [
      ['sessions-create/created', { method: 'POST', url: '/api/v1/agents/alfred/sessions?chat_id=web', key: 'admin', body: { cwd: 'site' } }, 'SessionCreateResponse'],
      ['sessions-create/created_trusted', { method: 'POST', url: '/api/v1/agents/alfred/sessions?chat_id=web', key: 'admin', body: { cwd: `${SHOWN_ROOT}/site/web` } }, 'SessionCreateResponse'],
      ['sessions-create/invalid_cwd', { method: 'POST', url: '/api/v1/agents/alfred/sessions?chat_id=web', key: 'admin', body: { cwd: '../x' } }, 'SessionError'],
      ['sessions-create/cwd_outside_root', { method: 'POST', url: '/api/v1/agents/alfred/sessions?chat_id=web', key: 'admin', body: { cwd: 'escape' } }, 'SessionError'],
      ['sessions-create/cwd_not_found', { method: 'POST', url: '/api/v1/agents/alfred/sessions?chat_id=web', key: 'admin', body: { cwd: 'nope' } }, 'SessionError'],
      ['sessions-list/web', { method: 'GET', url: '/api/v1/agents/alfred/sessions?chat_id=web', key: 'admin' }, 'SessionList'],
    ];

    const out: Record<string, Fixture> = {};
    const shown = (value: unknown): unknown => JSON.parse(JSON.stringify(value)
      .split(root).join(SHOWN_ROOT)
      .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g, '00000000-0000-0000-0000-000000000000'));
    const record = async (name: string, target: express.Express, req: Fixture['request'], schema: SchemaName) => {
      // The shown root stands in for the real one in a request too.
      const body = req.body === undefined ? undefined : JSON.parse(JSON.stringify(req.body).split(SHOWN_ROOT).join(root));
      let call = request(target)[req.method === 'GET' ? 'get' : req.method === 'POST' ? 'post' : 'delete'](req.url).set('Authorization', `Bearer ${KEYS[req.key].key}`);
      if (body !== undefined) call = call.send(body as object);
      const res = await call;
      const shownBody = fixedTimes(shown(res.body)) as { version?: string; filesystem?: unknown };
      if (schema === 'Capabilities') shownBody.version = '0.0.0';
      if (schema === 'FilesList' && req.url === '/api/v1/files' && shownBody.filesystem) shownBody.filesystem = { total: 107374182400, free: 53687091200, available: 50000000000 };
      out[`${name}.json`] = { request: req, status: res.status, schema, body: shownBody };
    };
    for (const [name, req, schema, prepare] of steps) {
      prepare?.();
      await record(name, app, req, schema);
      const body = out[`${name}.json`]!.body as { entry?: { modified_at: string } };
      // A created folder carries the time it was made.
      if (body.entry) body.entry.modified_at = FIXED_TIME.toISOString();
      pinTimes(root);
    }
    for (const [name, req, schema] of sessionSteps) await record(name, sessions as unknown as express.Express, req, schema);
    await record('capabilities/disabled', disabled, { method: 'GET', url: '/api/v1/capabilities', key: 'admin' }, 'Capabilities');
    await record('errors/internal', thrower, { method: 'DELETE', url: '/api/v1/files', key: 'admin', body: { path: 'busy', confirm: 'busy' } }, 'Error');
    Object.assign(out, await processExamples(root, base));
    return out;
  } finally {
    await Promise.all(runners.splice(0).map((r) => r.stop().catch(() => {})));
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    execFileSync('chmod', ['-R', 'u+w', base]);
    fs.rmSync(base, { recursive: true, force: true });
  }
}

/** Record real process-route responses, normalizing only host-specific ports, PIDs and commands. */
async function processExamples(root: string, base: string): Promise<Record<string, Fixture>> {
  const out: Record<string, Fixture> = {};
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as net.AddressInfo).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  const script = 'scripts/serve.sh';
  fs.mkdirSync(path.join(root, 'site', 'scripts'));
  fs.writeFileSync(path.join(root, 'site', script), `exec node -e "require('net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"\n`);
  fs.writeFileSync(path.join(root, 'site', 'scripts', 'fail.sh'), 'echo "SECRET_TOKEN=fake-contract-secret"\nexit 3\n');
  const slowReady = path.join(base, 'slow-start-ready');
  fs.writeFileSync(path.join(root, 'site', 'scripts', 'slow.sh'), `touch '${slowReady}'\nsleep 2\nexec node -e "require('net').createServer().listen(Number(process.env.PORT), '127.0.0.1')"\n`);
  const app = express();
  app.use(express.json());
  app.use('/api', createProcessesRouter(Object.values(KEYS), root, { logger: quiet,
    start: { logDir: path.join(base, 'process-logs'), portRange: [port, port], timeoutMs: 5000, pollMs: 50 },
    stop: { termWaitMs: 300, pollMs: 50 } }));
  const normalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(normalize);
    if (!value || typeof value !== 'object') return value;
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key,
      key === 'port' && item === port ? 3001 :
      key === 'pid' && typeof item === 'number' ? 4242 :
      key === 'pids' && Array.isArray(item) ? item.map(() => 4242) :
      key === 'command' && typeof item === 'string' ? 'node server.js' : normalize(item)]));
  };
  const add = async (name: string, target: express.Express, method: Fixture['request']['method'], url: string, schema: SchemaName, body?: object) => {
    let call = request(target)[method === 'GET' ? 'get' : 'post'](url).set('Authorization', `Bearer ${KEYS.admin.key}`);
    if (body) call = call.send(body);
    const response = await call;
    out[`processes-${name}.json`] = { request: { method, url, key: 'admin', ...(body ? { body: normalize(body) } : {}) }, status: response.status, schema, body: normalize(response.body) };
  };
  const start = { path: 'site', script, executable: 'sh', port };
  await add('start/invalid_port', app, 'POST', '/api/v1/processes/start', 'ProcessesError', { ...start, port: 80 });
  await add('start/invalid_script', app, 'POST', '/api/v1/processes/start', 'ProcessesError', { ...start, script: '../bad' });
  await add('start/invalid_executable', app, 'POST', '/api/v1/processes/start', 'ProcessesError', { ...start, executable: 'node' });
  await add('start/no_start_command', app, 'POST', '/api/v1/processes/start', 'ProcessesError', { ...start, script: 'scripts/missing.sh' });
  await add('start/start_failed', app, 'POST', '/api/v1/processes/start', 'ProcessesError', { ...start, script: 'scripts/fail.sh' });
  await add('start/started', app, 'POST', '/api/v1/processes/start', 'ProcessesStartResponse', start);
  try {
    await add('list/all', app, 'GET', '/api/v1/processes', 'ProcessesList');
    await add('list/folder', app, 'GET', '/api/v1/processes?path=site', 'ProcessesFolder');
    await add('start/already_running', app, 'POST', '/api/v1/processes/start', 'ProcessesError', start);
    await add('stop/stopped', app, 'POST', '/api/v1/processes/stop', 'ProcessesStopResponse', { path: 'site' });
  } finally {
    // The stop route also checks identity before signalling; retry cleanup only if a fixture call failed.
    await request(app).post('/api/v1/processes/stop').set('Authorization', `Bearer ${KEYS.admin.key}`).send({ path: 'site' });
  }
  const occupied = net.createServer();
  await new Promise<void>((resolve) => occupied.listen(port, '127.0.0.1', resolve));
  try {
    await add('start/port_in_use', app, 'POST', '/api/v1/processes/start', 'ProcessesError', start);
    await add('start/no_free_port', app, 'POST', '/api/v1/processes/start', 'ProcessesError', { path: 'site', script, executable: 'sh' });
  } finally { await new Promise<void>((resolve) => occupied.close(() => resolve())); }
  const pending = request(app).post('/api/v1/processes/start').set('Authorization', `Bearer ${KEYS.admin.key}`).send({ ...start, script: 'scripts/slow.sh' });
  const first = pending.then((response) => response);
  const readyDeadline = Date.now() + 5000;
  while (!fs.existsSync(slowReady)) {
    if (Date.now() >= readyDeadline) throw new Error('slow start did not reach the in-flight state');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  try {
    await add('start/already_running_starting', app, 'POST', '/api/v1/processes/start', 'ProcessesError', start);
    await first;
  } finally {
    await first.catch(() => {});
    await request(app).post('/api/v1/processes/stop').set('Authorization', `Bearer ${KEYS.admin.key}`).send({ path: 'site' });
  }
  return out;
}

export function writeFixtures(fixtures: Record<string, Fixture>): void {
  fs.rmSync(FIXTURES_DIR, { recursive: true, force: true });
  for (const [rel, fixture] of Object.entries(fixtures)) {
    const file = path.join(FIXTURES_DIR, rel);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(fixture, null, 2) + '\n');
  }
}

if (require.main === module) {
  recordFixtures().then((fixtures) => {
    writeFixtures(fixtures);
    console.log(`wrote ${Object.keys(fixtures).length} fixtures to ${path.relative(process.cwd(), FIXTURES_DIR)}`);
  }, (e) => {
    console.error(e);
    process.exit(1);
  });
}
