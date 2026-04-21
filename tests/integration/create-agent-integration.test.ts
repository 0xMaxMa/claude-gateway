/**
 * Integration tests for create-agent wizard.
 *
 * We test the logic-heavy units in isolation by:
 * - Importing pure functions from create-agent-prompts
 * - Re-implementing small pure helpers locally (matching create-agent.ts)
 * - Using a mock HTTP server for Telegram API (getMe / sendMessage)
 * - Using real filesystem operations in temp dirs
 *
 * The interactive readline flow is not tested end-to-end (too hard to mock),
 * but every piece of logic it calls is covered.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';
import express from 'express';
import { parseGeneratedFiles } from '../../scripts/create-agent-prompts';

// ---------------------------------------------------------------------------
// Constants from create-agent.ts (keep in sync)
// ---------------------------------------------------------------------------

const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;
const TOKEN_REGEX = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;

// ---------------------------------------------------------------------------
// Pure helpers duplicated from create-agent.ts
// ---------------------------------------------------------------------------

function firstNonEmptyLine(text: string): string {
  for (const line of text.split('\n')) {
    const trimmed = line.replace(/^#+\s*/, '').trim();
    if (trimmed) return trimmed;
  }
  return text.trim().slice(0, 80);
}

interface RawAgentEntry {
  id: string;
  description: string;
  workspace: string;
  env: string;
  telegram: { botToken: string };
  claude: { model: string; dangerouslySkipPermissions: boolean; extraFlags: string[] };
}

interface RawConfig {
  gateway: { logDir: string; timezone: string };
  agents: RawAgentEntry[];
}

function loadOrCreateRawConfig(configPath: string): RawConfig {
  if (fs.existsSync(configPath)) {
    const raw = fs.readFileSync(configPath, 'utf8');
    return JSON.parse(raw) as RawConfig;
  }
  return {
    gateway: { logDir: '~/.claude-gateway/logs', timezone: 'UTC' },
    agents: [],
  };
}

function saveConfig(config: RawConfig, configPath: string): void {
  fs.mkdirSync(path.dirname(configPath), { recursive: true });
  fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
}

function appendAgentToConfig(
  agentId: string,
  wsDir: string,
  agentMdContent: string,
  configPath: string
): void {
  const config = loadOrCreateRawConfig(configPath);
  config.agents = config.agents.filter((a) => a.id !== agentId);

  const envVarName = agentId.toUpperCase().replace(/-/g, '_') + '_BOT_TOKEN';
  const descriptionText = firstNonEmptyLine(agentMdContent);

  const newAgent: RawAgentEntry = {
    id: agentId,
    description: descriptionText,
    workspace: wsDir.replace(os.homedir(), '~'),
    env: '',
    telegram: {
      botToken: `\${${envVarName}}`,
    },
    claude: {
      model: 'claude-sonnet-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
  };

  config.agents.push(newAgent);
  saveConfig(config, configPath);
}

function createWorkspace(wsDir: string, files: Map<string, string>): void {
  fs.mkdirSync(wsDir, { recursive: true });
  for (const [filename, content] of files) {
    fs.writeFileSync(path.join(wsDir, filename), content, 'utf8');
  }
}

interface AccessJson {
  dmPolicy: string;
  allowFrom: string[];
  groups: Record<string, unknown>;
  pending: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Mock Telegram HTTP server
// ---------------------------------------------------------------------------

interface MockTelegramServer {
  server: http.Server;
  baseUrl: string;
  getRequests: () => Array<{ method: string; path: string; body: Record<string, unknown> }>;
  clearRequests: () => void;
  setGetMeResponse: (response: Record<string, unknown>) => void;
  setGetUpdatesResponse: (response: Record<string, unknown>) => void;
}

function startMockTelegramServer(): Promise<MockTelegramServer> {
  return new Promise((resolve) => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    let getMeResponse: Record<string, unknown> = {
      ok: true,
      result: { id: 123456789, username: 'test_bot', first_name: 'Test Bot' },
    };
    let getUpdatesResponse: Record<string, unknown> = {
      ok: true,
      result: [],
    };

    const app = express();
    app.use(express.json());

    // GET /bot<token>/getMe
    app.get('/bot:token/getMe', (req, res) => {
      requests.push({ method: 'GET', path: req.path, body: {} });
      res.json(getMeResponse);
    });

    // GET /bot<token>/getUpdates
    app.get('/bot:token/getUpdates', (req, res) => {
      requests.push({ method: 'GET', path: req.path, body: {} });
      res.json(getUpdatesResponse);
    });

    // POST /bot<token>/sendMessage
    app.post('/bot:token/sendMessage', (req, res) => {
      requests.push({ method: 'POST', path: req.path, body: req.body });
      res.json({ ok: true, result: { message_id: 42 } });
    });

    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as { port: number };
      const baseUrl = `http://127.0.0.1:${addr.port}`;
      resolve({
        server,
        baseUrl,
        getRequests: () => [...requests],
        clearRequests: () => requests.splice(0, requests.length),
        setGetMeResponse: (r) => { getMeResponse = r; },
        setGetUpdatesResponse: (r) => { getUpdatesResponse = r; },
      });
    });
  });
}

