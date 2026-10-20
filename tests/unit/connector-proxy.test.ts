/**
 * #635 — connector secrets stay in the gateway behind the loopback MCP proxy.
 *
 *  agent-facing files   — managed connector files never hold the secret
 *  parity               — a real MCP SDK client (the transport lazy-connector.ts and
 *                         Claude Code use) works end to end through the proxy:
 *                         pagination, SSE progress, large payloads, tool errors
 *  boundary             — grant, connector binding, revocation, header/URL pinning
 *  live config          — rotation, disconnect and disable take effect mid-session
 *  launched connectors  — stdio and SSE connectors (secrets in env/args/headers), and
 *                         placeholders outside url/headers, keep their secrets out of
 *                         every agent-readable file and behave as before
 *  legacy containers    — an app-agent's container launches through a workspace socket
 *  exposure reporting   — only connectors the gateway cannot carry are reported
 */
import * as fs from 'fs';
import * as http from 'http';
import * as os from 'os';
import * as path from 'path';
import type { AddressInfo } from 'net';
import express from 'express';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { createConnectorProxyRouter, agentFacingConnectors, handleConnectorUpgrade, revokeConnectorGrant, setConnectorProxyOrigin } from '../../src/connectors/proxy';
import { prepareContainerLaunch } from '../../src/session/container-connectors';
import { prepareManagedConnectors } from '../../src/session/managed-connectors';
import { listConnectorStatus } from '../../src/connectors/resolve';
import type { AgentConfig, GatewayConfig } from '../../src/types';

// The legacy-container tests stand in for `docker` with a host script (see below).
let mockDocker: string | undefined;
jest.mock('child_process', () => {
  const actual = jest.requireActual('child_process');
  return { ...actual, spawn: (command: string, ...rest: unknown[]) => actual.spawn(command === 'docker' && mockDocker ? mockDocker : command, ...rest) };
});

const SECRET = 'sk-live-635-secret';
const BIG = 'x'.repeat(2 * 1024 * 1024);
const sdk = (file: string): string => JSON.stringify(require.resolve(`@modelcontextprotocol/sdk/${file}`).replace('/dist/cjs/', '/dist/esm/'));
/** A stdio MCP server that reports what it was started with, like a real one that
 * reads its key from env or argv. */
const STDIO_FIXTURE = `
import { Server } from ${sdk('server/index.js')};
import { StdioServerTransport } from ${sdk('server/stdio.js')};
import { CallToolRequestSchema, ListToolsRequestSchema } from ${sdk('types.js')};
const server = new Server({ name: 'stdio-fixture', version: '1' }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: 'whoami', description: 'whoami', inputSchema: { type: 'object' } }] }));
server.setRequestHandler(CallToolRequestSchema, async req => ({ content: [{ type: 'text', text: JSON.stringify({
  key: process.env.KEY ?? null, argv: process.argv.slice(2), cwd: process.cwd(), inherited: process.env.FROM_AGENT ?? null, echo: req.params.arguments ?? {},
}) }] }));
await server.connect(new StdioServerTransport());
`;

let tmpDir: string;
let tokenEnv: string;
let upstream: http.Server;
let upstreamUrl: string;
let gateway: http.Server;
let gatewayUrl: string;
let seen: Array<{ method?: string; url?: string; headers: http.IncomingHttpHeaders }>;
let fixture: string;
let upstreamMode: 'mcp' | 'redirect' | 'error' | 'reset' | 'not-modified' | 'slow';

function mcpServer(): Server {
  const server = new Server({ name: 'fixture-upstream', version: '1' }, { capabilities: { tools: {} } });
  const tools = ['echo', 'big', 'progress', 'fail'].map(name => ({ name, description: name, inputSchema: { type: 'object' as const } }));
  // Two pages, so a client that drops `nextCursor` would miss tools.
  server.setRequestHandler(ListToolsRequestSchema, async req =>
    req.params?.cursor === 'page-2' ? { tools: tools.slice(2) } : { tools: tools.slice(0, 2), nextCursor: 'page-2' });
  server.setRequestHandler(CallToolRequestSchema, async (req, extra) => {
    const args = req.params.arguments ?? {};
    if (req.params.name === 'echo') return { content: [{ type: 'text', text: JSON.stringify(args) }] };
    if (req.params.name === 'big') return { content: [{ type: 'text', text: `${String(args.payload ?? '').length}:${BIG}` }] };
    if (req.params.name === 'progress') {
      const token = req.params._meta?.progressToken;
      for (let i = 1; i <= 3; i++) {
        if (token !== undefined) await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: token, progress: i, total: 3 } });
      }
      return { content: [{ type: 'text', text: 'done' }] };
    }
    return { isError: true, content: [{ type: 'text', text: 'upstream refused' }] };
  });
  return server;
}

