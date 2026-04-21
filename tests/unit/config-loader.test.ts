import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import {
  loadConfig,
  ConfigValidationError,
  DuplicateAgentIdError,
  MissingEnvVarError,
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
});