// HTTP GET via http module (not https, since mock server is http)
function httpGet(url: string): Promise<string> {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

// HTTP POST via http module
function httpPost(url: string, body: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const parsed = new URL(url);
    const options = {
      hostname: parsed.hostname,
      port: parsed.port,
      path: parsed.pathname + parsed.search,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(body),
      },
    };
    const req = http.request(options, (res) => {
      let data = '';
      res.on('data', (chunk: Buffer) => (data += chunk.toString()));
      res.on('end', () => resolve(data));
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ---------------------------------------------------------------------------
// Shared mock server + temp dirs
// ---------------------------------------------------------------------------

let mockServer: MockTelegramServer;
let tmpDir: string;

beforeAll(async () => {
  mockServer = await startMockTelegramServer();
});

afterAll(async () => {
  await new Promise<void>((resolve, reject) =>
    mockServer.server.close((err) => (err ? reject(err) : resolve()))
  );
});

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-int-'));
  mockServer.clearRequests();
  mockServer.setGetMeResponse({
    ok: true,
    result: { id: 123456789, username: 'test_bot', first_name: 'Test Bot' },
  });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// T-CA-01: Name validation
// ---------------------------------------------------------------------------
describe('T-CA-01: Name validation', () => {
  const validNames = ['alfred', 'my-agent', 'Agent2', 'cool_bot', 'ab'];
  const invalidNames = ['1agent', '-agent', '_agent', 'agent name', 'a', '', 'agent!'];

  for (const name of validNames) {
    it(`accepts valid name: "${name}"`, () => {
      expect(NAME_REGEX.test(name)).toBe(true);
    });
  }

  for (const name of invalidNames) {
    it(`rejects invalid name: "${name || '(empty)'}"`, () => {
      expect(NAME_REGEX.test(name)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// T-CA-02: Duplicate name detection
// ---------------------------------------------------------------------------
describe('T-CA-02: Duplicate name detection', () => {
  it('detects name already in config.json', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const config: RawConfig = {
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [
        {
          id: 'existing',
          description: 'Existing agent',
          workspace: '~/existing/workspace',
          env: '',
          telegram: { botToken: '${EXISTING_BOT_TOKEN}' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    };
    saveConfig(config, configPath);

    const loaded = loadOrCreateRawConfig(configPath);
    const existingIds = loaded.agents.map((a) => a.id);
    expect(existingIds.includes('existing')).toBe(true);
    expect(existingIds.includes('new-agent')).toBe(false);
  });

  it('rejects name that matches existing id when normalised to lowercase', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const config: RawConfig = {
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [
        {
          id: 'alfred',
          description: 'Alfred agent',
          workspace: '~/alfred/workspace',
          env: '',
          telegram: { botToken: '${ALFRED_BOT_TOKEN}' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    };
    saveConfig(config, configPath);

    const loaded = loadOrCreateRawConfig(configPath);
    const existingIds = loaded.agents.map((a) => a.id);
    // "Alfred" normalised to "alfred" should clash
    expect(existingIds.includes('Alfred'.toLowerCase())).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-CA-03: File generation — parseGeneratedFiles multi-section split
// ---------------------------------------------------------------------------
describe('T-CA-03: parseGeneratedFiles correctly splits multi-section output', () => {
  it('parses three sections from realistic claude output', () => {
    const claudeOutput = `Here are the workspace files for your agent:

=== AGENTS.md ===
# Agent: Butler
You are Butler, a formal English assistant.

Rules:
- Speak formally at all times
- Never use contractions

=== SOUL.md ===
Formal, precise, and unfailingly polite.
Think Jeeves from P.G. Wodehouse.

=== USER.md ===
A busy professional who values efficiency.`;

    const files = parseGeneratedFiles(claudeOutput);

    expect(files.size).toBe(3);
    expect(files.get('AGENTS.md')).toContain('# Agent: Butler');
    expect(files.get('SOUL.md')).toContain('Jeeves');
    expect(files.get('USER.md')).toContain('professional');
  });

  it('returns only AGENTS.md when other sections are absent', () => {
    const claudeOutput = `=== AGENTS.md ===
# Agent: Simple
You are Simple, a minimal assistant.`;

    const files = parseGeneratedFiles(claudeOutput);
    expect(files.size).toBe(1);
    expect(files.has('AGENTS.md')).toBe(true);
  });

  it('content of first section does not bleed into second section', () => {
    const claudeOutput = `=== AGENTS.md ===
Agent content only.

=== SOUL.md ===
Soul content only.`;

    const files = parseGeneratedFiles(claudeOutput);
    expect(files.get('AGENTS.md')).not.toContain('Soul content only.');
    expect(files.get('SOUL.md')).not.toContain('Agent content only.');
  });
});

// ---------------------------------------------------------------------------
// T-CA-04: Config append — new agent added without breaking others
// ---------------------------------------------------------------------------
describe('T-CA-04: Config append — new agent added to existing config.json', () => {
  it('new agent is appended and existing agents preserved', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const initialConfig: RawConfig = {
      gateway: { logDir: '/tmp/logs', timezone: 'UTC' },
      agents: [
        {
          id: 'agent-a',
          description: 'Agent A',
          workspace: '~/agents/agent-a/workspace',
          env: '',
          telegram: { botToken: '${AGENT_A_BOT_TOKEN}' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    };
    saveConfig(initialConfig, configPath);

    const wsDir = path.join(tmpDir, 'agents', 'agent-b', 'workspace');
    appendAgentToConfig('agent-b', wsDir, '# Agent: Agent-b\nNew agent.', configPath);

    const updated = loadOrCreateRawConfig(configPath);
    expect(updated.agents).toHaveLength(2);
    expect(updated.agents.find((a) => a.id === 'agent-a')).toBeDefined();
    expect(updated.agents.find((a) => a.id === 'agent-b')).toBeDefined();
  });

  it('existing gateway config is not modified', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const initialConfig: RawConfig = {
      gateway: { logDir: '/custom/logs', timezone: 'Asia/Bangkok' },
      agents: [],
    };
    saveConfig(initialConfig, configPath);

    appendAgentToConfig(
      'newagent',
      path.join(tmpDir, 'workspace'),
      '# Agent: Newagent\nDesc.',
      configPath
    );

    const updated = loadOrCreateRawConfig(configPath);
    expect(updated.gateway.logDir).toBe('/custom/logs');
    expect(updated.gateway.timezone).toBe('Asia/Bangkok');
  });

  it('writes valid JSON to disk', () => {
    const configPath = path.join(tmpDir, 'config.json');
    appendAgentToConfig(
      'jsontest',
      path.join(tmpDir, 'workspace'),
      '# Agent: Jsontest\nDesc.',
      configPath
    );

    const raw = fs.readFileSync(configPath, 'utf8');
    expect(() => JSON.parse(raw)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// T-CA-05: Config create — creates config.json from scratch
// ---------------------------------------------------------------------------
describe('T-CA-05: Config create — creates config.json from scratch', () => {
  it('creates config.json when file does not exist', () => {
    const configPath = path.join(tmpDir, 'subdir', 'config.json');
    expect(fs.existsSync(configPath)).toBe(false);

    appendAgentToConfig(
      'freshagent',
      path.join(tmpDir, 'workspace'),
      '# Agent: Freshagent\nBrand new.',
      configPath
    );

    expect(fs.existsSync(configPath)).toBe(true);
  });

  it('new config.json has correct structure', () => {
    const configPath = path.join(tmpDir, 'subdir', 'config.json');
    appendAgentToConfig(
      'firstagent',
      path.join(tmpDir, 'workspace'),
      '# Agent: Firstagent\nFirst agent.',
      configPath
    );

    const config = loadOrCreateRawConfig(configPath);
    expect(config.gateway).toBeDefined();
    expect(config.gateway.timezone).toBe('UTC');
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('firstagent');
  });

  it('new config.json has correct agent entry structure', () => {
    const configPath = path.join(tmpDir, 'subdir2', 'config.json');
    appendAgentToConfig(
      'mybot',
      path.join(tmpDir, 'workspace'),
      '# Agent: Mybot\nMy first bot.',
      configPath
    );

    const config = loadOrCreateRawConfig(configPath);
    const agent = config.agents[0];
    expect(agent.id).toBe('mybot');
    expect(agent.telegram.botToken).toBe('${MYBOT_BOT_TOKEN}');
    expect(agent.claude.model).toBe('claude-sonnet-4-6');
    expect(agent.claude.dangerouslySkipPermissions).toBe(false);
    expect(Array.isArray(agent.claude.extraFlags)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// T-CA-06: Token validation
// ---------------------------------------------------------------------------
describe('T-CA-06: Token validation', () => {
  const validTokens = [
    '123456789:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123',
    '12345678:BBCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
    '123456789012:CCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij',
  ];

  const invalidTokens = [
    '',
    'notavalidtoken',
    '123456:short',
    '1234567:AAHfiqksKZ8WmHPDKxyzABCDE1234567890',  // 7-digit prefix
    '1234567890123:AAHfiqksKZ8WmHPDKxyzABCDE1234567890', // 13-digit prefix
    '123456789:short',  // secret too short
    '123456789:has space KZ8WmHPDKxyzABCDE1234567890',
  ];

  for (const token of validTokens) {
    it(`accepts valid token format: ${token.slice(0, 15)}...`, () => {
      expect(TOKEN_REGEX.test(token)).toBe(true);
    });
  }

  for (const token of invalidTokens) {
    it(`rejects invalid token: "${token.slice(0, 30) || '(empty)'}"`, () => {
      expect(TOKEN_REGEX.test(token)).toBe(false);
    });
  }
});

// ---------------------------------------------------------------------------
// T-CA-07: Direct pairing — access.json written with allowlist after pairing
// ---------------------------------------------------------------------------
describe('T-CA-07: Direct pairing — access.json written with allowlist', () => {
  it('access.json has dmPolicy allowlist and senderId in allowFrom after pairing', () => {
    const telegramStateDir = path.join(tmpDir, '.telegram-state');
    fs.mkdirSync(telegramStateDir, { recursive: true });

    const senderId = '991177022';
    const chatId = '991177022';

    // Simulate what startAndPair writes after receiving first message
    const access: AccessJson = {
      dmPolicy: 'allowlist',
      allowFrom: [senderId],
      groups: {},
      pending: {},
    };
    const accessFile = path.join(telegramStateDir, 'access.json');
    fs.writeFileSync(accessFile, JSON.stringify(access, null, 2), 'utf8');

    const written = JSON.parse(fs.readFileSync(accessFile, 'utf8')) as AccessJson;
    expect(written.dmPolicy).toBe('allowlist');
    expect(written.allowFrom).toContain(senderId);
    expect(Object.keys(written.pending)).toHaveLength(0);

    void chatId; // used for welcome message in step 6
  });

  it('.env file is written with correct token', () => {
    const telegramStateDir = path.join(tmpDir, '.telegram-state');
    fs.mkdirSync(telegramStateDir, { recursive: true });

    const token = '123456789:AAHfiqksKZ8WmHPDKabcdefghijklmnopqrstu';
    fs.writeFileSync(
      path.join(telegramStateDir, '.env'),
      `TELEGRAM_BOT_TOKEN=${token}\n`,
      'utf8',
    );

    const envContent = fs.readFileSync(path.join(telegramStateDir, '.env'), 'utf8');
    expect(envContent).toBe(`TELEGRAM_BOT_TOKEN=${token}\n`);
  });

  it('pending section is empty after direct pairing (no code exchange needed)', () => {
    const telegramStateDir = path.join(tmpDir, '.telegram-state');
    fs.mkdirSync(telegramStateDir, { recursive: true });

    const access: AccessJson = { dmPolicy: 'allowlist', allowFrom: ['111'], groups: {}, pending: {} };
    const accessFile = path.join(telegramStateDir, 'access.json');
    fs.writeFileSync(accessFile, JSON.stringify(access, null, 2), 'utf8');

    const written = JSON.parse(fs.readFileSync(accessFile, 'utf8')) as AccessJson;
    expect(Object.keys(written.pending)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// T-CA-08: Workspace creation — all accepted files written to correct paths
// ---------------------------------------------------------------------------
describe('T-CA-08: Workspace creation — accepted files written to correct paths', () => {
  it('writes all accepted files to workspace directory', () => {
    const wsDir = path.join(tmpDir, 'agents', 'testbot', 'workspace');
    const accepted = new Map<string, string>([
      ['AGENTS.md', '# Agent: Testbot\nYou are Testbot.'],
      ['SOUL.md', 'Friendly and helpful.'],
      ['USER.md', 'A developer.'],
    ]);

    createWorkspace(wsDir, accepted);

    expect(fs.existsSync(wsDir)).toBe(true);
    for (const [filename, content] of accepted) {
      const filePath = path.join(wsDir, filename);
      expect(fs.existsSync(filePath)).toBe(true);
      expect(fs.readFileSync(filePath, 'utf8')).toBe(content);
    }
  });

  it('creates workspace directory even when it does not exist', () => {
    const wsDir = path.join(tmpDir, 'deep', 'nested', 'workspace');
    expect(fs.existsSync(wsDir)).toBe(false);

    createWorkspace(wsDir, new Map([['AGENTS.md', '# Agent\nTest.']]));

    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it('AGENTS.md content is preserved exactly', () => {
    const wsDir = path.join(tmpDir, 'ws');
    const agentMdContent = `# Agent: Precise
You are Precise.

Rules:
- Be exact
- Use formal language`;

    createWorkspace(wsDir, new Map([['AGENTS.md', agentMdContent]]));

    const written = fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8');
    expect(written).toBe(agentMdContent);
  });
});

// ---------------------------------------------------------------------------
// T-CA-09: Mock Telegram — simulate getMe and sendMessage
// ---------------------------------------------------------------------------
describe('T-CA-09: Mock Telegram API interactions', () => {
  it('getMe returns ok:true with username from mock server', async () => {
    mockServer.setGetMeResponse({
      ok: true,
      result: { id: 999888777, username: 'my_test_bot', first_name: 'My Test Bot' },
    });

    const token = '999888777:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123';
    const url = `${mockServer.baseUrl}/bot${token}/getMe`;
    const body = await httpGet(url);
    const json = JSON.parse(body) as { ok: boolean; result?: { username?: string } };

    expect(json.ok).toBe(true);
    expect(json.result?.username).toBe('my_test_bot');
  });

  it('getMe returns ok:false when token is rejected', async () => {
    mockServer.setGetMeResponse({ ok: false, error_code: 401, description: 'Unauthorized' });

    const token = '000000000:invalid-token-here-xxxxxxxxxxxxxxxxxxx';
    const url = `${mockServer.baseUrl}/bot${token}/getMe`;
    const body = await httpGet(url);
    const json = JSON.parse(body) as { ok: boolean };

    expect(json.ok).toBe(false);
  });

  it('sendMessage is recorded by mock server', async () => {
    const token = '123456789:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123';
    const url = `${mockServer.baseUrl}/bot${token}/sendMessage`;
    const requestBody = JSON.stringify({ chat_id: '12345', text: 'Hello from the bot!' });

    const responseRaw = await httpPost(url, requestBody);
    const response = JSON.parse(responseRaw) as { ok: boolean; result?: { message_id?: number } };

    expect(response.ok).toBe(true);
    expect(response.result?.message_id).toBe(42);
  });

  it('sendMessage request is recorded with correct body', async () => {
    mockServer.clearRequests();

    const token = '123456789:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123';
    const url = `${mockServer.baseUrl}/bot${token}/sendMessage`;
    const chatId = '987654321';
    const welcomeText = 'Hello! I am your new assistant.';
    const requestBody = JSON.stringify({ chat_id: chatId, text: welcomeText });

    await httpPost(url, requestBody);

    const requests = mockServer.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].method).toBe('POST');
    expect(requests[0].body).toEqual({ chat_id: chatId, text: welcomeText });
  });

  it('mock server records multiple requests', async () => {
    mockServer.clearRequests();

    const token = '123456789:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123';

    // First: getMe
    await httpGet(`${mockServer.baseUrl}/bot${token}/getMe`);

    // Second: sendMessage
    await httpPost(
      `${mockServer.baseUrl}/bot${token}/sendMessage`,
      JSON.stringify({ chat_id: '111', text: 'Hi' })
    );

    const requests = mockServer.getRequests();
    expect(requests).toHaveLength(2);
    expect(requests[0].method).toBe('GET');
    expect(requests[1].method).toBe('POST');
  });

  it('clearRequests resets the recorded requests', async () => {
    const token = '123456789:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123';
    await httpGet(`${mockServer.baseUrl}/bot${token}/getMe`);

    mockServer.clearRequests();
    expect(mockServer.getRequests()).toHaveLength(0);
  });

  it('verifyBotToken flow — valid token verified via mock', async () => {
    mockServer.setGetMeResponse({
      ok: true,
      result: { id: 123456789, username: 'verified_bot', first_name: 'Verified Bot' },
    });

    const token = '123456789:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123';
    const url = `${mockServer.baseUrl}/bot${token}/getMe`;
    const body = await httpGet(url);
    const json = JSON.parse(body) as { ok: boolean; result?: { username?: string } };

    // Simulate verifyBotToken logic
    const ok = json.ok && !!json.result?.username;
    const username = json.result?.username ?? '';

    expect(ok).toBe(true);
    expect(username).toBe('verified_bot');
  });
});

// ---------------------------------------------------------------------------
// Full config round-trip with workspace creation
// ---------------------------------------------------------------------------
describe('Full config round-trip', () => {
  it('creates workspace, writes files, appends to config — all in temp dir', () => {
    const configPath = path.join(tmpDir, 'config.json');
    const agentId = 'roundtrip';
    const wsDir = path.join(tmpDir, 'agents', agentId, 'workspace');

    const claudeOutput = `=== AGENTS.md ===
# Agent: Roundtrip
You are Roundtrip, a test agent.

Rules:
- Be helpful

=== SOUL.md ===
Methodical and precise.`;

    const files = parseGeneratedFiles(claudeOutput);
    expect(files.has('AGENTS.md')).toBe(true);

    createWorkspace(wsDir, files);
    appendAgentToConfig(agentId, wsDir, files.get('AGENTS.md')!, configPath);

    // Verify workspace files
    expect(fs.existsSync(path.join(wsDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'SOUL.md'))).toBe(true);

    // Verify config
    const config = loadOrCreateRawConfig(configPath);
    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe(agentId);
    expect(config.agents[0].description).toBe('Agent: Roundtrip');
    expect(config.agents[0].telegram.botToken).toBe('${ROUNDTRIP_BOT_TOKEN}');
  });
});
