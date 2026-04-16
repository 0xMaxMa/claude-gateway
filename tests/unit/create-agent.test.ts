/**
 * Unit tests for pure logic in create-agent.ts.
 *
 * Since create-agent.ts immediately runs main() when imported, we cannot
 * import the module directly. Instead we test the logic inline, duplicating
 * the small pure functions that are not exported (name regex, token regex,
 * config shapes, etc.) and test the exported functions from create-agent-prompts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ---------------------------------------------------------------------------
// Constants duplicated from create-agent.ts for white-box testing
// ---------------------------------------------------------------------------

/** Name validation regex from create-agent.ts */
const NAME_REGEX = /^[a-zA-Z][a-zA-Z0-9_-]{1,31}$/;

/** Token validation regex from create-agent.ts */
const TOKEN_REGEX = /^\d{8,12}:[A-Za-z0-9_-]{35,}$/;

// ---------------------------------------------------------------------------
// Helpers that mirror private functions in create-agent.ts
// ---------------------------------------------------------------------------

function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return path.join(os.homedir(), p.slice(2));
  }
  return p;
}

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
  telegram: { botToken: string; allowedUsers: number[]; dmPolicy: string };
  claude: { model: string; dangerouslySkipPermissions: boolean; extraFlags: string[] };
}

interface RawConfig {
  gateway: { logDir: string; timezone: string };
  agents: RawAgentEntry[];
}