beforeAll(async () => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'connector-proxy-'));
  tokenEnv = path.join(tmpDir, 'mcp-token.env');
  process.env.GATEWAY_MCP_TOKEN_ENV_PATH = tokenEnv;

  const sseSessions = new Map<string, SSEServerTransport>();
  upstream = http.createServer(async (req, res) => {
    seen.push({ method: req.method, url: req.url, headers: req.headers });
    if (req.url?.startsWith('/sse') || req.url?.startsWith('/messages')) {
      if (req.headers.authorization !== `Bearer ${currentSecret()}`) { res.writeHead(401).end('bad credential'); return; }
      if (req.method === 'GET') {
        const transport = new SSEServerTransport('/messages', res);
        sseSessions.set(transport.sessionId, transport);
        res.on('close', () => sseSessions.delete(transport.sessionId));
        await mcpServer().connect(transport);
        return;
      }
      const transport = sseSessions.get(new URL(req.url, 'http://x').searchParams.get('sessionId') ?? '');
      if (!transport) { res.writeHead(404).end(); return; }
      await transport.handlePostMessage(req, res);
      return;
    }
    if (upstreamMode === 'redirect') { res.writeHead(302, { location: 'https://attacker.invalid/collect' }).end(); return; }
    if (upstreamMode === 'not-modified') { res.writeHead(304).end(); return; }
    if (upstreamMode === 'slow') { setTimeout(() => res.writeHead(200).end('late'), 300); return; }
    if (upstreamMode === 'reset') {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write('event: message\ndata: {"partial":true}\n\n');
      setTimeout(() => res.socket?.destroy(), 20);
      return;
    }
    if (upstreamMode === 'error') { res.writeHead(500, { 'content-type': 'text/plain' }).end('upstream exploded'); return; }
    if (req.headers.authorization !== `Bearer ${currentSecret()}`) { res.writeHead(401).end('bad credential'); return; }
    // Stateless, SSE responses (enableJsonResponse off): every POST streams.
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    const server = mcpServer();
    res.on('close', () => { void transport.close(); void server.close(); });
    await server.connect(transport);
    await transport.handleRequest(req, res);
  });
  await new Promise<void>(r => upstream.listen(0, '127.0.0.1', r));
  upstreamUrl = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}/mcp?tenant=fixture`;

  const app = express();
  app.use(createConnectorProxyRouter());
  app.use(express.json());
  gateway = app.listen(0, '127.0.0.1');
  gateway.on('upgrade', (req, socket, head) => { if (!handleConnectorUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>(r => gateway.once('listening', r));
  fixture = path.join(tmpDir, 'stdio-fixture.mjs');
  fs.writeFileSync(fixture, STDIO_FIXTURE);
  gatewayUrl = `http://127.0.0.1:${(gateway.address() as AddressInfo).port}`;
  process.env.GATEWAY_API_URL = gatewayUrl;
});

