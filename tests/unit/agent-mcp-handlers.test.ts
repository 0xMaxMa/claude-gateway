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
// Mock lib/pairing (writeTelegramAccess / writeDiscordAccess used directly)
// ---------------------------------------------------------------------------

import * as pairingLib from '../../lib/pairing';

jest.mock('../../lib/pairing', () => ({
  writeTelegramAccess: jest.fn(),
  writeDiscordAccess: jest.fn(),
}));

const mockWriteTelegramAccess = pairingLib.writeTelegramAccess as jest.MockedFunction<typeof pairingLib.writeTelegramAccess>;
const mockWriteDiscordAccess = pairingLib.writeDiscordAccess as jest.MockedFunction<typeof pairingLib.writeDiscordAccess>;

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
  mockWriteTelegramAccess.mockReset();
  mockWriteDiscordAccess.mockReset();
  // Real writeTelegramAccess / writeDiscordAccess behaviour — write actual files
  mockWriteTelegramAccess.mockImplementation((stateDir: string, senderId: string) => {
    fs.writeFileSync(
      path.join(stateDir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [senderId], groups: {}, pending: {} }, null, 2),
      { mode: 0o600 },
    );
  });
  mockWriteDiscordAccess.mockImplementation((stateDir: string, senderId: string) => {
    fs.writeFileSync(
      path.join(stateDir, 'access.json'),
      JSON.stringify({ dmPolicy: 'allowlist', allowFrom: [senderId], guildAllowlist: [], channelAllowlist: [], roleAllowlist: [], pending: {} }, null, 2) + '\n',
      { mode: 0o600 },
    );
  });
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
  it('AMH-01: creates workspace files, .env, access.json (empty allowFrom), and updates config.json', async () => {
    mockTelegramOk('mybot');

    const result = await createAgent({
      id: 'myagent',
      description: 'A test agent',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
    });

    expect(result).toContain('myagent');
    expect(result).toContain('@mybot');

    // Config updated
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    const agent = cfg.agents.find((a: { id: string }) => a.id === 'myagent');
    expect(agent).toBeDefined();
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

    // access.json written with empty allowFrom (no user_id provided)
    const stateDir = path.join(wsDir, '.telegram-state');
    const access = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    expect(access.dmPolicy).toBe('allowlist');
    expect(access.allowFrom).toEqual([]);
    expect(result).toContain('No user_id provided');
  });

  it('AMH-01b: creates access.json with allowFrom when telegram_user_id is provided', async () => {
    mockTelegramOk('mybot');

    await createAgent({
      id: 'myagent2',
      description: 'A test agent',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      telegram_user_id: '99000000',
    });

    const wsDir = path.join(tmpDir, 'agents', 'myagent2', 'workspace');
    const stateDir = path.join(wsDir, '.telegram-state');
    expect(mockWriteTelegramAccess).toHaveBeenCalledWith(stateDir, '99000000');
    const access = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    expect(access.allowFrom).toEqual(['99000000']);
  });

  it('AMH-01c: does NOT use telegram_user_id for discord channel (isolation test)', async () => {
    mockDiscordOk('discordbot');

    await createAgent({
      id: 'dcagent-iso',
      description: 'Isolation test',
      channel: 'discord',
      bot_token: VALID_DC_TOKEN,
      telegram_user_id: '99000000',
    });

    const wsDir = path.join(tmpDir, 'agents', 'dcagent-iso', 'workspace');
    const stateDir = path.join(wsDir, '.discord-state');
    expect(mockWriteDiscordAccess).not.toHaveBeenCalled();
    const access = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    expect(access.allowFrom).toEqual([]);
  });
});