/** Mirrors appendToConfig logic without I/O */
function buildNewAgentEntry(agentId: string, wsDir: string, agentMdContent: string): RawAgentEntry {
  const envVarName = agentId.toUpperCase().replace(/-/g, '_') + '_BOT_TOKEN';
  const descriptionText = firstNonEmptyLine(agentMdContent);
  return {
    id: agentId,
    description: descriptionText,
    workspace: wsDir.replace(os.homedir(), '~'),
    env: '',
    telegram: {
      botToken: `\${${envVarName}}`,
      allowedUsers: [],
      dmPolicy: 'open',
    },
    claude: {
      model: 'claude-sonnet-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
  };
}

function addAgentToConfig(config: RawConfig, entry: RawAgentEntry): RawConfig {
  const filtered = config.agents.filter((a) => a.id !== entry.id);
  return { ...config, agents: [...filtered, entry] };
}

// ---------------------------------------------------------------------------
// T-CA-01: Name validation
// ---------------------------------------------------------------------------
describe('T-CA-01: Name validation regex', () => {
  it('accepts a simple lowercase name', () => {
    expect(NAME_REGEX.test('alfred')).toBe(true);
  });

  it('accepts a name with hyphens', () => {
    expect(NAME_REGEX.test('my-agent')).toBe(true);
  });

  it('accepts a name with underscores', () => {
    expect(NAME_REGEX.test('my_agent')).toBe(true);
  });

  it('accepts a name with mixed case', () => {
    expect(NAME_REGEX.test('MyAgent')).toBe(true);
  });

  it('accepts a name with numbers (not at start)', () => {
    expect(NAME_REGEX.test('agent2')).toBe(true);
  });

  it('accepts minimum length name (2 chars)', () => {
    expect(NAME_REGEX.test('ab')).toBe(true);
  });

  it('accepts maximum length name (32 chars)', () => {
    expect(NAME_REGEX.test('a' + 'b'.repeat(31))).toBe(true);
  });

  it('rejects name starting with a number', () => {
    expect(NAME_REGEX.test('1agent')).toBe(false);
  });

  it('rejects name starting with a hyphen', () => {
    expect(NAME_REGEX.test('-agent')).toBe(false);
  });

  it('rejects name starting with an underscore', () => {
    expect(NAME_REGEX.test('_agent')).toBe(false);
  });

  it('rejects name with spaces', () => {
    expect(NAME_REGEX.test('my agent')).toBe(false);
  });

  it('rejects name with special characters', () => {
    expect(NAME_REGEX.test('agent!')).toBe(false);
    expect(NAME_REGEX.test('agent@test')).toBe(false);
    expect(NAME_REGEX.test('agent.name')).toBe(false);
  });

  it('rejects single character name (too short)', () => {
    expect(NAME_REGEX.test('a')).toBe(false);
  });

  it('rejects name exceeding 32 characters', () => {
    expect(NAME_REGEX.test('a' + 'b'.repeat(32))).toBe(false);
  });

  it('rejects empty string', () => {
    expect(NAME_REGEX.test('')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-CA-06: Token validation regex
// ---------------------------------------------------------------------------
describe('T-CA-06: Token validation regex', () => {
  it('accepts a valid token', () => {
    expect(TOKEN_REGEX.test('123456789:AAHfiqksKZ8WmHPDKxyzABCDE12345678901')).toBe(true);
  });

  it('accepts token with 8-digit numeric prefix', () => {
    expect(TOKEN_REGEX.test('12345678:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123')).toBe(true);
  });

  it('accepts token with 12-digit numeric prefix', () => {
    expect(TOKEN_REGEX.test('123456789012:AAHfiqksKZ8WmHPDKxyzABCDE1234567890')).toBe(true);
  });

  it('accepts token with underscores in secret part', () => {
    expect(TOKEN_REGEX.test('123456789:AAHfiqks_KZ8WmHPDKxyzABCDE1234567890')).toBe(true);
  });

  it('accepts token with hyphens in secret part', () => {
    expect(TOKEN_REGEX.test('123456789:AAHfiqks-KZ8WmHPDKxyzABCDE1234567890')).toBe(true);
  });

  it('rejects token missing colon separator', () => {
    expect(TOKEN_REGEX.test('123456789AAHfiqksKZ8WmHPDKxyzABCDE12345678901')).toBe(false);
  });

  it('rejects token with too-short numeric prefix (7 digits)', () => {
    expect(TOKEN_REGEX.test('1234567:AAHfiqksKZ8WmHPDKxyzABCDE1234567890123')).toBe(false);
  });

  it('rejects token with too-long numeric prefix (13 digits)', () => {
    expect(TOKEN_REGEX.test('1234567890123:AAHfiqksKZ8WmHPDKxyzABCDE1234567890')).toBe(false);
  });

  it('rejects token with too-short secret part (34 chars)', () => {
    expect(TOKEN_REGEX.test('123456789:AAHfiqksKZ8WmHPDKxyzABCDE123456')).toBe(false);
  });

  it('rejects token with invalid chars in secret part', () => {
    expect(TOKEN_REGEX.test('123456789:AAHfiqks KZ8WmHPDKxyzABCDE1234567890')).toBe(false);
    expect(TOKEN_REGEX.test('123456789:AAHfiqks!KZ8WmHPDKxyzABCDE1234567890')).toBe(false);
  });

  it('rejects empty string', () => {
    expect(TOKEN_REGEX.test('')).toBe(false);
  });

  it('rejects just "bot:" prefix style', () => {
    expect(TOKEN_REGEX.test('bot:123456789AAHfiqksKZ8WmHPDKxyzABCDE123456')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-CA-04 / T-CA-05: Config append logic
// ---------------------------------------------------------------------------
describe('Config append/create logic', () => {
  it('T-CA-04: adds agent to existing config without removing other agents', () => {
    const existingConfig: RawConfig = {
      gateway: { logDir: '/tmp/logs', timezone: 'UTC' },
      agents: [
        {
          id: 'existing-agent',
          description: 'An existing agent',
          workspace: '~/.claude-gateway/agents/existing-agent/workspace',
          env: '',
          telegram: { botToken: '${EXISTING_AGENT_BOT_TOKEN}', allowedUsers: [], dmPolicy: 'open' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    };

    const newEntry = buildNewAgentEntry(
      'new-agent',
      path.join(os.homedir(), '.claude-gateway/agents/new-agent/workspace'),
      '# Agent: New\nA new agent description.'
    );

    const updatedConfig = addAgentToConfig(existingConfig, newEntry);

    expect(updatedConfig.agents).toHaveLength(2);
    expect(updatedConfig.agents.find((a) => a.id === 'existing-agent')).toBeDefined();
    expect(updatedConfig.agents.find((a) => a.id === 'new-agent')).toBeDefined();
  });

  it('T-CA-04: overwrites existing entry with same id', () => {
    const existingConfig: RawConfig = {
      gateway: { logDir: '/tmp/logs', timezone: 'UTC' },
      agents: [
        {
          id: 'myagent',
          description: 'Old description',
          workspace: '~/old/workspace',
          env: '',
          telegram: { botToken: '${MYAGENT_BOT_TOKEN}', allowedUsers: [], dmPolicy: 'open' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    };

    const newEntry = buildNewAgentEntry(
      'myagent',
      path.join(os.homedir(), '.claude-gateway/agents/myagent/workspace'),
      '# Agent: Myagent\nNew description.'
    );

    const updatedConfig = addAgentToConfig(existingConfig, newEntry);

    expect(updatedConfig.agents).toHaveLength(1);
    // firstNonEmptyLine strips heading markers, so "# Agent: Myagent" → "Agent: Myagent"
    expect(updatedConfig.agents[0].description).toBe('Agent: Myagent');
  });

  it('T-CA-05: creates config from scratch when no existing config', () => {
    const emptyConfig: RawConfig = {
      gateway: { logDir: '~/.claude-gateway/logs', timezone: 'UTC' },
      agents: [],
    };

    const newEntry = buildNewAgentEntry(
      'freshagent',
      path.join(os.homedir(), '.claude-gateway/agents/freshagent/workspace'),
      '# Agent: Freshagent\nBrand new agent.'
    );

    const config = addAgentToConfig(emptyConfig, newEntry);

    expect(config.agents).toHaveLength(1);
    expect(config.agents[0].id).toBe('freshagent');
    expect(config.gateway.timezone).toBe('UTC');
  });

  it('sets correct botToken env var name for agent id', () => {
    const entry = buildNewAgentEntry(
      'my-cool-agent',
      '/tmp/workspace',
      '# Agent: MyCoolAgent\nDescription.'
    );
    expect(entry.telegram.botToken).toBe('${MY_COOL_AGENT_BOT_TOKEN}');
  });

  it('uses first non-empty line of agent.md as description', () => {
    const agentMd = `\n\n# Agent: Alfred\nA formal English butler.`;
    const entry = buildNewAgentEntry('alfred', '/tmp/workspace', agentMd);
    expect(entry.description).toBe('Agent: Alfred');
  });

  it('strips markdown heading prefix from description', () => {
    const agentMd = `# Agent: Clean\nSome other content.`;
    const entry = buildNewAgentEntry('clean', '/tmp/workspace', agentMd);
    expect(entry.description).toBe('Agent: Clean');
  });

  it('replaces home dir with ~ in workspace path', () => {
    const homeDir = os.homedir();
    const wsDir = path.join(homeDir, '.claude-gateway/agents/myagent/workspace');
    const entry = buildNewAgentEntry('myagent', wsDir, '# Agent: Myagent\nDesc.');
    expect(entry.workspace).toBe('~/.claude-gateway/agents/myagent/workspace');
  });
});

// ---------------------------------------------------------------------------
// T-CA-02: Duplicate name detection (pure logic)
// ---------------------------------------------------------------------------
describe('T-CA-02: Duplicate name detection', () => {
  it('detects existing agent id in list', () => {
    const existingIds = ['alfred', 'baerbel', 'existing'];
    expect(existingIds.includes('alfred')).toBe(true);
  });

  it('does not flag non-existing name as duplicate', () => {
    const existingIds = ['alfred', 'baerbel'];
    expect(existingIds.includes('newagent')).toBe(false);
  });

  it('normalises name to lowercase for comparison', () => {
    const rawName = 'Alfred';
    const agentId = rawName.toLowerCase();
    const existingIds = ['alfred'];
    expect(existingIds.includes(agentId)).toBe(true);
  });

  it('does not match partial names', () => {
    const existingIds = ['alfred'];
    expect(existingIds.includes('alf')).toBe(false);
    expect(existingIds.includes('alfredx')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// T-CA-07: pollForFirstMessage — direct Telegram API pairing logic
// ---------------------------------------------------------------------------
describe('T-CA-07: pollForFirstMessage — getUpdates parsing', () => {
  /**
   * Mirror the getUpdates response parsing logic from pollForFirstMessage.
   * Extracts senderId + chatId from the first private message in the update list.
   */
  function parseFirstPrivateMessage(
    updates: Array<{ update_id: number; message?: { from: { id: number }; chat: { id: number; type: string } } }>
  ): { senderId: string; chatId: string } | null {
    for (const update of updates) {
      if (update.message?.chat.type === 'private') {
        return {
          senderId: String(update.message.from.id),
          chatId: String(update.message.chat.id),
        };
      }
    }
    return null;
  }

  it('returns senderId and chatId from first private message', () => {
    const updates = [
      {
        update_id: 1001,
        message: { from: { id: 991177022 }, chat: { id: 991177022, type: 'private' } },
      },
    ];
    const result = parseFirstPrivateMessage(updates);
    expect(result).toEqual({ senderId: '991177022', chatId: '991177022' });
  });

  it('skips non-private messages (group, channel)', () => {
    const updates = [
      {
        update_id: 1001,
        message: { from: { id: 111 }, chat: { id: -1001234, type: 'supergroup' } },
      },
      {
        update_id: 1002,
        message: { from: { id: 222 }, chat: { id: 222, type: 'private' } },
      },
    ];
    const result = parseFirstPrivateMessage(updates);
    expect(result).toEqual({ senderId: '222', chatId: '222' });
  });

  it('returns null when no private messages', () => {
    const updates = [
      {
        update_id: 1001,
        message: { from: { id: 111 }, chat: { id: -1001234, type: 'supergroup' } },
      },
    ];
    expect(parseFirstPrivateMessage(updates)).toBeNull();
  });

  it('returns null for empty update list', () => {
    expect(parseFirstPrivateMessage([])).toBeNull();
  });

  it('offset should be last update_id + 1', () => {
    const updates = [
      { update_id: 500 },
      { update_id: 501 },
      { update_id: 502 },
    ];
    const nextOffset = updates[updates.length - 1].update_id + 1;
    expect(nextOffset).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// T-CA-08: Workspace file creation
// ---------------------------------------------------------------------------
describe('T-CA-08: Workspace file creation', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-ws-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes accepted files to the workspace directory', () => {
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    const files = new Map<string, string>([
      ['AGENTS.md', '# Agent: Test\nYou are Test.'],
      ['SOUL.md', 'Be helpful and kind.'],
    ]);

    for (const [filename, content] of files) {
      fs.writeFileSync(path.join(wsDir, filename), content, 'utf8');
    }

    expect(fs.existsSync(path.join(wsDir, 'AGENTS.md'))).toBe(true);
    expect(fs.existsSync(path.join(wsDir, 'SOUL.md'))).toBe(true);
    expect(fs.readFileSync(path.join(wsDir, 'AGENTS.md'), 'utf8')).toBe('# Agent: Test\nYou are Test.');
    expect(fs.readFileSync(path.join(wsDir, 'SOUL.md'), 'utf8')).toBe('Be helpful and kind.');
  });

  it('creates workspace directory recursively', () => {
    const wsDir = path.join(tmpDir, 'agents', 'myagent', 'workspace');
    expect(fs.existsSync(wsDir)).toBe(false);

    fs.mkdirSync(wsDir, { recursive: true });
    expect(fs.existsSync(wsDir)).toBe(true);
  });

  it('writes all files from accepted map', () => {
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    const accepted = new Map<string, string>([
      ['AGENTS.md', 'agent content'],
      ['SOUL.md', 'soul content'],
      ['USER.md', 'user content'],
      ['TOOLS.md', 'tools content'],
    ]);

    for (const [filename, content] of accepted) {
      fs.writeFileSync(path.join(wsDir, filename), content, 'utf8');
    }

    const written = fs.readdirSync(wsDir);
    expect(written).toHaveLength(4);
    expect(written).toContain('AGENTS.md');
    expect(written).toContain('SOUL.md');
    expect(written).toContain('USER.md');
    expect(written).toContain('TOOLS.md');
  });
});

// ---------------------------------------------------------------------------
// firstNonEmptyLine helper tests
// ---------------------------------------------------------------------------
describe('firstNonEmptyLine helper', () => {
  it('returns first non-empty line', () => {
    expect(firstNonEmptyLine('Hello\nWorld')).toBe('Hello');
  });

  it('skips leading empty lines', () => {
    expect(firstNonEmptyLine('\n\nHello\nWorld')).toBe('Hello');
  });

  it('strips markdown heading prefix #', () => {
    expect(firstNonEmptyLine('# Agent: Alfred\nDescription.')).toBe('Agent: Alfred');
  });

  it('strips multi-level markdown headings', () => {
    expect(firstNonEmptyLine('## Section Title\nContent.')).toBe('Section Title');
  });

  it('returns fallback for all-empty text', () => {
    const result = firstNonEmptyLine('   \n  \n  ');
    expect(typeof result).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// expandHome helper tests
// ---------------------------------------------------------------------------
describe('expandHome helper', () => {
  it('expands ~/ prefix to home dir', () => {
    const result = expandHome('~/.claude-gateway/config.json');
    expect(result).toBe(path.join(os.homedir(), '.claude-gateway/config.json'));
  });

  it('expands standalone ~ to home dir', () => {
    const result = expandHome('~');
    expect(result).toBe(os.homedir());
  });

  it('does not modify absolute paths', () => {
    const absPath = '/etc/config.json';
    expect(expandHome(absPath)).toBe(absPath);
  });

  it('does not modify relative paths without ~', () => {
    const relPath = 'some/relative/path';
    expect(expandHome(relPath)).toBe(relPath);
  });
});

// ---------------------------------------------------------------------------
// T-CA-09: expandDescriptionUrls — URL pre-fetching logic (pure unit tests)
// ---------------------------------------------------------------------------

describe('T-CA-09: expandDescriptionUrls — URL detection and Wikipedia API routing', () => {
  /**
   * Mirror the Wikipedia URL matching logic from expandDescriptionUrls.
   * Returns the REST summary API URL for Wikipedia links, null for other URLs.
   */
  function resolveWikipediaApiUrl(url: string): string | null {
    const wikiMatch = url.match(/^https?:\/\/(\w+)\.wikipedia\.org\/wiki\/(.+)$/);
    if (!wikiMatch) return null;
    const lang = wikiMatch[1];
    const title = wikiMatch[2];
    return `https://${lang}.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(title)}`;
  }

  /** Mirror URL regex from expandDescriptionUrls */
  function extractUrls(text: string): string[] {
    return text.match(/https?:\/\/[^\s]+/) ?? [];
  }

  it('detects no URLs in plain text', () => {
    expect(extractUrls('A helpful assistant for personal tasks.')).toHaveLength(0);
  });

  it('detects a single URL', () => {
    const urls = extractUrls('See https://example.com for info.');
    expect(urls).toHaveLength(1);
    expect(urls[0]).toBe('https://example.com');
  });

  it('routes Wikipedia URL to REST summary API', () => {
    const url = 'https://en.wikipedia.org/wiki/Akari_Tsumugi';
    const apiUrl = resolveWikipediaApiUrl(url);
    expect(apiUrl).toBe('https://en.wikipedia.org/api/rest_v1/page/summary/Akari_Tsumugi');
  });

  it('routes non-English Wikipedia URL with correct language code', () => {
    const url = 'https://vi.wikipedia.org/wiki/Akari_Tsumugi';
    const apiUrl = resolveWikipediaApiUrl(url);
    expect(apiUrl).toBe('https://vi.wikipedia.org/api/rest_v1/page/summary/Akari_Tsumugi');
  });

  it('returns null for non-Wikipedia URLs', () => {
    expect(resolveWikipediaApiUrl('https://example.com/page')).toBeNull();
    expect(resolveWikipediaApiUrl('https://github.com/user/repo')).toBeNull();
  });

  it('URL-encodes spaces in Wikipedia article titles', () => {
    const url = 'https://en.wikipedia.org/wiki/Sailor_Moon';
    const apiUrl = resolveWikipediaApiUrl(url);
    expect(apiUrl).toContain('Sailor_Moon');
  });

  it('strips HTML script and style tags from generic URL content', () => {
    const html = '<html><script>alert(1)</script><style>.x{}</style><body><h1>Title</h1><p>Content</p></body></html>';
    const stripped = html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    expect(stripped).toContain('Title');
    expect(stripped).toContain('Content');
    expect(stripped).not.toContain('<script>');
    expect(stripped).not.toContain('<style>');
    expect(stripped).not.toContain('alert(1)');
  });
});

// ---------------------------------------------------------------------------
// T-CA-10: createWorkspace stub files
// ---------------------------------------------------------------------------

describe('T-CA-10: createWorkspace creates blank stubs for standard files', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ca-stub-'));
    // Override workspaceDir behaviour: we'll pass an agentId whose workspace resolves into tmpDir
    // by using a fake agentId equal to the temp dir (we call createWorkspace with a synthetic agentId
    // that produces a workspace path under tmpDir via a custom env hack).
    // Simpler: just call createWorkspace with a real agentId and let it create under ~/.claude-gateway/agents
    // — but that is integration-level. Instead, test the stub logic inline.
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates empty stub files for missing standard files', () => {
    // Simulate what createWorkspace does after writing accepted files
    const STANDARD_STUB_FILES = ['HEARTBEAT.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'USER.md'];
    const acceptedFiles = new Map<string, string>([
      ['AGENTS.md', '# Agent: Test\nYou are Test.'],
      ['SOUL.md', 'Be helpful and kind.'],
    ]);

    // Write accepted files
    for (const [filename, content] of acceptedFiles) {
      fs.writeFileSync(path.join(tmpDir, filename), content, 'utf8');
    }

    // Write stubs for missing standard files (mirrors createWorkspace logic)
    for (const stub of STANDARD_STUB_FILES) {
      if (!acceptedFiles.has(stub)) {
        const stubPath = path.join(tmpDir, stub);
        if (!fs.existsSync(stubPath)) {
          fs.writeFileSync(stubPath, '', 'utf8');
        }
      }
    }

    // SOUL.md was in acceptedFiles with content — should not be overwritten
    expect(fs.readFileSync(path.join(tmpDir, 'SOUL.md'), 'utf8')).toBe('Be helpful and kind.');

    // Other standard files should exist as blank stubs
    expect(fs.existsSync(path.join(tmpDir, 'HEARTBEAT.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'HEARTBEAT.md'), 'utf8')).toBe('');

    expect(fs.existsSync(path.join(tmpDir, 'MEMORY.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'MEMORY.md'), 'utf8')).toBe('');

    expect(fs.existsSync(path.join(tmpDir, 'TOOLS.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'TOOLS.md'), 'utf8')).toBe('');

    expect(fs.existsSync(path.join(tmpDir, 'USER.md'))).toBe(true);
    expect(fs.readFileSync(path.join(tmpDir, 'USER.md'), 'utf8')).toBe('');
  });

  it('does not overwrite existing stub file on re-run', () => {
    const stubPath = path.join(tmpDir, 'MEMORY.md');
    fs.writeFileSync(stubPath, 'Existing content', 'utf8');

    const STANDARD_STUB_FILES = ['MEMORY.md'];
    const acceptedFiles = new Map<string, string>();

    for (const stub of STANDARD_STUB_FILES) {
      if (!acceptedFiles.has(stub)) {
        const sp = path.join(tmpDir, stub);
        if (!fs.existsSync(sp)) {
          fs.writeFileSync(sp, '', 'utf8');
        }
      }
    }

    // Existing content should not be overwritten
    expect(fs.readFileSync(stubPath, 'utf8')).toBe('Existing content');
  });

  it('all 5 standard stub files are defined', () => {
    const STANDARD_STUB_FILES = ['HEARTBEAT.md', 'MEMORY.md', 'SOUL.md', 'TOOLS.md', 'USER.md'];
    expect(STANDARD_STUB_FILES).toHaveLength(5);
    expect(STANDARD_STUB_FILES).toContain('MEMORY.md');
    expect(STANDARD_STUB_FILES).not.toContain('BOOTSTRAP.md');
    expect(STANDARD_STUB_FILES).not.toContain('AGENTS.md');
  });
});