afterAll(async () => {
  delete process.env.GATEWAY_MCP_TOKEN_ENV_PATH;
  delete process.env.GATEWAY_API_URL;
  await new Promise(r => upstream.close(r));
  await new Promise(r => gateway.close(r));
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

let secretValue = SECRET;
function currentSecret(): string { return secretValue; }
function setSecret(value: string | undefined): void {
  secretValue = value ?? '';
  fs.writeFileSync(tokenEnv, value ? `CUSTOM__ops__api_key=${value}\n` : '', { mode: 0o600 });
}

function gatewayConfig(): GatewayConfig {
  return {
    gateway: {
      customConnectors: {
        ops: {
          label: 'Ops API',
          config: { type: 'http', url: upstreamUrl, headers: { Authorization: 'Bearer {api_key}' }, disabled_tools: ['never'] },
          secretNames: ['api_key'],
          credentialOwner: 'static',
        },
        other: {
          label: 'Other',
          config: { type: 'http', url: upstreamUrl, headers: { Authorization: 'Bearer {other_key}' } },
          secretNames: ['other_key'],
          credentialOwner: 'static',
        },
      },
    },
  } as unknown as GatewayConfig;
}

function agent(overrides: Partial<AgentConfig> = {}): AgentConfig {
  return { id: 'alpha', workspace: tmpDir, connectors: {}, ...overrides } as AgentConfig;
}

/** What the agent's process sees: the managed connector file for `ops`. */
function managedOps(a = agent(), g = gatewayConfig()) {
  const ticket = path.join(tmpDir, `ticket-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(ticket, '{"mcpServers":{}}');
  const paths = new Set<string>();
  const out = prepareManagedConnectors(a, g, { role: 'worker', hostExecution: true, mcpConfigPath: ticket, overlay: '', context: '' } as any, paths);
  const file = (out.servers.ops as { args: string[] }).args[1];
  return { ...out, file, config: JSON.parse(fs.readFileSync(file, 'utf8')), paths, gateway: g, agent: a };
}

/** Connects exactly the way mcp/lazy-connector.ts does for an http entry. */
async function connect(config: { url: string; headers: Record<string, string> }): Promise<Client> {
  const client = new Client({ name: 'parity', version: '1' });
  await client.connect(new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } }), { timeout: 10000 });
  return client;
}

function rpc(url: string, token: string, extraHeaders: Record<string, string> = {}): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', ...extraHeaders },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
  });
}

beforeEach(() => {
  seen = [];
  upstreamMode = 'mcp';
  setSecret(SECRET);
});

describe('agent-facing connector files', () => {
  it('never contain the connector secret, only a loopback proxy entry', () => {
    const { file, config, grant, paths } = managedOps();
    const onDisk = [...paths].map(p => fs.readFileSync(p, 'utf8')).join('\n');
    expect(onDisk).not.toContain(SECRET);
    expect(fs.readFileSync(file, 'utf8')).not.toContain(SECRET);
    expect(config).toEqual({
      type: 'http',
      url: `${gatewayUrl}/internal/mcp/connectors/ops`,
      headers: { Authorization: `Bearer ${grant}` },
      // Non-secret fields lazy-connector.ts reads survive the rewrite.
      disabled_tools: ['never'],
    });
    revokeConnectorGrant(grant);
  });

  it('keeps resolved entries in memory for restart fingerprints', () => {
    const { connectors, grant } = managedOps();
    expect((connectors.ops as { headers: Record<string, string> }).headers.Authorization).toBe(`Bearer ${SECRET}`);
    revokeConnectorGrant(grant);
  });

  it('leaves only connectors the gateway cannot carry as they were', () => {
    const g = gatewayConfig();
    g.gateway.customConnectors = {
      open: { label: 'Open', config: { type: 'http', url: upstreamUrl }, secretNames: [], credentialOwner: 'none' },
      helper: { label: 'Helper', config: { type: 'http', url: upstreamUrl, headersHelper: 'print-headers {key}' }, secretNames: ['key'], credentialOwner: 'static' },
      elsewhere: { label: 'Elsewhere', config: { type: 'http', url: upstreamUrl, oauth: { clientId: '{key}' } }, secretNames: ['key'], credentialOwner: 'static' },
      socket: { label: 'Socket', config: { type: 'ws', url: 'wss://example.invalid/{key}' }, secretNames: ['key'], credentialOwner: 'static' },
    } as any;
    const resolved = {
      open: { type: 'http', url: upstreamUrl },
      helper: { type: 'http', url: upstreamUrl, headersHelper: 'print-headers k' },
      elsewhere: { type: 'http', url: upstreamUrl, oauth: { clientId: 'k' } },
      socket: { type: 'ws', url: 'wss://example.invalid/k' },
    };
    const { servers, grant } = agentFacingConnectors(agent(), g, resolved);
    expect(servers).toEqual(resolved);
    expect(grant).toBeUndefined();
  });
});

describe('behavior parity through the proxy', () => {
  it('lists every page, calls tools, streams progress, carries large payloads and tool errors', async () => {
    const { config, grant } = managedOps();
    const client = await connect(config);
    try {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        names.push(...page.tools.map(t => t.name));
        cursor = page.nextCursor;
      } while (cursor);
      expect(names).toEqual(['echo', 'big', 'progress', 'fail']);

      const echo = await client.callTool({ name: 'echo', arguments: { q: 'ไทย ✓' } });
      expect((echo.content as any)[0].text).toBe('{"q":"ไทย ✓"}');

      const progress: number[] = [];
      const done = await client.callTool({ name: 'progress', arguments: {} }, undefined, { onprogress: p => { progress.push(p.progress); } });
      expect((done.content as any)[0].text).toBe('done');
      expect(progress).toEqual([1, 2, 3]);

      const big = await client.callTool({ name: 'big', arguments: { payload: BIG } });
      expect((big.content as any)[0].text).toBe(`${BIG.length}:${BIG}`);

      const failed = await client.callTool({ name: 'fail', arguments: {} });
      expect(failed.isError).toBe(true);
      expect((failed.content as any)[0].text).toBe('upstream refused');
    } finally {
      await client.close();
      revokeConnectorGrant(grant);
    }
    // The upstream saw the real credential at its configured URL, query and all.
    expect(seen.length).toBeGreaterThan(0);
    for (const req of seen) {
      expect(req.headers.authorization).toBe(`Bearer ${SECRET}`);
      expect(req.url).toBe('/mcp?tenant=fixture');
    }
  });

  it('passes upstream HTTP errors through with their status', async () => {
    const { config, grant } = managedOps();
    upstreamMode = 'error';
    const res = await rpc(config.url, grant!);
    expect(res.status).toBe(500);
    expect(await res.text()).toBe('upstream exploded');
    revokeConnectorGrant(grant);
  });
  // An upstream that dies mid-stream must cost one call, not the gateway process.
  it('survives an upstream connection reset mid-response', async () => {
    const { config, grant } = managedOps();
    upstreamMode = 'reset';
    const res = await rpc(config.url, grant!);
    expect(res.status).toBe(200);
    await res.text().catch(() => undefined);
    upstreamMode = 'mcp';
    expect((await rpc(config.url, grant!)).status).toBe(200);
    revokeConnectorGrant(grant);
  });
});

describe('proxy boundary', () => {
  it('rejects a missing or unknown grant without reaching upstream', async () => {
    const url = `${gatewayUrl}/internal/mcp/connectors/ops`;
    expect((await fetch(url, { method: 'POST' })).status).toBe(401);
    expect((await rpc(url, 'not-a-grant')).status).toBe(401);
    expect(seen).toHaveLength(0);
  });

  it('binds a grant to the connectors it was minted for', async () => {
    const { grant } = managedOps();
    expect((await rpc(`${gatewayUrl}/internal/mcp/connectors/other`, grant!)).status).toBe(403);
    expect((await rpc(`${gatewayUrl}/internal/mcp/connectors/constructor`, grant!)).status).toBe(403);
    expect(seen).toHaveLength(0);
    revokeConnectorGrant(grant);
  });

  it('does not let another agent reach a connector enabled only for this one', async () => {
    fs.writeFileSync(tokenEnv, `CUSTOM__ops__api_key=${SECRET}\nCUSTOM__other__other_key=other\n`);
    const own = managedOps(agent({ id: 'alpha' }));
    const g = gatewayConfig();
    const beta = agent({ id: 'beta', connectors: { ops: { enabled: false } } });
    const { servers, grant } = agentFacingConnectors(beta, g, { other: { type: 'http', url: upstreamUrl, headers: { Authorization: 'Bearer other' } } });
    expect(Object.keys(servers)).toEqual(['other']);
    expect((await rpc(own.config.url, grant!)).status).toBe(403);
    expect(seen).toHaveLength(0);
    revokeConnectorGrant(own.grant);
    revokeConnectorGrant(grant);
  });

  it('pins the upstream credential, URL and headers to the connector config', async () => {
    const { config, grant } = managedOps();
    const res = await fetch(`${config.url}?redirect=https://attacker.invalid`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${grant}`,
        'content-type': 'application/json',
        accept: 'application/json, text/event-stream',
        'x-forwarded-host': 'attacker.invalid',
        'x-injected': '1',
        cookie: 'session=stolen',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }),
    });
    expect(res.status).toBe(200);
    await res.text();
    expect(seen).toHaveLength(1);
    expect(seen[0].url).toBe('/mcp?tenant=fixture');
    expect(seen[0].headers.authorization).toBe(`Bearer ${SECRET}`);
    expect(seen[0].headers['x-injected']).toBeUndefined();
    expect(seen[0].headers['x-forwarded-host']).toBeUndefined();
    expect(seen[0].headers.cookie).toBeUndefined();
    revokeConnectorGrant(grant);
  });

  it('refuses an upstream redirect instead of following it with the credential', async () => {
    const { config, grant } = managedOps();
    upstreamMode = 'redirect';
    const res = await rpc(config.url, grant!);
    expect(res.status).toBe(502);
    expect(res.headers.get('location')).toBeNull();
    expect(seen).toHaveLength(1);
    revokeConnectorGrant(grant);
  });

  it('refuses a request a same-host reverse proxy forwarded', async () => {
    const { config, grant } = managedOps();
    expect((await rpc(config.url, grant!, { 'x-forwarded-for': '203.0.113.7' })).status).toBe(403);
    expect((await rpc(config.url, grant!, { forwarded: 'for=203.0.113.7' })).status).toBe(403);
    expect(seen).toHaveLength(0);
    revokeConnectorGrant(grant);
  });

  it('passes a 3xx without Location through instead of treating it as a redirect', async () => {
    const { config, grant } = managedOps();
    upstreamMode = 'not-modified';
    expect((await rpc(config.url, grant!)).status).toBe(304);
    revokeConnectorGrant(grant);
  });

  it('does not report an agent-cancelled call as an upstream failure', async () => {
    const { config, grant } = managedOps();
    upstreamMode = 'slow';
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const abort = new AbortController();
      setTimeout(() => abort.abort(), 50);
      await expect(fetch(config.url, { method: 'POST', headers: { authorization: `Bearer ${grant}` }, body: '{}', signal: abort.signal })).rejects.toThrow();
      await new Promise(r => setTimeout(r, 400));
      expect(errors.mock.calls.filter(c => String(c[0]).includes('connector-proxy'))).toEqual([]);
    } finally {
      errors.mockRestore();
      revokeConnectorGrant(grant);
    }
  });

  it('logs a resolved entry it cannot use instead of failing silently', async () => {
    const m = managedOps();
    (m.gateway.gateway.customConnectors as any).ops.config.headers = { Authorization: 42 };
    const errors = jest.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect((await rpc(m.config.url, m.grant!)).status).toBe(403);
      expect(errors.mock.calls.some(c => String(c[0]).includes('connector=ops has no usable http url/headers'))).toBe(true);
    } finally {
      errors.mockRestore();
      revokeConnectorGrant(m.grant);
    }
  });

  it('fails closed once the grant is revoked', async () => {
    const { config, grant } = managedOps();
    expect((await rpc(config.url, grant!)).status).toBe(200);
    revokeConnectorGrant(grant);
    seen = [];
    expect((await rpc(config.url, grant!)).status).toBe(401);
    expect(seen).toHaveLength(0);
  });
});

