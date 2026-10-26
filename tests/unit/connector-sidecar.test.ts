/**
 * Connector sidecars: a gateway-run MCP server behind an HTTP connector entry.
 *
 *  spec boundary   — what a sidecar entry may hold; no {placeholder} reaches argv/env
 *  supervisor      — start, readiness, crash restart, spec change vs token change,
 *                    pause/delete/close, port allocation, the child's environment
 *  routes + proxy  — /oauth/receive starts it, the proxy adds the token per request,
 *                    the status API reports it, DELETE stops it
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import request from 'supertest';
import type { CustomConnectorEntry } from '../../src/types';

const TOKEN = 'fixture-access-token-1';

let tmpDir: string;
let fixture: string;
let forkThenExit: string;

/** Listens on $PORT (127.0.0.1) and reports what it was started with and what it was sent. */
const FIXTURE = `
const http = require('http');
if (process.env.NEVER_LISTEN) { setInterval(() => {}, 1000); return; }
const server = http.createServer((req, res) => {
  if (req.url === '/exit') { res.end('bye'); setTimeout(() => process.exit(3), 10); return; }
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ pid: process.pid, url: req.url, authorization: req.headers.authorization ?? null, env: process.env, argv: process.argv.slice(2), body }));
  });
});
server.listen(Number(process.env.PORT), '127.0.0.1');
process.stderr.write('fixture: Authorization: Bearer leaked-in-a-log-line\\n');
`;

