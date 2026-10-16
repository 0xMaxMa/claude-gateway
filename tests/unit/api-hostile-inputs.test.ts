import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const KEYS = {
  admin: { key: 'k-admin', agents: '*', admin: true },
  podWrite: { key: 'k-pod-write', agents: '*', write: true },
  podRead: { key: 'k-pod-read', agents: '*' },
  otherAgent: { key: 'k-other-agent', agents: ['bruce'], write: true },
} satisfies Record<string, ApiKey>;

const A = '/api/v1/agents/alfred';
const UUID = '11111111-2222-3333-4444-555555555555';
const HUGE = 'a'.repeat(8000);

type Route = [method: string, url: string, hasBody: boolean];
const ROUTES: Route[] = [
  ['get', `${A}/chats`, false],
  ['get', `${A}/chats/{chat}/sessions`, false],
  ['get', `${A}/chats/{chat}/messages`, false],
  ['get', `${A}/chats/{chat}/messages/search`, false],
  ['get', `${A}/chats/{chat}/messages/active-days`, false],
  ['post', `${A}/chats/{chat}/sessions/{sid}/messages`, true],
  ['get', `${A}/media/api-{sid}/x.png`, false],
  ['get', `${A}/sessions`, false],
  ['post', `${A}/sessions`, true],
  ['get', `${A}/sessions/{sid}/info`, false],
  ['patch', `${A}/sessions/{sid}`, true],
  ['delete', `${A}/sessions/{sid}`, false],
  ['post', `${A}/sessions/{sid}/clear`, true],
  ['post', `${A}/sessions/{sid}/compact`, true],
  ['post', `${A}/sessions/{sid}/stop`, true],
  ['post', `${A}/sessions/{sid}/restart`, true],
  ['get', `${A}/sessions/{sid}/messages/stream`, false],
  ['get', `${A}/sessions/{sid}/activity/stream`, false],
  ['get', `${A}/sessions/{sid}/activity`, false],
  ['get', `${A}/sessions/{sid}/stream`, false],
  ['get', `${A}/sessions/{sid}/tasks`, false],
  ['get', `${A}/sessions/{sid}/tasks/${UUID}`, false],
  ['post', `${A}/sessions/{sid}/tasks/${UUID}/answer`, true],
  ['post', `${A}/sessions/{sid}/tasks/${UUID}/control`, true],
  ['post', `${A}/sessions/{sid}/tasks/${UUID}/cancel`, true],
  ['post', `${A}/messages`, true],
  ['post', `${A}/messages/accept`, true],
  ['post', `${A}/greeting`, true],
  ['get', '/api/v1/agents/sessions', false],
  ['post', `${A}/sessions/{sid}/attachments`, true],
  ['post', '/api/v1/shares', true],
  ['post', '/api/v1/image-artifacts', true],
  ['get', '/api/v1/image-catalog', false],
  ['get', '/api/v1/video-catalog', false],
];

const QUERIES = [
  'session_id=a&session_id=b', 'session_id[]=x', 'session_id[a]=b', 'q=a&q=b', 'q[a]=b', 'q[]=x',
  'limit=1&limit=2', 'limit[]=1', 'before[x]=1', 'after_id[]=1', 'order[]=asc', 'chat_id=a&chat_id=b', 'chat_id[x]=1',
  'page[]=1', 'after_seq[]=1', `session_id=${HUGE}`, `q=${HUGE}`, 'session_id=%00', 'q=%00', 'session_id=%2F..%2F', 'from[]=1&to[]=2&tz_offset[]=1', 'agent_id[]=alfred&session_id[]=x', 'agent_id=alfred&session_id=%2e%2e%2fx',
];
const PATH_VALUES = ['x%2F..%2F{bound}', '%2e%2e', '..%2f..%2f', '%252e%252e', '%00', '%5c..%5c', HUGE];
const BODIES: unknown[] = [
  [], { session_id: ['a', 'b'] }, { session_id: { a: 1 }, chat_id: { x: 1 }, message: { x: 1 } }, { project: ['site'] }, { project: { a: 1 } },
  { session_name: { a: 1 }, name: ['n'], prompt: { p: 1 } }, { message: HUGE, content: HUGE, chat_id: HUGE, session_id: HUGE },
  { session_id: 'a\u0000b', chat_id: 'web\u0000', message: 'x' }, { questionId: [1], answer: { a: 1 }, id: [], action: {} },
  { agent_id: ['alfred'], session_id: { a: 1 }, refs: [{ path: ['x'] }, null, 5], files: [{}, 1] }, { files: [HUGE], refs: [{ path: '../../etc/passwd' }, { path: 'a\u0000' }] },
];

let gwBase: string;
let runner: AgentRunner;
let gw: ReturnType<GatewayRouter['getApp']>;
let bound: string;
let server: import('http').Server;
let port: number;
const rejections: unknown[] = [];
const onRejection = (r: unknown) => { rejections.push(r); };