describe('proxy origin', () => {
  afterEach(() => setConnectorProxyOrigin(undefined));
  it('points entries at the address the gateway actually listens on', () => {
    for (const [address, family, expected] of [
      ['0.0.0.0', 'IPv4', 'http://127.0.0.1:4100'],
      ['::', 'IPv6', 'http://127.0.0.1:4100'],
      ['10.0.0.5', 'IPv4', 'http://10.0.0.5:4100'],
      ['::1', 'IPv6', 'http://[::1]:4100'],
      // The planned bind, set before the server listens.
      ['localhost', 'IPv4', 'http://localhost:4100'],
      ['', 'IPv4', 'http://127.0.0.1:4100'],
    ] as const) {
      setConnectorProxyOrigin({ address, family, port: 4100 });
      const { config, grant } = managedOps();
      expect(config.url).toBe(`${expected}/internal/mcp/connectors/ops`);
      revokeConnectorGrant(grant);
    }
  });
});

describe('live connector state', () => {
  it('uses a rotated secret on the next call without rewriting the agent file', async () => {
    const { config, file, grant } = managedOps();
    const before = fs.readFileSync(file, 'utf8');
    setSecret('sk-rotated-635');
    expect((await rpc(config.url, grant!)).status).toBe(200);
    expect(seen[0].headers.authorization).toBe('Bearer sk-rotated-635');
    expect(fs.readFileSync(file, 'utf8')).toBe(before);
    revokeConnectorGrant(grant);
  });

  it('fails closed mid-session when the connector is disconnected, disabled on the live config, or removed', async () => {
    const m = managedOps();
    setSecret(undefined);
    expect((await rpc(m.config.url, m.grant!)).status).toBe(403);
    setSecret(SECRET);
    expect((await rpc(m.config.url, m.grant!)).status).toBe(200);
    m.agent.connectors = { ops: { enabled: false } };
    expect((await rpc(m.config.url, m.grant!)).status).toBe(403);
    m.agent.connectors = {};
    delete (m.gateway.gateway.customConnectors as Record<string, unknown>).ops;
    expect((await rpc(m.config.url, m.grant!)).status).toBe(403);
    revokeConnectorGrant(m.grant);
  });
});

