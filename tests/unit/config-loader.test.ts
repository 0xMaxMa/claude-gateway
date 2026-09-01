import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadConfig,
  ConfigValidationError,
  DuplicateAgentIdError,
  MissingEnvVarError,
  SkippedAgent,
} from '../../src/config/loader';

const FIXTURES = path.join(__dirname, '../fixtures/configs');

describe('config-loader', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cl-test-'));
    // Set required env vars for the valid-2-agents.json fixture
    process.env.ALFRED_BOT_TOKEN = 'alfred-test-token';
    process.env.BAERBEL_BOT_TOKEN = 'baerbel-test-token';
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ALFRED_BOT_TOKEN;
    delete process.env.BAERBEL_BOT_TOKEN;
    delete process.env.TEST_TOKEN;
  });

  // -------------------------------------------------------------------------
  // U-CL-01: Valid config with 2 agents
  // -------------------------------------------------------------------------
  it('U-CL-01: loads a valid config with 2 agents', () => {
    const config = loadConfig(path.join(FIXTURES, 'valid-2-agents.json'));
    expect(config.agents).toHaveLength(2);
    expect(config.agents[0].id).toBe('alfred');
    expect(config.agents[1].id).toBe('baerbel');
    // Env vars should be interpolated
    expect(config.agents[0].telegram!.botToken).toBe('alfred-test-token');
    expect(config.agents[1].telegram!.botToken).toBe('baerbel-test-token');
  });

  // -------------------------------------------------------------------------
  // U-CL-02: Missing agents array
  // -------------------------------------------------------------------------
  it('U-CL-02: throws ConfigValidationError when agents array is missing', () => {
    expect(() => loadConfig(path.join(FIXTURES, 'missing-agents.json'))).toThrow(
      ConfigValidationError
    );
    expect(() => loadConfig(path.join(FIXTURES, 'missing-agents.json'))).toThrow(/agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-03: Agent missing id
  // -------------------------------------------------------------------------
  it('U-CL-03: throws ConfigValidationError when agent is missing id', () => {
    const configPath = path.join(tmpDir, 'no-id.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        description: 'no id here',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/id/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-04: Agent missing botToken
  // -------------------------------------------------------------------------
  it('U-CL-04: skips agent when botToken is missing, throws if no agents remain', () => {
    const configPath = path.join(tmpDir, 'no-token.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test-agent',
        description: 'missing bot token',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: {},
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-04b: A genuinely empty "agents": [] is a valid bootstrap state —
  // start the gateway with zero agents, then add the first one via
  // `claude-gateway agents create` (the wizard needs the gateway running).
  // -------------------------------------------------------------------------
  it('U-CL-04b: loads successfully with an empty agents array (zero-agent bootstrap)', () => {
    const configPath = path.join(tmpDir, 'no-agents.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [],
    }));

    const config = loadConfig(configPath);
    expect(config.agents).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // U-CL-05: Duplicate agent IDs
  // -------------------------------------------------------------------------
  it('U-CL-05: throws DuplicateAgentIdError for duplicate agent IDs', () => {
    expect(() => loadConfig(path.join(FIXTURES, 'duplicate-ids.json'))).toThrow(
      DuplicateAgentIdError
    );
    expect(() => loadConfig(path.join(FIXTURES, 'duplicate-ids.json'))).toThrow('alfred');
  });

  // -------------------------------------------------------------------------
  // U-CL-06: Env var interpolation — variable set
  // -------------------------------------------------------------------------
  it('U-CL-06: interpolates ${VAR} when env variable is set', () => {
    process.env.TEST_TOKEN = 'my-real-token';
    const configPath = path.join(tmpDir, 'env-interp.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: 'env test',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: '${TEST_TOKEN}' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].telegram!.botToken).toBe('my-real-token');
  });

  // -------------------------------------------------------------------------
  // U-CL-07: Env var interpolation — missing variable
  // -------------------------------------------------------------------------
  it('U-CL-07: skips agent with missing env var, throws if no agents remain', () => {
    delete process.env.NONEXISTENT_VAR;
    const configPath = path.join(tmpDir, 'missing-env.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [{
        id: 'test',
        description: 'env test',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: '${NONEXISTENT_VAR}' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
    expect(() => loadConfig(configPath)).toThrow(/no valid agents/i);
  });

  // -------------------------------------------------------------------------
  // U-CL-08: config without dmPolicy/allowedUsers loads fine
  // -------------------------------------------------------------------------
  it('U-CL-08: loads config that has no dmPolicy or allowedUsers in telegram', () => {
    const configPath = path.join(tmpDir, 'minimal-telegram.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [
        {
          id: 'agent-a',
          description: '',
          workspace: '/tmp',
          env: '/tmp/.env',
          telegram: { botToken: 'tok-a' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        },
      ],
    }));

    const config = loadConfig(configPath);
    expect(config.agents[0].telegram!.botToken).toBe('tok-a');
    expect((config.agents[0].telegram as Record<string, unknown>).dmPolicy).toBeUndefined();
    expect((config.agents[0].telegram as Record<string, unknown>).allowedUsers).toBeUndefined();
  });

  // -------------------------------------------------------------------------
  // Additional edge cases
  // -------------------------------------------------------------------------
  it('throws ConfigValidationError for missing gateway object', () => {
    const configPath = path.join(tmpDir, 'no-gateway.json');
    fs.writeFileSync(configPath, JSON.stringify({
      agents: [{
        id: 'test',
        description: '',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));

    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when config file does not exist', () => {
    expect(() => loadConfig('/nonexistent/path/config.json')).toThrow(ConfigValidationError);
  });

  it('throws ConfigValidationError when config file is not valid JSON', () => {
    const configPath = path.join(tmpDir, 'bad-json.json');
    fs.writeFileSync(configPath, 'not { valid json');
    expect(() => loadConfig(configPath)).toThrow(ConfigValidationError);
  });

  it('normalizes a valid gateway.publicUrl and rejects unsafe values', () => {
    const write = (name: string, publicUrl: unknown) => {
      const configPath = path.join(tmpDir, name);
      fs.writeFileSync(configPath, JSON.stringify({
        gateway: { logDir: '/tmp', timezone: 'UTC', publicUrl },
        agents: [{
          id: 'test',
          description: '',
          workspace: '/tmp',
          env: '/tmp/.env',
          telegram: { botToken: 'tok' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        }],
      }));
      return configPath;
    };

    const valid = write('public-url-valid.json', 'https://pod-maxma.example.com/gateway/');
    expect(loadConfig(valid).gateway.publicUrl).toBe('https://pod-maxma.example.com/gateway');

    for (const [index, value] of [
      'https://pod-maxma.example.com',
      'http://pod-maxma.example.com/gateway',
      'https://pod-maxma.example.com/gateway?token=x',
      'not-a-url',
    ].entries()) {
      expect(() => loadConfig(write(`public-url-invalid-${index}.json`, value))).toThrow(
        /gateway\.publicUrl/,
      );
    }
  });

  it('treats blank/whitespace/absent gateway.publicUrl as unset (no throw)', () => {
    const write = (name: string, publicUrl: unknown) => {
      const configPath = path.join(tmpDir, name);
      fs.writeFileSync(configPath, JSON.stringify({
        gateway: { logDir: '/tmp', timezone: 'UTC', publicUrl },
        agents: [{
          id: 'test',
          description: '',
          workspace: '/tmp',
          env: '/tmp/.env',
          telegram: { botToken: 'tok' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
        }],
      }));
      return configPath;
    };

    // Empty string (the value config.template.json used to ship) → unset, boots.
    expect(loadConfig(write('public-url-empty.json', '')).gateway.publicUrl).toBeUndefined();
    // Whitespace-only → same as empty.
    expect(loadConfig(write('public-url-blank.json', '   ')).gateway.publicUrl).toBeUndefined();
    // Absent key (JSON.stringify drops undefined) → unset, no regression.
    expect(loadConfig(write('public-url-absent.json', undefined)).gateway.publicUrl).toBeUndefined();
  });

  it('boots from the shipped config.template.json gateway block', () => {
    const template = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', '..', 'config.template.json'), 'utf-8'),
    );
    // Guard the template fix: the shipped gateway block must not carry a value
    // the loader rejects. Keep the template's real gateway block, swap in one
    // minimal agent so agent interpolation needs no env, and satisfy the two
    // gateway api-key env placeholders so we exercise the real gateway block.
    const configPath = path.join(tmpDir, 'from-template.json');
    fs.writeFileSync(configPath, JSON.stringify({
      gateway: template.gateway,
      agents: [{
        id: 'test',
        description: '',
        workspace: '/tmp',
        env: '/tmp/.env',
        telegram: { botToken: 'tok' },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      }],
    }));
    const prevMy = process.env.MY_API_KEY;
    const prevAdmin = process.env.ADMIN_API_KEY;
    process.env.MY_API_KEY = 'sk-test-my';
    process.env.ADMIN_API_KEY = 'sk-test-admin';
    try {
      expect(() => loadConfig(configPath)).not.toThrow();
      expect(loadConfig(configPath).gateway.publicUrl).toBeUndefined();
    } finally {
      if (prevMy === undefined) delete process.env.MY_API_KEY;
      else process.env.MY_API_KEY = prevMy;
      if (prevAdmin === undefined) delete process.env.ADMIN_API_KEY;
      else process.env.ADMIN_API_KEY = prevAdmin;
    }
  });

  // -------------------------------------------------------------------------
  // U-CL-09: onSkippedAgent reports every drop site
  //
  // Skipping an agent is deliberately non-fatal, which is exactly what made it
  // invisible before #427 — the only signal was a console.warn that never
  // reaches logs/gateway.log. These pin the callback contract for all three
  // sites so a drop can never go back to being silent.
  // -------------------------------------------------------------------------
  describe('U-CL-09: onSkippedAgent callback', () => {
    const healthyAgent = {
      id: 'alfred',
      description: '',
      workspace: '/tmp',
      env: '/tmp/.env',
      telegram: { botToken: 'alfred-plain-token' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
    };

    function writeConfig(name: string, agents: unknown[]): string {
      const configPath = path.join(tmpDir, name);
      fs.writeFileSync(configPath, JSON.stringify({
        gateway: { logDir: '/tmp/logs', port: 8080 },
        agents,
      }));
      return configPath;
    }

    it('U-CL-09a: reports a malformed (non-object) config entry', () => {
      const configPath = writeConfig('malformed.json', ['not-an-object', healthyAgent]);
      const skipped: SkippedAgent[] = [];

      const config = loadConfig(configPath, { onSkippedAgent: (s) => skipped.push(s) });

      expect(config.agents.map(a => a.id)).toEqual(['alfred']);
      expect(skipped).toEqual([
        { id: 'index 0', reason: 'Config entry must be an object' },
      ]);
    });

    it('U-CL-09b: reports an agent that fails validation', () => {
      const configPath = writeConfig('invalid.json', [
        { ...healthyAgent, id: 'broken', telegram: {} },
        healthyAgent,
      ]);
      const skipped: SkippedAgent[] = [];

      const config = loadConfig(configPath, { onSkippedAgent: (s) => skipped.push(s) });

      expect(config.agents.map(a => a.id)).toEqual(['alfred']);
      expect(skipped).toHaveLength(1);
      expect(skipped[0].id).toBe('broken');
      expect(skipped[0].reason).toContain('missing "telegram.botToken"');
      // No ${VAR} was involved, so there is nothing to name.
      expect(skipped[0].missingVar).toBeUndefined();
    });

    it('U-CL-09c: reports the unresolved variable name for a missing env var', () => {
      const configPath = writeConfig('missing-var.json', [
        { ...healthyAgent, id: 'nowhere', telegram: { botToken: '${NOWHERE_BOT_TOKEN}' } },
        healthyAgent,
      ]);
      const skipped: SkippedAgent[] = [];

      const config = loadConfig(configPath, { onSkippedAgent: (s) => skipped.push(s) });

      expect(config.agents.map(a => a.id)).toEqual(['alfred']);
      expect(skipped).toEqual([
        {
          id: 'nowhere',
          reason: 'Missing environment variable: NOWHERE_BOT_TOKEN',
          missingVar: 'NOWHERE_BOT_TOKEN',
        },
      ]);
    });

    it('U-CL-09d: omits the callback safely when no options are passed', () => {
      const configPath = writeConfig('no-options.json', ['not-an-object', healthyAgent]);
      expect(() => loadConfig(configPath)).not.toThrow();
    });
  });
});