/** Starts a child in its process group (as uvx starts python), records its pid, then exits. */
const FORK_THEN_EXIT = `
const { spawn } = require('child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
require('fs').appendFileSync(process.env.PIDS, child.pid + '\\n');
setTimeout(() => process.exit(1), 50);
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cgw-sidecar-'));
  fixture = path.join(tmpDir, 'fixture.js');
  fs.writeFileSync(fixture, FIXTURE);
  forkThenExit = path.join(tmpDir, 'fork-then-exit.js');
  fs.writeFileSync(forkThenExit, FORK_THEN_EXIT);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function sidecarEntry(sidecar: Record<string, unknown>, extra: Record<string, unknown> = {}): CustomConnectorEntry {
  return {
    label: 'Fixture',
    config: { type: 'http', headers: { Authorization: 'Bearer {access_token}' }, sidecar, ...extra },
    secretNames: ['access_token'],
    credentialOwner: 'external',
  };
}

const fixtureSpec = (env: Record<string, string> = {}, readyTimeoutMs = 10_000): Record<string, unknown> =>
  ({ command: process.execPath, args: [fixture], env, readyTimeoutMs });

function alive(pid: number | undefined): boolean {
  if (!pid) return false;
  try { process.kill(pid, 0); return true; } catch { return false; }
}

async function until<T>(read: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = read();
    if (value) return value;
    if (Date.now() > deadline) throw new Error('condition not met in time');
    await new Promise(r => setTimeout(r, 25));
  }
}

async function getJson(url: string): Promise<Record<string, unknown>> {
  const res = await fetch(url);
  return await res.json() as Record<string, unknown>;
}

describe('parseSidecarSpec', () => {
  const { parseSidecarSpec } = require('../../src/connectors/sidecar') as typeof import('../../src/connectors/sidecar');
  const parse = (sidecar: unknown, extra: Record<string, unknown> = {}) =>
    parseSidecarSpec({ type: 'http', headers: { Authorization: 'Bearer {access_token}' }, sidecar, ...extra });

  it('fills the defaults', () => {
    expect(parse({ command: 'uvx' })).toEqual({ command: 'uvx', args: [], env: {}, path: '/mcp', readyTimeoutMs: 120_000 });
    expect(parseSidecarSpec({ type: 'http', url: 'https://x.example/mcp' })).toBeUndefined();
  });

  it.each([
    ['command', { command: 'run-{access_token}' }],
    ['args', { command: 'uvx', args: ['--token', '{access_token}'] }],
    ['env', { command: 'uvx', env: { TOKEN: 'Bearer {access_token}' } }],
    ['path', { command: 'uvx', path: '/mcp/{access_token}' }],
  ])('rejects a {placeholder} in %s, so the token never reaches the process', (_field, sidecar) => {
    expect(parse(sidecar)).toEqual({ error: expect.stringContaining('must not contain {placeholders}') });
  });

  it.each([
    [{ command: 'uvx' }, { url: 'http://127.0.0.1:1/mcp' }, 'config.url must be omitted'],
    [{ command: 'uvx' }, { type: 'stdio' }, "requires config.type 'http'"],
    [{ command: 'uvx' }, { headersHelper: 'x' }, 'headersHelper'],
    [{ command: 'uvx', env: { PORT: '1' } }, {}, 'must not set PORT'],
    [{ command: '' }, {}, 'sidecar.command'],
    [{ command: 'uvx', args: [1] }, {}, 'sidecar.args'],
    [{ command: 'uvx', path: 'mcp' }, {}, 'sidecar.path'],
    [{ command: 'uvx', readyTimeoutMs: 10 }, {}, 'readyTimeoutMs'],
    [{ command: 'uvx', cwd: '/' }, {}, 'unknown field(s): cwd'],
  ])('rejects %j with %j', (sidecar, extra, message) => {
    expect(parse(sidecar, extra)).toEqual({ error: expect.stringContaining(message) });
  });
});

describe('SidecarSupervisor', () => {
  const { SidecarSupervisor } = require('../../src/connectors/sidecar') as typeof import('../../src/connectors/sidecar');
  let supervisor: InstanceType<typeof SidecarSupervisor>;
  let logs: string[];

  beforeEach(() => {
    logs = [];
    supervisor = new SidecarSupervisor({ runtimeRoot: tmpDir, backoffMs: [50], stopGraceMs: 500, log: line => logs.push(line) });
  });
  afterEach(async () => { await supervisor.close(); });

  const readyUrl = (id: string): Promise<string> => until(() => supervisor.urlOf(id));

  it('starts on a loopback port passed as PORT, with only PATH, HOME, LANG and its own env', async () => {
    process.env.GATEWAY_FIXTURE_SECRET = 'gateway-secret';
    try {
      supervisor.reconcile({ fx: sidecarEntry(fixtureSpec({ EXTRA: 'yes' })) });
      expect(supervisor.statusOf('fx')?.state).toBe('starting');
      const url = await readyUrl('fx');
      expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/mcp$/);
      const seen = await getJson(url);
      const env = seen.env as Record<string, string>;
      expect(env.PORT).toBe(new URL(url).port);
      expect(env.EXTRA).toBe('yes');
      expect(env.GATEWAY_FIXTURE_SECRET).toBeUndefined();
      // macOS adds __CF_USER_TEXT_ENCODING to every process it starts.
      expect(Object.keys(env).filter(k => k !== '__CF_USER_TEXT_ENCODING').sort()).toEqual(['EXTRA', 'HOME', 'PATH', 'PORT', ...(process.env.LANG ? ['LANG'] : [])].sort());
      expect(supervisor.statusOf('fx')).toEqual({ state: 'ready', pid: seen.pid, restarts: 0 });
    } finally {
      delete process.env.GATEWAY_FIXTURE_SECRET;
    }
  });

  it('keeps running across a token-only change and restarts on a spec change', async () => {
    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec()) });
    const first = (await getJson(await readyUrl('fx'))).pid as number;

    // A control plane's re-push: same spec, different header and label.
    supervisor.reconcile({ fx: { ...sidecarEntry(fixtureSpec(), { headers: { Authorization: 'Bearer {access_token}', 'X-Other': '1' } }), label: 'Renamed' } });
    await new Promise(r => setTimeout(r, 200));
    expect(supervisor.statusOf('fx')).toEqual({ state: 'ready', pid: first, restarts: 0 });

    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec({ VERSION: '2' })) });
    const second = await until(() => { const s = supervisor.statusOf('fx'); return s?.state === 'ready' && s.pid !== first && s.pid; });
    expect(((await getJson(supervisor.urlOf('fx')!)).env as Record<string, string>).VERSION).toBe('2');
    expect(alive(first)).toBe(false);
    expect(supervisor.statusOf('fx')).toEqual({ state: 'ready', pid: second, restarts: 1 });
  });

  it('restarts a crashed sidecar after the backoff', async () => {
    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec()) });
    const url = await readyUrl('fx');
    const first = (await getJson(url)).pid as number;
    await fetch(new URL('/exit', url));
    const second = await until(() => { const s = supervisor.statusOf('fx'); return s?.state === 'ready' && s.pid !== first && s.pid; });
    expect(alive(first)).toBe(false);
    expect(alive(second)).toBe(true);
    expect(supervisor.statusOf('fx')?.restarts).toBe(1);
    expect(logs).toContainEqual(expect.stringContaining('connector=fx exited with code 3'));
  });

  it('kills what a crashed leader left in its process group', async () => {
    const pids = path.join(tmpDir, 'leader-exit.pids');
    fs.writeFileSync(pids, '');
    const once = new SidecarSupervisor({ runtimeRoot: tmpDir, backoffMs: [60_000], stopGraceMs: 500, log: line => logs.push(line) });
    try {
      once.reconcile({ fx: sidecarEntry({ command: process.execPath, args: [forkThenExit], env: { PIDS: pids } }) });
      await until(() => logs.some(l => l.includes('connector=fx exited with code 1')));
      await new Promise(r => setTimeout(r, 300));
      const orphans = fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number);
      expect({ orphans: orphans.length, alive: orphans.filter(alive).length }).toEqual({ orphans: 1, alive: 0 });
    } finally {
      for (const pid of fs.readFileSync(pids, 'utf8').trim().split('\n').map(Number)) if (alive(pid)) process.kill(pid, 'SIGKILL');
      await once.close();
    }
  });

  it('reclaims the sidecars of a gateway that was SIGKILLed, and only those', async () => {
    const root = fs.mkdtempSync(path.join(tmpDir, 'killed-gateway-'));
    // uvx re-execs itself as `uv tool uvx <args>`, so the leader's command line keeps only the args.
    const reexec = path.join(root, 'reexec.sh');
    fs.writeFileSync(reexec, `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)} "$@"\n`, { mode: 0o755 });
    const gateway = path.join(root, 'gateway.js');
    fs.writeFileSync(gateway, `
      require(${JSON.stringify(require.resolve('ts-node/register/transpile-only'))});
      const { SidecarSupervisor } = require(${JSON.stringify(path.resolve(__dirname, '../../src/connectors/sidecar'))});
      const entry = { label: 'x', secretNames: [], config: { type: 'http', sidecar: { command: ${JSON.stringify(reexec)}, args: ['--sidecar-arg'] } } };
      new SidecarSupervisor({ runtimeRoot: ${JSON.stringify(root)}, log: line => console.log(line) }).reconcile({ a: entry, b: entry });
      setInterval(() => {}, 1000);
    `);
    const { spawn } = require('child_process') as typeof import('child_process');
    const killed = spawn(process.execPath, [gateway], { stdio: ['ignore', 'pipe', 'inherit'] });
    let output = '';
    killed.stdout!.on('data', (chunk: Buffer) => { output += chunk; });
    const old = await until(() => {
      const pids = [...output.matchAll(/connector=(a|b) started pid=(\d+)/g)].map(m => Number(m[2]));
      return (output.match(/ ready on /g) ?? []).length === 2 && pids;
    }, 20_000);
    killed.kill('SIGKILL');
    await new Promise(r => killed.once('exit', r));
    try {
      expect(old.map(alive)).toEqual([true, true]);
      const next = new SidecarSupervisor({ runtimeRoot: root, stopGraceMs: 500, log: line => logs.push(line) });
      await next.reclaimOrphans();
      next.reconcile({ a: sidecarEntry(fixtureSpec()) });
      await until(() => next.urlOf('a'));
      expect({ oldAlive: old.filter(alive).length, newPid: old.includes(next.statusOf('a')!.pid!) }).toEqual({ oldAlive: 0, newPid: false });
      next.reconcile({});
      await until(() => !next.statusOf('a'));
      await new Promise(r => setTimeout(r, 600));
      expect(fs.readdirSync(path.join(root, 'sidecars'))).toEqual([]);
      await next.close();
    } finally {
      for (const pid of old) if (alive(pid)) process.kill(-pid, 'SIGKILL');
    }
  });

  it('leaves alone a recorded process group whose leader is now another program', async () => {
    const { spawn } = require('child_process') as typeof import('child_process');
    const stranger = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: true, stdio: 'ignore' });
    try {
      const root = fs.mkdtempSync(path.join(tmpDir, 'reused-pid-'));
      fs.mkdirSync(path.join(root, 'sidecars', 'fx'), { recursive: true });
      fs.writeFileSync(path.join(root, 'sidecars', 'fx', 'pgid'), JSON.stringify({ pgid: stranger.pid, command: 'uvx', args: '--from workspace-mcp workspace-mcp' }));
      await new SidecarSupervisor({ runtimeRoot: root, log: () => {} }).reclaimOrphans();
      // A killed child of this process stays a zombie until reaped, so watch for its exit instead of probing the pid.
      await new Promise(r => setTimeout(r, 300));
      expect({ exited: stranger.exitCode !== null || stranger.signalCode !== null }).toEqual({ exited: false });
    } finally {
      stranger.kill('SIGKILL');
    }
  });

  it('stops on pause and on delete', async () => {
    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec()) });
    const pid = (await getJson(await readyUrl('fx'))).pid as number;
    supervisor.reconcile({ fx: { ...sidecarEntry(fixtureSpec()), paused: true } });
    await until(() => !alive(pid));
    expect(supervisor.statusOf('fx')).toBeUndefined();

    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec()) });
    const again = (await getJson(await readyUrl('fx'))).pid as number;
    supervisor.reconcile({});
    await until(() => !alive(again));
    expect(supervisor.urlOf('fx')).toBeUndefined();
  });

  it('gives each sidecar its own port and stops them all on close', async () => {
    supervisor.reconcile({ a: sidecarEntry(fixtureSpec()), b: sidecarEntry(fixtureSpec()) });
    const [a, b] = [await readyUrl('a'), await readyUrl('b')];
    expect(new URL(a).port).not.toBe(new URL(b).port);
    const pids = [supervisor.statusOf('a')!.pid!, supervisor.statusOf('b')!.pid!];
    await supervisor.close();
    expect(pids.map(alive)).toEqual([false, false]);
    supervisor.reconcile({ a: sidecarEntry(fixtureSpec()) });
    expect(supervisor.statusOf('a')).toBeUndefined();
  });

  it('reports a sidecar that never listens as crashed and kills it', async () => {
    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec({ NEVER_LISTEN: '1' }, 1000)) });
    const pid = await until(() => supervisor.statusOf('fx')?.pid);
    const status = await until(() => { const s = supervisor.statusOf('fx'); return s?.state === 'crashed' && s; }, 5000);
    expect(status.lastError).toBe('not listening on its port within 1000ms');
    expect(alive(pid)).toBe(false);
  });

  it('reports an invalid hand-edited spec without starting anything', () => {
    supervisor.reconcile({ fx: sidecarEntry({ command: 'x', env: { T: '{access_token}' } }) });
    return until(() => supervisor.statusOf('fx')?.lastError).then(error => {
      expect(error).toContain('must not contain {placeholders}');
      expect(supervisor.statusOf('fx')?.state).toBe('crashed');
    });
  });

  it('masks bearer values in the output it logs', async () => {
    supervisor.reconcile({ fx: sidecarEntry(fixtureSpec()) });
    await readyUrl('fx');
    await until(() => logs.some(l => l.includes('fixture: Authorization')));
    expect(logs).toContainEqual('connector-sidecar: connector=fx output: fixture: Authorization: Bearer [redacted]');
  });
});

describe('sidecar connectors through the routes and the proxy', () => {
  const TOKEN_ENV = path.join(os.tmpdir(), `connector-sidecar-${process.pid}.env`);
  let cfgPath: string;
  let server: http.Server;
  let base: string;
  let sidecars: typeof import('../../src/connectors/sidecar');
  let proxy: typeof import('../../src/connectors/proxy');

  beforeEach(async () => {
    process.env.GATEWAY_MCP_TOKEN_ENV_PATH = TOKEN_ENV;
    fs.rmSync(TOKEN_ENV, { force: true });
    jest.resetModules();
    sidecars = require('../../src/connectors/sidecar');
    proxy = require('../../src/connectors/proxy');
    sidecars.connectorSidecars.configure({ runtimeRoot: tmpDir, backoffMs: [50], stopGraceMs: 500, log: () => {} });
    cfgPath = path.join(fs.mkdtempSync(path.join(tmpDir, 'cfg-')), 'config.json');
    fs.writeFileSync(cfgPath, JSON.stringify({ gateway: { logDir: tmpDir, timezone: 'UTC' }, agents: [{ id: 'a' }] }));
    const { createConnectorsRouter } = require('../../src/api/connectors-router');
    const app = express();
    app.use(proxy.createConnectorProxyRouter());
    app.use(express.json());
    app.use('/api', createConnectorsRouter([{ key: 'admin', agents: '*', admin: true }], cfgPath));
    server = http.createServer(app);
    await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    proxy.setConnectorProxyOrigin(server.address() as AddressInfo);
  });

  afterEach(async () => {
    await sidecars.connectorSidecars.get().close();
    await new Promise(r => server.close(r));
    fs.rmSync(TOKEN_ENV, { force: true });
    delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  });

  const push = (config: Record<string, unknown>, token = TOKEN) =>
    request(base).post('/api/v1/connectors/fx/oauth/receive').set('Authorization', 'Bearer admin')
      .send({ access_token: token, label: 'Fixture', config });

  const sidecarConfig = (env: Record<string, string> = {}) =>
    ({ type: 'http', headers: { Authorization: 'Bearer {access_token}' }, sidecar: fixtureSpec(env) });

  it('refuses a {placeholder} in the sidecar and a url beside it', async () => {
    const leak = await push({ ...sidecarConfig(), sidecar: { ...fixtureSpec(), env: { TOKEN: '{access_token}' } }, headers: {} });
    expect(leak.status).toBe(400);
    expect(leak.body.error).toContain('must not contain {placeholders}');
    const url = await push({ ...sidecarConfig(), url: 'http://127.0.0.1:1/mcp' });
    expect(url.status).toBe(400);
    expect(url.body.error).toContain('config.url must be omitted');
    expect(sidecars.connectorSidecars.get().statusOf('fx')).toBeUndefined();
  });

  it('starts on push, adds the token per request, survives a token re-push, and stops on DELETE', async () => {
    expect((await push(sidecarConfig())).status).toBe(200);
    const supervisor = sidecars.connectorSidecars.get();
    expect(supervisor.statusOf('fx')?.state).toBe('starting');

    const config = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const gateway = { ...config, gateway: { ...config.gateway } };
    const { servers, grant, proxied } = proxy.agentFacingConnectors({ id: 'a' }, gateway, require('../../src/connectors/resolve').resolveEnabledConnectors({}, config.gateway.customConnectors));
    expect(proxied.has('fx')).toBe(true);
    const entry = servers.fx as { url: string; headers: Record<string, string> };
    expect(JSON.stringify(entry)).not.toContain(TOKEN);
    expect(JSON.stringify(entry)).not.toContain('sidecar');

    // Sent while the sidecar may still be starting: the proxy holds it until ready.
    const call = await fetch(entry.url, { method: 'POST', headers: { ...entry.headers, 'content-type': 'application/json' }, body: '{"jsonrpc":"2.0"}' });
    expect(call.status).toBe(200);
    const seen = await call.json() as { pid: number; url: string; authorization: string; env: Record<string, string>; argv: string[] };
    expect(seen.url).toBe('/mcp');
    expect(seen.authorization).toBe(`Bearer ${TOKEN}`);
    expect(JSON.stringify(seen.env) + JSON.stringify(seen.argv)).not.toContain(TOKEN);

    const status = await request(base).get('/api/v1/connectors').set('Authorization', 'Bearer admin');
    expect(status.body.connectors[0].sidecar).toEqual({ state: 'ready', pid: seen.pid, restarts: 0 });
    expect(JSON.stringify(status.body)).not.toContain(TOKEN);

    expect((await push(sidecarConfig(), 'fixture-access-token-2')).status).toBe(200);
    expect(supervisor.statusOf('fx')).toEqual({ state: 'ready', pid: seen.pid, restarts: 0 });
    const rotated = await (await fetch(entry.url, { method: 'POST', headers: entry.headers })).json() as { authorization: string };
    expect(rotated.authorization).toBe('Bearer fixture-access-token-2');

    expect((await request(base).delete('/api/v1/connectors/fx').set('Authorization', 'Bearer admin')).status).toBe(200);
    await until(() => !alive(seen.pid));
    expect(supervisor.statusOf('fx')).toBeUndefined();
    proxy.revokeConnectorGrant(grant);
  });

  it('stops on pause and starts again on resume', async () => {
    expect((await push(sidecarConfig())).status).toBe(200);
    const supervisor = sidecars.connectorSidecars.get();
    const pid = await until(() => supervisor.statusOf('fx')?.state === 'ready' && supervisor.statusOf('fx')!.pid);
    await request(base).patch('/api/v1/connectors/fx').set('Authorization', 'Bearer admin').send({ paused: true }).expect(200);
    await until(() => !alive(pid));
    await request(base).patch('/api/v1/connectors/fx').set('Authorization', 'Bearer admin').send({ paused: false }).expect(200);
    await until(() => supervisor.statusOf('fx')?.state === 'ready');
  });
});