const STDIO_SECRET = 'stdio-secret-635';
const SSE_SECRET_HEADER = SECRET;

function launchedGateway(): GatewayConfig {
  const g = gatewayConfig();
  Object.assign(g.gateway.customConnectors!, {
    local: {
      label: 'Local',
      config: { command: process.execPath, args: [fixture, '--token', '{key}'], env: { KEY: '{key}' }, enabled_tools: ['whoami'] },
      secretNames: ['key'],
      credentialOwner: 'static',
    },
    legacy: {
      label: 'Legacy SSE',
      config: { type: 'sse', url: upstreamUrl.replace('/mcp?tenant=fixture', '/sse'), headers: { Authorization: 'Bearer {api_key}' } },
      secretNames: ['api_key'],
      credentialOwner: 'static',
    },
    // A placeholder outside url/headers that no HTTP transport reads.
    mixed: {
      label: 'Mixed',
      config: { type: 'http', url: upstreamUrl, headers: { Authorization: 'Bearer {api_key}' }, env: { API_KEY: '{api_key}' } },
      secretNames: ['api_key'],
      credentialOwner: 'static',
    },
  });
  return g;
}

function writeSecrets(): void {
  fs.writeFileSync(tokenEnv, [`CUSTOM__ops__api_key=${SECRET}`, `CUSTOM__local__key=${STDIO_SECRET}`, `CUSTOM__legacy__api_key=${SECRET}`, `CUSTOM__mixed__api_key=${SECRET}`].join('\n') + '\n', { mode: 0o600 });
}