beforeEach(async () => {
  rejections.length = 0;
  process.on('unhandledRejection', onRejection);
  gwBase = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'api-hostile-')));
  fs.mkdirSync(path.join(gwBase, 'projects', 'site'), { recursive: true });
  const workspace = path.join(gwBase, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(gwBase, 'logs'), timezone: 'UTC', api: { keys: Object.values(KEYS) }, projects: { root: path.join(gwBase, 'projects') } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway);
  gw = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway).getApp();
  server = gw.listen(0);
  port = (server.address() as { port: number }).port;
  bound = (await request(gw).post(`${A}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer k-admin').send({ project: 'site', name: 'secret-site-chat' })).body.sessionId;
  runner.getHistoryDb().insertMessage({ chatId: 'api-web', sessionId: bound, source: 'api', role: 'user', content: 'TRANSCRIPT-OF-THE-PROJECT', ts: Date.now() });
});
afterEach(async () => {
  process.off('unhandledRejection', onRejection);
  server.closeAllConnections();
  server.close();
  await runner.stop().catch(() => {});
  fs.rmSync(gwBase, { recursive: true, force: true });
});

type Probe = { label: string; method: string; url: string; body?: unknown };
function probes(): Probe[] {
  const out: Probe[] = [];
  for (const [method, tpl, hasBody] of ROUTES) {
    const fill = (u: string, v: string) => u.replace('{sid}', v).replace('{chat}', v === 'x%2F..%2F{bound}' ? 'api-web' : v).replace('{bound}', bound);
    const plain = fill(tpl, 'api-web').replace('api-web/sessions/api-web', 'api-web/sessions/plain1').replace(/\{sid\}/g, 'plain1');
    const base = tpl.replace('{chat}', 'api-web').replace('{sid}', 'plain1');
    if (!hasBody) for (const q of /stream/.test(tpl) ? QUERIES.slice(0, 4) : QUERIES) out.push({ label: `${method} ${base}?${q.slice(0, 40)}`, method, url: `${base}?${q}` });
    else for (const b of BODIES) out.push({ label: `${method} ${base} ${JSON.stringify(b).slice(0, 40)}`, method, url: base, body: b });
    for (const v of PATH_VALUES) {
      if (!/\{(sid|chat)\}/.test(tpl)) continue;
      out.push({ label: `${method} ${tpl} <- ${v.slice(0, 30)}`, method, url: fill(tpl, v), body: hasBody ? {} : undefined });
    }
    void plain;
  }
  return out;
}

async function hit(p: Probe, key: string): Promise<{ status: number; type: string; text: string } | null> {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 400);
  try {
    const r = await fetch(`http://127.0.0.1:${port}${p.url}`, {
      method: p.method.toUpperCase(), signal: ctl.signal,
      headers: { Authorization: `Bearer ${key}`, 'content-type': 'application/json' },
      body: p.body === undefined ? undefined : JSON.stringify(p.body),
    });
    let text = '';
    try {
      const reader = r.body!.getReader();
      for (let n = 0; n < 4; n++) { const c = await reader.read(); if (c.done) break; text += Buffer.from(c.value).toString(); }
    } catch { /* stream held open until the abort */ }
    return { status: r.status, type: r.headers.get('content-type') ?? '', text };
  } catch { return null; } finally { clearTimeout(timer); ctl.abort(); }
}

describe.each(Object.entries(KEYS))('hostile inputs on every changed route (%s)', (_n, key) => {
  it('never crashes the process, never leaks, always answers', async () => {
    const failures: string[] = [];
    for (const p of probes()) {
      const res = await hit(p, key.key);
      if (!res) { failures.push(`${p.label}: no response`); continue; }
      if (res.status < 200 || res.status > 599) failures.push(`${p.label}: status ${res.status}`);
      if (key === KEYS.otherAgent && (res.text.includes('TRANSCRIPT-OF-THE-PROJECT') || res.text.includes('secret-site-chat'))) failures.push(`${p.label}: leaked ${res.status}`);
      if (res.status >= 500 && !/json/.test(res.type)) failures.push(`${p.label}: ${res.status} not JSON`);
    }
    await new Promise((r) => setImmediate(r));
    expect(failures).toEqual([]);
    expect(rejections).toEqual([]);
  }, 180_000);
});

it('answers repeated or nested session_id and q with 400, not a throw', async () => {
  const get = (url: string) => request(gw).get(url).set('Authorization', 'Bearer k-pod-read');
  for (const url of [
    `${A}/chats/api-web/messages?session_id=a&session_id=b`, `${A}/chats/api-web/messages?session_id[]=x`,
    `${A}/chats/api-web/messages/search?q=a&q=b`, `${A}/chats/api-web/messages/active-days?session_id=a&session_id=b`,
  ]) expect([url, (await get(url)).status]).toEqual([url, 400]);
  expect(rejections).toEqual([]);
});