describe('createAgent — Discord happy path', () => {
  it('AMH-02: creates discord state dir with access.json (empty allowFrom) and .env', async () => {
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
    // token lives in agent root .env, not inside the state dir
    expect(fs.existsSync(path.join(stateDir, '.env'))).toBe(false);
    // access.json written with empty allowFrom (no user_id)
    const access = JSON.parse(fs.readFileSync(path.join(stateDir, 'access.json'), 'utf8'));
    expect(access.dmPolicy).toBe('allowlist');
    expect(access.allowFrom).toEqual([]);
  });

  it('AMH-02b: creates access.json with allowFrom when discord_user_id is provided', async () => {
    mockDiscordOk('discordbot');

    await createAgent({
      id: 'dcagent2',
      description: 'A discord agent',
      channel: 'discord',
      bot_token: VALID_DC_TOKEN,
      discord_user_id: '123456789012345678',
    });

    const wsDir = path.join(tmpDir, 'agents', 'dcagent2', 'workspace');
    const stateDir = path.join(wsDir, '.discord-state');
    expect(mockWriteDiscordAccess).toHaveBeenCalledWith(stateDir, '123456789012345678');
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
// createAgent — code-fence stripping (issue #271)
// ---------------------------------------------------------------------------

describe('createAgent — agents_md code-fence stripping', () => {
  function descOf(id: string): string {
    const cfg = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    return cfg.agents.find((a: { id: string }) => a.id === id).description;
  }
  function agentsMd(id: string): string {
    const wsDir = path.join(tmpDir, 'agents', id, 'workspace');
    return fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8');
  }

  it('AMH-fence-a: fenced agents_md → clean file + clean description', async () => {
    mockTelegramOk();
    await createAgent({
      id: 'fenced',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: '```markdown\n# Agent: Foo\n\nBar baz\n```',
    });

    expect(agentsMd('fenced')).toBe('# Agent: Foo\n\nBar baz');
    expect(agentsMd('fenced')).not.toContain('```');
    expect(descOf('fenced')).toBe('Agent: Foo');
  });

  it('AMH-fence-b: unfenced agents_md → written unchanged (no regression)', async () => {
    mockTelegramOk();
    const raw = '# Agent: Foo\n\nBar';
    await createAgent({
      id: 'plain',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: raw,
    });

    expect(agentsMd('plain')).toBe(raw);
    expect(descOf('plain')).toBe('Agent: Foo');
  });

  it('AMH-fence-c: inner code block preserved when outer wrapper stripped', async () => {
    mockTelegramOk();
    await createAgent({
      id: 'inner',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: '```markdown\n# Agent: Foo\n\n```ts\nx();\n```\n```',
    });

    const written = agentsMd('inner');
    // Outer wrapper gone…
    expect(written.startsWith('# Agent: Foo')).toBe(true);
    // …but the inner fenced snippet survives intact.
    expect(written).toContain('```ts\nx();\n```');
    expect(descOf('inner')).toBe('Agent: Foo');
  });

  it('AMH-fence-d: opener without matching closer → left untouched (fail-safe)', async () => {
    mockTelegramOk();
    const raw = '```markdown\n# Agent: Foo';
    await createAgent({
      id: 'partial',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: raw,
    });

    // No closing fence → not a clean wrapper → file kept verbatim…
    expect(agentsMd('partial')).toBe(raw);
    // …but the description still skips the stray fence line (layer-2 hardening).
    expect(descOf('partial')).toBe('Agent: Foo');
  });

  it('AMH-fence-e: bare ``` opener/closer is stripped', async () => {
    mockTelegramOk();
    await createAgent({
      id: 'bare',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: '```\n# Agent: Foo\n```',
    });

    expect(agentsMd('bare')).toBe('# Agent: Foo');
    expect(descOf('bare')).toBe('Agent: Foo');
  });

  it('AMH-fence-f: soul_md / user_md wrappers are also stripped', async () => {
    mockTelegramOk();
    await createAgent({
      id: 'soulfence',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      soul_md: '```markdown\nSoul body\n```',
      user_md: '```md\nUser body\n```',
    });

    const wsDir = path.join(tmpDir, 'agents', 'soulfence', 'workspace');
    expect(fs.readFileSync(path.join(wsDir, 'SOUL.md'), 'utf8')).toBe('Soul body');
    expect(fs.readFileSync(path.join(wsDir, 'USER.md'), 'utf8')).toBe('User body');
  });

  it('AMH-fence-g: two-block false-positive (F2) — locks the accepted limitation', async () => {
    mockTelegramOk();
    // Content that legitimately OPENS with one fenced block and CLOSES with a
    // different one is indistinguishable from a single outer wrapper at the line
    // level, so its outer fences are peeled. This test pins that accepted
    // behavior (see stripOuterCodeFence F2 note). Real AGENTS.md opens with a
    // heading, so this shape does not occur in practice.
    await createAgent({
      id: 'twoblock',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: '```ts\na();\n```\n\nprose\n\n```ts\nb();\n```',
    });

    // Outer fence lines are removed; the middle survives verbatim.
    expect(agentsMd('twoblock')).toBe('a();\n```\n\nprose\n\n```ts\nb();');
  });

  it('AMH-fence-h: CRLF line endings + trailing spaces on fence lines → still stripped', async () => {
    mockTelegramOk();
    // A generator may emit \r\n and/or pad the fence line with spaces. .trim()
    // in the scanner normalizes both, so the wrapper is still recognized.
    await createAgent({
      id: 'crlf',
      description: 'x',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: '```markdown  \r\n# Agent: Foo\r\n\r\nBar\r\n```  \r\n',
    });

    const written = agentsMd('crlf');
    expect(written.startsWith('# Agent: Foo')).toBe(true);
    expect(written).not.toMatch(/```/);
    expect(descOf('crlf')).toBe('Agent: Foo');
  });

  it('AMH-fence-i: agents_md: null (malformed MCP input) → default stub, no throw', async () => {
    mockTelegramOk();
    // createAgent receives args cast from `unknown` (external MCP JSON), so a
    // caller can send `agents_md: null`. The typeof guard must fall back to the
    // default stub rather than reach stripOuterCodeFence and throw on .split.
    await createAgent({
      id: 'nullmd',
      description: 'A null agent.',
      channel: 'telegram',
      bot_token: VALID_TG_TOKEN,
      agents_md: null,
    } as unknown as Parameters<typeof createAgent>[0]);

    expect(agentsMd('nullmd')).toBe('# Agent: Nullmd\n\nA null agent.');
    expect(descOf('nullmd')).toBe('Agent: Nullmd');
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
      agent.telegram = { botToken: '${EXISTING_BOT_TOKEN}' };
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
    // token lives in agent root .env, not inside the state dir
    expect(fs.existsSync(path.join(stateDir, '.env'))).toBe(false);
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
      telegram: { botToken: '${MYAGENT_BOT_TOKEN}' },
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
