/**
 * A project chat keeps working for its own agent: the real MCP server (api_reply, share_file) calls the gateway with
 * the API key the agent was handed, which here is a non-admin key, and the per-session token it was spawned with.
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
const KEYS: ApiKey[] = [
  { key: 'sk-agent-writer', agents: '*', write: true },
  { key: 'sk-admin', agents: '*', admin: true },
];
const A = '/api/v1/agents/alfred';

let base: string;
let runner: AgentRunner;
let server: import('http').Server;
let log: string;
const saved = { HOME: process.env.HOME, URL: process.env.GATEWAY_API_URL };

beforeAll(() => { process.env.CLAUDE_BIN = `node ${MOCK}`; });
afterAll(() => { delete process.env.CLAUDE_BIN; });

beforeEach(async () => {
  base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'project-chat-media-')));
  process.env.HOME = base;
  log = path.join(base, 'mcp.jsonl');
  process.env.MOCK_MCP_LOG = log;
  fs.mkdirSync(path.join(base, 'projects', 'site'), { recursive: true });
  const workspace = path.join(base, 'agents', 'alfred', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  fs.writeFileSync(path.join(workspace, 'CLAUDE.md'), '# Persona of alfred\n');
  const cfg: AgentConfig = { id: 'alfred', description: 'a', workspace, env: '', allow_tools: true, claude: { model: 'm', dangerouslySkipPermissions: true, extraFlags: [] } };
  const gateway: GatewayConfig = {
    gateway: { logDir: path.join(base, 'logs'), timezone: 'UTC', orchestration: false, publicUrl: 'https://gw.example', api: { keys: KEYS }, projects: { root: path.join(base, 'projects') } },
    agents: [cfg],
  };
  runner = new AgentRunner(cfg, gateway);
  const app = new GatewayRouter(new Map([['alfred', runner]]), new Map([['alfred', cfg]]), undefined, gateway, undefined, path.join(base, 'config.json')).getApp();
  server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  process.env.GATEWAY_API_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  server.closeAllConnections();
  server.close();
  await runner.stop().catch(() => {});
  delete process.env.MOCK_MCP_LOG;
  process.env.HOME = saved.HOME;
  if (saved.URL === undefined) delete process.env.GATEWAY_API_URL; else process.env.GATEWAY_API_URL = saved.URL;
  fs.rmSync(base, { recursive: true, force: true });
});

async function openChat(body: object): Promise<string> {
  const res = await request(server).post(`${A}/sessions`).query({ chat_id: 'web' }).set('Authorization', 'Bearer sk-admin').send(body);
  const id = res.body.sessionId as string;
  fs.mkdirSync(path.join(base, 'agents', 'alfred', 'media', `api-${id}`), { recursive: true });
  fs.writeFileSync(path.join(base, 'agents', 'alfred', 'media', `api-${id}`, 'f.png'), PNG);
  return id;
}

const toolLog = () => (fs.existsSync(log) ? fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);

describe.each([['a project chat', { project: 'site' }], ['a plain chat', {}]])('%s, through the real MCP tools with a non-admin agent key', (_n, body) => {
  it('attaches media and creates a share', async () => {
    const id = await openChat(body);
    const file = path.join(base, 'agents', 'alfred', 'media', `api-${id}`, 'f.png');
    const res = await request(server).post(`${A}/messages`).set('Authorization', 'Bearer sk-admin')
      .send({ message: `MCP-ATTACH:${file} MCP-SHARE:media/api-${id}/f.png`, chat_id: 'web', session_id: id });
    expect(JSON.stringify([res.status, res.body])).toMatch(/^\[200/);
    const calls = toolLog();
    expect(calls.filter((c) => c.tool || c.error).map((c) => [c.tool, c.result?.isError ?? false, c.error])).toEqual([['api_reply', false, undefined], ['share_file', false, undefined]]);
    expect(calls[1].result.content[0].text).toMatch(/"url": "https:\/\/gw\.example\/shared\//);
    expect(JSON.stringify(res.body.attachments ?? [])).toContain('f.png');
  }, 60_000);
});