/** The managed connector files a worker gets, keyed by connector id. */
function managedFiles(g: GatewayConfig, a = agent()) {
  const ticket = path.join(tmpDir, `ticket-${Math.random().toString(36).slice(2)}.json`);
  fs.writeFileSync(ticket, '{"mcpServers":{}}');
  const paths = new Set<string>();
  const out = prepareManagedConnectors(a, g, { role: 'worker', hostExecution: true, mcpConfigPath: ticket, overlay: '', context: '' } as any, paths);
  const files = Object.fromEntries(Object.entries(out.servers).map(([id, server]) => [id, (server as { args: string[] }).args[1]]));
  return { ...out, files, paths };
}

/** Starts an entry exactly the way mcp/lazy-connector.ts does. */
async function connectEntry(config: Record<string, any>, extraEnv: Record<string, string> = {}): Promise<Client> {
  const client = new Client({ name: 'parity', version: '1' });
  const transport = config.command
    ? new StdioClientTransport({ command: config.command, args: config.args, env: { ...process.env, ...extraEnv, ...config.env } as Record<string, string>, cwd: config.cwd, stderr: 'pipe' })
    : new StreamableHTTPClientTransport(new URL(config.url), { requestInit: { headers: config.headers } });
  await client.connect(transport, { timeout: 15000 });
  return client;
}

async function whoami(client: Client): Promise<any> {
  const result = await client.callTool({ name: 'whoami', arguments: { q: 'ไทย' } });
  return JSON.parse((result.content as any)[0].text);
}

describe('launched connectors (stdio, SSE, placeholders outside url/headers)', () => {
  beforeEach(writeSecrets);

  it('never write a stdio, SSE or mixed connector secret into an agent-readable file', () => {
    const { files, paths, grant } = managedFiles(launchedGateway());
    const onDisk = [...paths].map(p => fs.readFileSync(p, 'utf8')).join('\n');
    expect(onDisk).not.toContain(SECRET);
    expect(onDisk).not.toContain(STDIO_SECRET);
    const local = JSON.parse(fs.readFileSync(files.local, 'utf8'));
    expect(local).toEqual({
      command: process.execPath,
      args: [path.resolve(__dirname, '../../mcp/connector-launcher.mjs')],
      env: { GATEWAY_CONNECTOR_URL: `${gatewayUrl}/internal/mcp/connectors/local/stdio`, GATEWAY_CONNECTOR_GRANT: grant },
      enabled_tools: ['whoami'],
    });
    expect(JSON.parse(fs.readFileSync(files.legacy, 'utf8')).env.GATEWAY_CONNECTOR_URL).toBe(`${gatewayUrl}/internal/mcp/connectors/legacy/stdio`);
    // The mixed HTTP entry still uses the HTTP proxy; its unused env is left out.
    expect(JSON.parse(fs.readFileSync(files.mixed, 'utf8'))).toEqual({ type: 'http', url: `${gatewayUrl}/internal/mcp/connectors/mixed`, headers: { Authorization: `Bearer ${grant}` } });
    revokeConnectorGrant(grant);
  });

  it('starts a stdio server with its secret env and args, the agent env and cwd, as Claude Code would', async () => {
    const { files, grant } = managedFiles(launchedGateway());
    const client = await connectEntry(JSON.parse(fs.readFileSync(files.local, 'utf8')), { FROM_AGENT: 'yes' });
    try {
      expect((await client.listTools()).tools.map(t => t.name)).toEqual(['whoami']);
      expect(await whoami(client)).toEqual({ key: STDIO_SECRET, argv: ['--token', STDIO_SECRET], cwd: process.cwd(), inherited: 'yes', echo: { q: 'ไทย' } });
    } finally {
      await client.close();
      revokeConnectorGrant(grant);
    }
  });

  it('carries an SSE connector, its credential header included, through the bridge', async () => {
    const { files, grant } = managedFiles(launchedGateway());
    const client = await connectEntry(JSON.parse(fs.readFileSync(files.legacy, 'utf8')));
    try {
      const names: string[] = [];
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : {});
        names.push(...page.tools.map(t => t.name));
        cursor = page.nextCursor;
      } while (cursor);
      expect(names).toEqual(['echo', 'big', 'progress', 'fail']);
      const echo = await client.callTool({ name: 'echo', arguments: { q: 'ไทย ✓' } });
      expect((echo.content as any)[0].text).toBe('{"q":"ไทย ✓"}');
      const big = await client.callTool({ name: 'big', arguments: { payload: 'abc' } });
      expect((big.content as any)[0].text).toBe(`3:${BIG}`);
      const failed = await client.callTool({ name: 'fail', arguments: {} });
      expect(failed.isError).toBe(true);
    } finally {
      await client.close();
      revokeConnectorGrant(grant);
    }
    const sse = seen.filter(r => r.url?.startsWith('/sse') || r.url?.startsWith('/messages'));
    expect(sse.length).toBeGreaterThan(1);
    for (const req of sse) expect(req.headers.authorization).toBe(`Bearer ${SSE_SECRET_HEADER}`);
  });

  it('refuses a launch without a valid grant, for another connector, or once disconnected', async () => {
    const { files, grant } = managedFiles(launchedGateway());
    const entry = JSON.parse(fs.readFileSync(files.local, 'utf8'));
    await expect(connectEntry({ ...entry, env: { ...entry.env, GATEWAY_CONNECTOR_GRANT: 'not-a-grant' } })).rejects.toThrow();
    await expect(connectEntry({ ...entry, env: { ...entry.env, GATEWAY_CONNECTOR_URL: `${gatewayUrl}/internal/mcp/connectors/other/stdio` } })).rejects.toThrow();
    fs.writeFileSync(tokenEnv, `CUSTOM__ops__api_key=${SECRET}\n`);
    await expect(connectEntry(entry)).rejects.toThrow();
    // The HTTP proxy route does not serve a launched connector either.
    expect((await rpc(`${gatewayUrl}/internal/mcp/connectors/local`, grant!)).status).toBe(403);
    revokeConnectorGrant(grant);
  });

  it('stops a running server when its grant is revoked', async () => {
    const { files, grant } = managedFiles(launchedGateway());
    const client = await connectEntry(JSON.parse(fs.readFileSync(files.local, 'utf8')));
    const closed = new Promise<void>(r => { client.onclose = () => r(); });
    expect((await whoami(client)).key).toBe(STDIO_SECRET);
    revokeConnectorGrant(grant);
    await closed;
  });
});

