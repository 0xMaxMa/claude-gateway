import express from 'express';
import * as http from 'http';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createApiRouter } from '../../src/api/router';
import { runCli } from '../../src/cli';
import { AgentConfig, ApiKey } from '../../src/types';

/**
 * End-to-end CLI test for `channels pending|approve|deny` and `agents list` —
 * a real Express server mounting the actual agents/telegram/discord routes,
 * driven through runCli() → http-client, same style as tests/integration/cli-e2e.test.ts.
 * Proves the replacement for `make pair` and the read side of `agents` against
 * live server behavior, not a mock.
 */

const KEY = 'e2e-admin-key';
const AGENT_ID = 'alfred';
const apiKeys: ApiKey[] = [{ key: KEY, description: 'e2e', agents: '*', admin: true }];

let tmpDir: string;
let workspace: string;
let configPath: string;
let server: http.Server;
let baseUrl: string;
let stdout: string[];
let writeSpy: jest.SpyInstance;

function makeAgentConfig(): AgentConfig {
  return {
    id: AGENT_ID,
    description: 'Personal assistant',
    workspace,
    env: '',
    claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    telegram: { botToken: 'tg-token-123' },
    discord: { botToken: 'dc-token-123' },
  } as AgentConfig;
}

function writeTelegramAccess(obj: unknown): void {
  const dir = path.join(workspace, '.telegram-state');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'access.json'), JSON.stringify(obj));
}
function readTelegramAccessRaw(): { allowFrom: string[]; pending: Record<string, unknown> } {
  return JSON.parse(fs.readFileSync(path.join(workspace, '.telegram-state', 'access.json'), 'utf8'));
}

beforeAll((done) => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-cli-agents-e2e-'));
  workspace = path.join(tmpDir, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  configPath = path.join(tmpDir, 'config.json');
  const configs = new Map([[AGENT_ID, makeAgentConfig()]]);
  fs.writeFileSync(configPath, JSON.stringify({ gateway: { logDir: '~/logs', timezone: 'UTC' }, agents: [makeAgentConfig()] }, null, 2));

  const app = express();
  app.get('/health', (_req, res) => res.json({ status: 'ok' }));
  app.use(express.json());
  app.use('/api', createApiRouter(new Map(), configs, apiKeys, configPath));
  server = app.listen(0, () => {
    const addr = server.address();
    const port = typeof addr === 'object' && addr ? addr.port : 0;
    baseUrl = `http://127.0.0.1:${port}`;
    done();
  });
});

afterAll((done) => {
  server.close(() => done());
});

beforeEach(() => {
  stdout = [];
  writeSpy = jest.spyOn(process.stdout, 'write').mockImplementation((chunk: string | Uint8Array) => {
    stdout.push(chunk.toString());
    return true;
  });
});

afterEach(() => writeSpy.mockRestore());

const base = (extra: string[]) => ['--config', '/nonexistent-config.json', '--url', baseUrl, '--key', KEY, ...extra];

function lastJson(): unknown {
  return JSON.parse(stdout.join(''));
}

describe('cli e2e — channels (replaces `make pair`)', () => {
  beforeEach(() => {
    writeTelegramAccess({
      dmPolicy: 'allowlist',
      pairing: true,
      allowFrom: [],
      groupPolicy: 'allowlist',
      requireMention: true,
      groupAllowlist: [],
      pending: {
        abc123: { senderId: 's1', chatId: 'c1', createdAt: Date.now(), expiresAt: Date.now() + 60_000, kind: 'dm' },
      },
    });
  });

  it('`channels pending --agent X --channel telegram` lists the pending request', async () => {
    const code = await runCli(['channels', 'pending', ...base(['--agent', AGENT_ID, '--channel', 'telegram'])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ telegram: [expect.objectContaining({ code: 'abc123', senderId: 's1' })] });
  });

  it('`channels pending --agent X` (no --channel) queries every pairing channel', async () => {
    const code = await runCli(['channels', 'pending', ...base(['--agent', AGENT_ID])]);
    expect(code).toBe(0);
    const body = lastJson() as Record<string, unknown[]>;
    expect(body.telegram).toHaveLength(1);
    expect(body.discord).toEqual([]);
  });

  it('`channels approve` allowlists the sender and clears the pending code', async () => {
    const code = await runCli(['channels', 'approve', ...base(['--agent', AGENT_ID, '--channel', 'telegram', '--code', 'abc123'])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ ok: true, senderId: 's1' });
    const access = readTelegramAccessRaw();
    expect(access.allowFrom).toContain('s1');
    expect(access.pending['abc123']).toBeUndefined();
  });

  it('`channels deny` removes the pending code without allowlisting', async () => {
    const code = await runCli(['channels', 'deny', ...base(['--agent', AGENT_ID, '--channel', 'telegram', '--code', 'abc123'])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ ok: true });
    const access = readTelegramAccessRaw();
    expect(access.allowFrom).not.toContain('s1');
    expect(access.pending['abc123']).toBeUndefined();
  });

  it('missing --agent fails without calling the server', async () => {
    const code = await runCli(['channels', 'pending', '--config', '/nonexistent-config.json', '--url', baseUrl, '--key', KEY]);
    expect(code).toBe(1);
  });

  it('an invalid --channel is rejected', async () => {
    const code = await runCli(['channels', 'pending', ...base(['--agent', AGENT_ID, '--channel', 'whatsapp'])]);
    expect(code).toBe(1);
  });

  it('approving an unknown code 404s and exits non-zero', async () => {
    const code = await runCli(['channels', 'approve', ...base(['--agent', AGENT_ID, '--channel', 'telegram', '--code', 'nope'])]);
    expect(code).toBe(1);
  });
});

describe('cli e2e — agents list', () => {
  it('returns the seeded agent', async () => {
    const code = await runCli(['agents', 'list', ...base([])]);
    expect(code).toBe(0);
    expect(lastJson()).toEqual({ agents: [expect.objectContaining({ id: AGENT_ID, telegram_connected: true, discord_connected: true })] });
  });
});
