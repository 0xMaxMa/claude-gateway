/**
 * Unit tests for mcp/tools/agent/handlers.ts
 *
 * createAgent and updateAgent are tested with a temp gateway dir so no real
 * filesystem state is touched.  Token verification is mocked via global fetch.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import {
  createAgent,
  updateAgent,
  NAME_REGEX,
  TELEGRAM_TOKEN_REGEX,
  DISCORD_TOKEN_REGEX,
} from '../../mcp/tools/agent/handlers';

// ---------------------------------------------------------------------------
// Mock global fetch (used by verifyTelegramToken / verifyDiscordToken)
// ---------------------------------------------------------------------------

const mockFetch = jest.fn();
global.fetch = mockFetch as unknown as typeof fetch;

function mockTelegramOk(username = 'testbot') {
  mockFetch.mockResolvedValueOnce({
    status: 200,
    json: async () => ({ ok: true, result: { username } }),
  } as Response);
}

function mockTelegramFail() {
  mockFetch.mockResolvedValueOnce({
    status: 200,
    json: async () => ({ ok: false }),
  } as Response);
}

function mockDiscordOk(username = 'discordbot') {
  mockFetch.mockResolvedValueOnce({
    status: 200,
    json: async () => ({ username }),
  } as Response);
}

function mockDiscordFail() {
  mockFetch.mockResolvedValueOnce({
    status: 401,
    json: async () => ({ message: 'Unauthorized' }),
  } as Response);
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const VALID_TG_TOKEN = '123456789:AAHfiqksKZ8WmHPDKxxxxxxxxxxxxxxxxxxxxx';
// Fake Discord-shaped token for tests — matches DISCORD_TOKEN_REGEX but not a real credential
const VALID_DC_TOKEN = 'AAAAAAAAAAAAAAAAAAAAAAAAx.AAAAAA.xxxxxxxxxxxxxxxxxxxxxxxxxxx';

// ---------------------------------------------------------------------------
// Test setup: temp gateway dir + config.json
// ---------------------------------------------------------------------------

let tmpDir: string;
let configFile: string;
const origGatewayConfig = process.env.GATEWAY_CONFIG;

function writeConfig(agents: unknown[] = []): void {
  fs.writeFileSync(
    configFile,
    JSON.stringify({ gateway: { logDir: '~/.claude-gateway/logs', timezone: 'UTC' }, agents }, null, 2),
    'utf8',
  );
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-mcp-test-'));
  configFile = path.join(tmpDir, 'config.json');
  writeConfig();
  process.env.GATEWAY_CONFIG = configFile;
  mockFetch.mockReset();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  if (origGatewayConfig === undefined) {
    delete process.env.GATEWAY_CONFIG;
  } else {
    process.env.GATEWAY_CONFIG = origGatewayConfig;
  }
});

// ---------------------------------------------------------------------------
// Regex constant tests
// ---------------------------------------------------------------------------

describe('NAME_REGEX', () => {
  it('accepts valid names', () => {
    expect(NAME_REGEX.test('myagent')).toBe(true);
    expect(NAME_REGEX.test('MyAgent')).toBe(true);
    expect(NAME_REGEX.test('my-agent')).toBe(true);
    expect(NAME_REGEX.test('my_agent')).toBe(true);
    expect(NAME_REGEX.test('Agent123')).toBe(true);
  });

  it('rejects single character (< 2 chars)', () => {
    expect(NAME_REGEX.test('a')).toBe(false);
  });

  it('rejects names starting with digit', () => {
    expect(NAME_REGEX.test('1agent')).toBe(false);
  });

  it('rejects names with spaces or special chars', () => {
    expect(NAME_REGEX.test('my agent')).toBe(false);
    expect(NAME_REGEX.test('my@agent')).toBe(false);
  });
});

describe('TELEGRAM_TOKEN_REGEX', () => {
  it('accepts valid telegram token', () => {
    expect(TELEGRAM_TOKEN_REGEX.test(VALID_TG_TOKEN)).toBe(true);
  });

  it('rejects discord token as telegram', () => {
    expect(TELEGRAM_TOKEN_REGEX.test(VALID_DC_TOKEN)).toBe(false);
  });

  it('rejects plain strings', () => {
    expect(TELEGRAM_TOKEN_REGEX.test('not-a-token')).toBe(false);
  });
});

describe('DISCORD_TOKEN_REGEX', () => {
  it('accepts valid discord token', () => {
    expect(DISCORD_TOKEN_REGEX.test(VALID_DC_TOKEN)).toBe(true);
  });

  it('rejects telegram token as discord', () => {
    expect(DISCORD_TOKEN_REGEX.test(VALID_TG_TOKEN)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createAgent — happy paths
// ---------------------------------------------------------------------------

describe('createAgent — Telegram happy path', () => {
  it('AMH-01: creates workspace files, .env, access.json, and updates config.json', async () => {
    mockTelegramOk('mybot');

    const result = await createAgent({
      id: 'myagent',
      description: 'A test agent',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      dm_policy: 'open',
    });

    expect(result).toContain('myagent');
    expect(result).toContain('@mybot');

    // Config updated
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const agent = cfg.agents.find((a: { id: string }) => a.id === 'myagent');
    expect(agent).toBeDefined();
    expect(agent.telegram.dmPolicy).toBe('open');
    expect(agent.telegram.botToken).toContain('MYAGENT_BOT_TOKEN');

    // Workspace files exist
    const wsDir = path.join(tmpDir, 'agents', 'myagent', 'workspace');
    expect(fs.existsSync(path.join(wsDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'MEMORY.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'HEARTBEAT.md'))).toBe(true);

    // .env file
    const envFile = path.join(tmpDir, 'agents', 'myagent', '.env');
    const envContent = fs.readFileSync(envFile, 'utf8');
    expect(envContent).toContain(`MYAGENT_BOT_TOKEN=${VALID_TG_TOKEN}`);

    // access.json
    const stateDir = path.join(wsDir, '.telegram-state');
    const access = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    expect(access.dmPolicy).toBe('open');
    expect(access.allowFrom).toEqual([]);
  });
});

describe('createAgent — Discord happy path', () => {
  it('AMH-02: creates discord state dir with access.json and .env', async () => {
    mockDiscordOk('discordbot');

    await createAgent({
      id: 'dcagent',
      description: 'A discord agent',
      channel: 'discord',
      bot_token: VALID_DC_TOKEN,
    });

    const wsDir = path.join(tmpDir, 'agents', 'dcagent', 'workspace');
    const stateDir = path.join(wsDir, '.discord-state');

    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, 'access.json'))).toBe(true);
    expect(fs.existsSync(path.join(stateDir, '.env'))).toBe(true);

    const stateEnv = fs.readFileSync(path.join(stateDir, '.env'), 'utf8');
    expect(stateEnv).toContain(`DISCORD_BOT_TOKEN=${VALID_DC_TOKEN}`);

    const access = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    expect(access.guildAllowlist).toEqual([]);
  });
});

describe('createAgent — optional fields', () => {
  it('AMH-03: writes agents_md, soul_md, user_md when provided', async () => {
    mockTelegramOk();

    await createAgent({
      id: 'richagent',
      description: 'A rich agent',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: '# Agent: Rich\n\nA rich agent.',
      soul_md: 'Soul content',
      user_md: 'User content',
      signature_emoji: '🎭',
    });

    const wsDir = path.join(tmpDir, 'agents', 'richagent', 'workspace');
    expect(fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8')).toBe('# Agent: Rich\n\nA rich agent.');
    expect(fs.readFileSync(path.join(wsDir, 'SOUL.md'), 'utf8')).toBe('Soul content');
    expect(fs.readFileSync(path.join(wsDir, 'USER.md'), 'utf8')).toBe('User content');

    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const agent = cfg.agents.find((a: { id: string }) => a.id === 'richagent');
    expect(agent.signatureEmoji).toBe('🎭');
  });
});

// ---------------------------------------------------------------------------
// createAgent — validation errors (no network calls expected)
// ---------------------------------------------------------------------------

describe('createAgent — validation errors', () => {
  it('AMH-04: rejects invalid agent id', async () => {
    await expect(createAgent({
      id: '1invalid',
      description: 'test',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    })).rejects.toThrow('Invalid agent id');
  });

  it('AMH-05: rejects empty description', async () => {
    await expect(createAgent({
      id: 'myagent',
      description: '   ',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    })).rejects.toThrow('description is required');
  });

  it('AMH-06: rejects invalid telegram token format', async () => {
    await expect(createAgent({
      id: 'myagent',
      description: 'test',
      channel: 'telegram',
      bot_token: 'not-a-token',
    })).rejects.toThrow('Invalid Telegram bot token format');
  });

  it('AMH-07: rejects invalid discord token format', async () => {
    await expect(createAgent({
      id: 'myagent',
      description: 'test',
      channel: 'discord',
      bot_token: 'not-a-discord-token',
    })).rejects.toThrow('Invalid Discord bot token format');
  });

  it('AMH-08: rejects duplicate agent id', async () => {
    writeConfig([{ id: 'existing', description: 'existing', workspace: '/tmp', env: '' }]);

    await expect(createAgent({
      id: 'existing',
      description: 'test',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    })).rejects.toThrow('already exists');
  });

  it('AMH-09: rejects when token verification fails', async () => {
    mockTelegramFail();

    await expect(createAgent({
      id: 'myagent',
      description: 'test',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    })).rejects.toThrow('Telegram token verification failed');
  });

  it('AMH-10: no files written when token verification fails (fail fast)', async () => {
    mockTelegramFail();

    await expect(createAgent({
      id: 'failagent',
      description: 'test',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    })).rejects.toThrow();

    const wsDir = path.join(tmpDir, 'agents', 'failagent', 'workspace');
    expect(fs.existsSync(wsDir)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateAgent — add_channel
// ---------------------------------------------------------------------------

describe('updateAgent — add_channel', () => {
  function writeAgentConfig(id: string, hasTelegram = false, hasDiscord = false) {
    const agent: Record<string, unknown> = {
      id,
      description: 'test',
      workspace: path.join(tmpDir, 'agents', id, 'workspace'),
      env: '',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    };
    if (hasTelegram) {
      agent.telegram = { botToken: '${EXISTING_BOT_TOKEN}', allowedUsers: [], dmPolicy: 'open' };
    }
    if (hasDiscord) {
      agent.discord = { botToken: '${EXISTING_DC_TOKEN}' };
    }
    writeConfig([agent]);
    fs.mkdirSync(agent.workspace as string, { recursive: true });
  }

  it('AMH-11: add_channel adds telegram to agent without telegram', async () => {
    writeAgentConfig('myagent');
    mockTelegramOk('newbot');

    const result = await updateAgent({
      id: 'myagent',
      action: 'add_channel',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    });

    expect(result).toContain('@newbot');

    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const agent = cfg.agents.find((a: { id: string }) => a.id === 'myagent');
    expect(agent.telegram).toBeDefined();
    expect(agent.telegram.botToken).toContain('MYAGENT_BOT_TOKEN');
  });

  it('AMH-12: add_channel rejects if telegram already configured', async () => {
    writeAgentConfig('myagent', true);

    await expect(updateAgent({
      id: 'myagent',
      action: 'add_channel',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    })).rejects.toThrow('already has a Telegram channel');
  });

  it('AMH-13: add_channel discord creates state dir and .env', async () => {
    writeAgentConfig('myagent');
    mockDiscordOk();

    await updateAgent({
      id: 'myagent',
      action: 'add_channel',
      channel: 'discord',
      bot_token: VALID_DC_TOKEN,
    });

    const stateDir = path.join(tmpDir, 'agents', 'myagent', 'workspace', '.discord-state');
    expect(fs.existsSync(stateDir)).toBe(true);
    expect(fs.existsSync(path.join(stateDir, '.env'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// updateAgent — remove_channel
// ---------------------------------------------------------------------------

describe('updateAgent — remove_channel', () => {
  it('AMH-14: remove_channel removes telegram state dir and config entry', async () => {
    const wsDir = path.join(tmpDir, 'agents', 'myagent', 'workspace');
    const stateDir = path.join(wsDir, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, 'access.json'), '{}');

    const envFile = path.join(tmpDir, 'agents', 'myagent', '.env');
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    fs.writeFileSync(envFile, 'MYAGENT_BOT_TOKEN=abc123\n');

    writeConfig([{
      id: 'myagent',
      description: 'test',
      workspace: wsDir,
      env: '',
      telegram: { botToken: '${MYAGENT_BOT_TOKEN}', allowedUsers: [], dmPolicy: 'open' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    }]);

    const result = await updateAgent({
      id: 'myagent',
      action: 'remove_channel',
      channel: 'telegram',
    });

    expect(result).toContain('removed');

    // State dir gone
    expect(fs.existsSync(stateDir)).toBe(false);

    // Config updated
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const agent = cfg.agents.find((a: { id: string }) => a.id === 'myagent');
    expect(agent.telegram).toBeUndefined();
  });

  it('AMH-15: remove_channel rejects when channel not configured', async () => {
    const wsDir = path.join(tmpDir, 'agents', 'myagent', 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    writeConfig([{
      id: 'myagent',
      description: 'test',
      workspace: wsDir,
      env: '',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    }]);

    await expect(updateAgent({
      id: 'myagent',
      action: 'remove_channel',
      channel: 'telegram',
    })).rejects.toThrow('does not have a Telegram channel');
  });
});

// ---------------------------------------------------------------------------
// updateAgent — update_workspace_file
// ---------------------------------------------------------------------------

describe('updateAgent — update_workspace_file', () => {
  function makeAgentWithWorkspace(id: string) {
    const wsDir = path.join(tmpDir, 'agents', id, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    writeConfig([{
      id,
      description: 'test',
      workspace: wsDir,
      env: '',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    }]);
    return wsDir;
  }

  it('AMH-16: update_workspace_file writes content to workspace', async () => {
    const wsDir = makeAgentWithWorkspace('myagent');

    const result = await updateAgent({
      id: 'myagent',
      action: 'update_workspace_file',
      filename: 'SOUL.md',
      content: 'New soul content',
    });

    expect(result).toContain('SOUL.md');
    expect(fs.readFileSync(path.join(wsDir, 'SOUL.md'), 'utf8')).toBe('New soul content');
  });

  it('AMH-17: update_workspace_file rejects path traversal in filename', async () => {
    makeAgentWithWorkspace('myagent');

    await expect(updateAgent({
      id: 'myagent',
      action: 'update_workspace_file',
      filename: '../../../etc/passwd',
      content: 'evil',
    })).rejects.toThrow('Invalid filename');
  });

  it('AMH-18: update_workspace_file rejects filenames with directory separators', async () => {
    makeAgentWithWorkspace('myagent');

    await expect(updateAgent({
      id: 'myagent',
      action: 'update_workspace_file',
      filename: 'subdir/SOUL.md',
      content: 'evil',
    })).rejects.toThrow('Invalid filename');
  });

  it('AMH-19: update_workspace_file rejects non-.md files', async () => {
    makeAgentWithWorkspace('myagent');

    await expect(updateAgent({
      id: 'myagent',
      action: 'update_workspace_file',
      filename: 'script.sh',
      content: 'evil',
    })).rejects.toThrow('Invalid filename');
  });
});

// ---------------------------------------------------------------------------
// updateAgent — unknown agent
// ---------------------------------------------------------------------------

describe('updateAgent — agent not found', () => {
  it('AMH-20: throws when agent id does not exist in config', async () => {
    await expect(updateAgent({
      id: 'notexist',
      action: 'update_workspace_file',
      filename: 'SOUL.md',
      content: 'x',
    })).rejects.toThrow('not found in config.json');
  });
});

// ---------------------------------------------------------------------------
// updateAgent — unknown action
// ---------------------------------------------------------------------------

describe('updateAgent — unknown action', () => {
  it('AMH-21: throws for unknown action', async () => {
    const wsDir = path.join(tmpDir, 'agents', 'myagent', 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });
    writeConfig([{
      id: 'myagent',
      description: 'test',
      workspace: wsDir,
      env: '',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    }]);

    await expect(updateAgent({
      id: 'myagent',
      action: 'unknown_action' as 'add_channel',
    })).rejects.toThrow('Unknown action');
  });
});