describe('legacy app-agent containers', () => {
  let workspace: string;
  let bin: string;

  beforeAll(() => {
    // A stand-in `docker` that runs `exec` on this host with /workspace mapped onto
    // the agent workspace: the same commands, paths and stdio a container gets.
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-'));
    bin = fs.mkdtempSync(path.join(os.tmpdir(), 'docker-bin-'));
    fs.writeFileSync(path.join(bin, 'docker'), `#!/usr/bin/env node
const { spawnSync } = require('child_process');
const map = v => v.startsWith('/workspace') ? ${JSON.stringify(workspace)} + v.slice('/workspace'.length) : v;
const a = process.argv.slice(2); let i = 1; let cwd = process.cwd();
while (a[i].startsWith('-')) { if (a[i] === '--workdir') cwd = map(a[i + 1]); i += ['-i'].includes(a[i]) ? 1 : 2; }
const r = spawnSync(map(a[i + 1]) === 'node' ? process.execPath : a[i + 1], a.slice(i + 2).map(map), { stdio: 'inherit', cwd });
process.exit(r.status ?? 1);
`, { mode: 0o755 });
    mockDocker = path.join(bin, 'docker');
  });
  afterAll(() => {
    mockDocker = undefined;
    fs.rmSync(workspace, { recursive: true, force: true });
    fs.rmSync(bin, { recursive: true, force: true });
  });
  beforeEach(writeSecrets);

  it('launches through a workspace socket, with no secret in any workspace file', async () => {
    const g = launchedGateway();
    const launch = await prepareContainerLaunch('app-container', workspace, g.gateway.customConnectors);
    expect(launch).toEqual({ container: 'app-container', hostDir: path.join(workspace, '.gateway-connectors'), containerDir: '/workspace/.gateway-connectors', bridgeCode: expect.any(String) });
    // Only the launcher, which never sees a secret, is put where the agent can edit it.
    expect(fs.readdirSync(launch!.hostDir)).toEqual(['connector-launcher.mjs']);
    const resolved = { local: { command: process.execPath, args: [fixture, '--token', STDIO_SECRET], env: { KEY: STDIO_SECRET } }, ops: { type: 'http', url: upstreamUrl, headers: { Authorization: `Bearer ${SECRET}` } } };
    const { servers, grant } = agentFacingConnectors(agent({ workspace }), g, resolved, { container: launch });
    const config = path.join(workspace, 'mcp-config.json');
    fs.writeFileSync(config, JSON.stringify({ mcpServers: servers }));
    const local = servers.local as any;
    expect(local.command).toBe('node');
    expect(local.args).toEqual(['/workspace/.gateway-connectors/connector-launcher.mjs']);
    expect(local.env.GATEWAY_CONNECTOR_SOCKET).toMatch(/^\/workspace\/\.gateway-connectors\/[0-9a-f]{12}\.sock$/);
    // HTTP connectors launch too: the container cannot reach the loopback proxy.
    expect((servers.ops as any).env.GATEWAY_CONNECTOR_PATH).toBe('/internal/mcp/connectors/ops/stdio');
    const socketFile = path.join(workspace, local.env.GATEWAY_CONNECTOR_SOCKET.slice('/workspace/'.length));
    await new Promise(r => setTimeout(r, 50));
    expect(fs.statSync(socketFile).mode & 0o777).toBe(0o600);

    // As the container's CLI would start them, with /workspace mapped.
    const map = (v: string): string => v.replace(/^\/workspace/, workspace);
    const inContainer = (e: any) => ({ ...e, command: process.execPath, args: e.args.map(map), env: { ...e.env, GATEWAY_CONNECTOR_SOCKET: map(e.env.GATEWAY_CONNECTOR_SOCKET) } });
    const stdio = await connectEntry(inContainer(local));
    const http = await connectEntry(inContainer(servers.ops));
    try {
      expect((await whoami(stdio)).key).toBe(STDIO_SECRET);
      const echo = await http.callTool({ name: 'echo', arguments: { q: 1 } });
      expect((echo.content as any)[0].text).toBe('{"q":1}');
    } finally {
      await stdio.close();
      await http.close();
      revokeConnectorGrant(grant);
    }
    const files = fs.readdirSync(workspace, { recursive: true }).map(f => path.join(workspace, String(f))).filter(f => fs.statSync(f).isFile());
    for (const file of files) {
      const text = fs.readFileSync(file, 'utf8');
      expect(text).not.toContain(STDIO_SECRET);
      expect(text).not.toContain(SECRET);
    }
    // Revoking closes the socket.
    expect(fs.existsSync(socketFile)).toBe(false);
  }, 60000);

  it('keeps the resolved entries when the container cannot run the launcher', async () => {
    const fake = mockDocker;
    // A container without Node: the probe's `node` fails.
    const noNode = path.join(bin, 'docker-no-node');
    fs.writeFileSync(noNode, '#!/bin/sh\necho "exec: node: not found" >&2\nexit 127\n', { mode: 0o755 });
    mockDocker = noNode;
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      expect(await prepareContainerLaunch('app-container', workspace, launchedGateway().gateway.customConnectors)).toBeUndefined();
      expect(warn.mock.calls.some(c => String(c[0]).includes('keep their resolved entries'))).toBe(true);
    } finally {
      warn.mockRestore();
      mockDocker = fake;
    }
  }, 60000);
});

