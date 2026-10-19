/**
 * The real MCP server (api_reply, share_file) calls the gateway with the API key the agent was handed: the first key
 * that reaches the agent. In a project chat, as in a plain one, any such key works, an agent-scoped key included; that
 * key still reaches no other agent's chat.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { AddressInfo } from 'net';
import request from 'supertest';
import { AgentRunner } from '../../src/agent/runner';
import { GatewayRouter } from '../../src/api/gateway-router';
import type { AgentConfig, ApiKey, GatewayConfig } from '../../src/types';

const MOCK = path.resolve(__dirname, '../helpers/mock-claude-api-mcp.js');
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64');
const ADMIN: ApiKey = { key: 'sk-admin', agents: '*', admin: true };
const WRITER: ApiKey = { key: 'sk-agent-writer', agents: '*', write: true };
const ALFRED_ONLY: ApiKey = { key: 'sk-alfred-only', agents: ['alfred'], write: true };
const A = '/api/v1/agents/alfred';

let base: string;
let runner: AgentRunner;
let bruceRunner: AgentRunner;
let server: import('http').Server;
let log: string;
const saved = { HOME: process.env.HOME, URL: process.env.GATEWAY_API_URL };

beforeAll(() => { process.env.CLAUDE_BIN = `node ${MOCK}`; });
afterAll(() => { delete process.env.CLAUDE_BIN; });

async function start(keys: ApiKey[]): Promise<void> {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-media-')));
  process.env.HOME = base;
  log = path.join(base, 'mcp.jsonl');
  process.env.MOCK_MCP_LOG = log;
  fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Persona of alfred\n');
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', allow_tools: true, claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const brucesWorkspace = path.join(base, 'agents', 'bruce', 'workspace');
  fs.mkdirSync(brucesWorkspace, { recursive: true });
  const bruce: AgentConfig = { ...cfg, id: 'bruce', workspace: brucesWorkspace };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', orchestration: false, publicUrl: 'https://gw.example', api: { keys }, projects: { root: path.join(base, 'projects') } },
    agents: [cfg, bruce],
  };
  runner = new AgentRunner(cfg, gateway);
  bruceRunner = new AgentRunner(bruce, gateway);
  const app = new GatewayRouter(new Map([['alfred', runner], ['bruce', bruceRunner]]), new Map([['alfred', cfg], ['bruce', bruce]]), undefined, gateway, undefined, path.join(base, 'config.json')).getApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.GATEWAY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}
afterEach(async () => {
  server.closeAllConnections();
  server.close();
  await runner.stop().catch(() => {});
  await bruceRunner.stop().catch(() => {});
  delete process.env.MOCK_MCP_LOG;
  process.env.HOME = saved.HOME;
  if (saved.URL === undefined) delete process.env.GATEWAY_API_URL; else process.env.GATEWAY_API_URL = saved.URL;
  fs.rmSync(base, { recursive: true, force: true });
});

async function openChat(body: object, agent = 'alfred'): Promise<string> {
  const res = await request(server).post(`/api/v1/agents/${agent}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer sk-admin').send(body);
  const id = res.body.sessionId as string;
  fs.mkdirSync(path.join(base, 'agents', agent, 'media', `api-${id}`), { recursive: true });
  fs.writeFileSync(path.join(base, 'agents', agent, 'media', `api-${id}`, 'f.png'), PNG);
  return id;
}

const toolLog = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

async function attachAndShare(id: string): Promise<Array<[string, boolean]>> {
  const file = path.join(base, 'agents', 'alfred', 'media', `api-${id}`, 'f.png');
  const res = await request(server).post(`${A}/messages`).set('Authorization', 'Bearer sk-admin')
    .send({ message: `MCP-ATTACH:${file} MCP-SHARE:media/api-${id}/f.png`, chat_id: 'web', session_id: id });
  expect(JSON.stringify([res.status, res.body])).toMatch(/^\[200/);
  const calls = toolLog();
  expect(calls.filter((c) => c.error)).toEqual([]);
  return calls.filter((c) => c.tool).map((c) => [c.tool, !c.result?.isError]);
}

describe('an agent handed an admin key', () => {
  beforeEach(() => start([ADMIN, WRITER]));
  it.each([['a project chat', { project: 'site' }], ['a plain chat', {}]])('attaches media and creates a share in %s', async (_n, body) => {
    const id = await openChat(body);
    expect(await attachAndShare(id)).toEqual([['api_reply', true], ['share_file', true]]);
    expect(toolLog()[1].result.content[0].text).toMatch(/"url": "https:\/\/gw\.example\/shared\//);
  }, 60_000);
});

describe.each([['a pod-wide write key', WRITER], ['a key scoped to that agent', ALFRED_ONLY]])('an agent handed %s, not an admin key', (_n, key) => {
  beforeEach(() => start([key, ADMIN]));
  it.each([['a project chat', { project: 'site' }], ['a plain chat', {}]])('attaches media and creates a share in %s', async (_c, body) => {
    expect(await attachAndShare(await openChat(body))).toEqual([['api_reply', true], ['share_file', true]]);
  }, 60_000);
});

describe("an agent-scoped key against another agent's project chat", () => {
  beforeEach(() => start([ALFRED_ONLY, ADMIN]));
  it('is refused with the usual agent message', async () => {
    const theirs = await openChat({ project: 'site' }, 'bruce');
    const file = path.join(base, 'agents', 'bruce', 'media', `api-${theirs}`, 'f.png');
    const as = (r: request.Test) => r.set('Authorization', `Bearer ${ALFRED_ONLY.key}`);
    for (const res of [
      await as(request(server).post(`/api/v1/agents/bruce/sessions/${theirs}/attachments`)).send({ files: [file] }),
      await as(request(server).post('/api/v1/shares')).send({ agent_id: 'bruce', session_id: theirs, refs: [{ path: `media/api-${theirs}/f.png` }] }),
      await as(request(server).get(`/api/v1/agents/bruce/sessions/${theirs}/info`)).query({ chat_id: 'web' }),
      await as(request(server).get('/api/v1/agents/bruce/chats/api-web/messages')).query({ session_id: theirs }),
      await as(request(server).get(`/api/v1/agents/bruce/media/api-${theirs}/f.png`)),
    ]) {
      expect([res.status, res.body.error]).toEqual([403, "API key has no access to agent 'bruce'"]);
    }
  });
});