describe('secret exposure reporting', () => {
  it('flags only connectors whose secret is still written to an agent-readable file', () => {
    fs.writeFileSync(tokenEnv, 'CUSTOM__local__key=k\nCUSTOM__legacy__key=k\nCUSTOM__ops__api_key=k\n');
    const status = listConnectorStatus({
      ops: { label: 'Ops', config: { type: 'http', url: upstreamUrl, headers: { Authorization: 'Bearer {api_key}' } }, secretNames: ['api_key'], credentialOwner: 'static' },
      local: { label: 'Local', config: { command: 'fixture', env: { KEY: '{key}' } }, secretNames: ['key'], credentialOwner: 'static' },
      legacy: { label: 'Legacy SSE', config: { type: 'sse', url: upstreamUrl, headers: { Authorization: '{key}' } }, secretNames: ['key'], credentialOwner: 'static' },
      plain: { label: 'Plain', config: { command: 'fixture' }, secretNames: [], credentialOwner: 'none' },
      alias: { label: 'Alias', config: { type: 'streamable-http', url: upstreamUrl, headers: { Authorization: '{key}' } }, secretNames: ['key'], credentialOwner: 'static' },
      mixed: { label: 'Mixed', config: { type: 'http', url: upstreamUrl, env: { KEY: '{key}' } }, secretNames: ['key'], credentialOwner: 'static' },
      // Only Claude Code can act on these fields, so the entry is still written resolved.
      elsewhere: { label: 'Elsewhere', config: { type: 'http', url: upstreamUrl, oauth: { clientId: '{key}' } }, secretNames: ['key'], credentialOwner: 'static' },
      helper: { label: 'Helper', config: { type: 'http', url: upstreamUrl, headersHelper: 'print {key}' }, secretNames: ['key'], credentialOwner: 'static' },
    } as any);
    const exposure = Object.fromEntries(status.map(s => [s.id, s.secretExposure]));
    expect(exposure).toEqual({ ops: undefined, local: undefined, legacy: undefined, plain: undefined, alias: undefined, mixed: undefined, elsewhere: 'agent-readable', helper: 'agent-readable' });
  });
});
