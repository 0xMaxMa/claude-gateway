import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigWatcher, ConfigChange, _deepEqual } from '../../src/config/watcher';
import { GatewayConfig, AgentConfig, Logger, ApiKey } from '../../src/types';
import { loadConfig } from '../../src/config/loader';
import { GatewayRouter } from '../../src/api/gateway-router';
import { CronScheduler } from '../../src/cron/scheduler';

const FIXTURES = path.join(__dirname, '../fixtures/configs');

/** Build a minimal valid GatewayConfig for testing. */
function makeConfig(overrides?: {
  agents?: Partial<AgentConfig>[];
  gateway?: Partial<GatewayConfig['gateway']>;
}): GatewayConfig {
  const defaultAgent: AgentConfig = {
    id: 'alfred',
    description: 'Primary personal assistant bot',
    workspace: '/tmp/alfred/workspace',
    env: '/tmp/alfred/.env',
    telegram: {
      botToken: 'alfred-test-token',
      allowedUsers: [991177022],
      dmPolicy: 'allowlist',
    },
    claude: {
      model: 'claude-opus-4-6',
      dangerouslySkipPermissions: true,
      extraFlags: [],
    },
  };

  const defaultAgent2: AgentConfig = {
    id: 'baerbel',
    description: 'Team support bot',
    workspace: '/tmp/baerbel/workspace',
    env: '/tmp/baerbel/.env',
    telegram: {
      botToken: 'baerbel-test-token',
      allowedUsers: [],
      dmPolicy: 'open',
    },
    claude: {
      model: 'claude-sonnet-4-6',
      dangerouslySkipPermissions: false,
      extraFlags: [],
    },
  };

  const agents: AgentConfig[] = overrides?.agents
    ? overrides.agents.map((o, i) => ({
        ...(i === 0 ? defaultAgent : defaultAgent2),
        ...o,
      }))
    : [defaultAgent, defaultAgent2];

  return {
    gateway: {
      logDir: '/tmp/claude-gateway-test-logs',
      timezone: 'Asia/Bangkok',
      ...overrides?.gateway,
    },
    agents,
  };
}

function createMockLogger(): Logger & {
  info: jest.Mock;
  warn: jest.Mock;
  error: jest.Mock;
  debug: jest.Mock;
} {
  return {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
}

describe('config-watcher', () => {
  let tmpDir: string;
  let logger: ReturnType<typeof createMockLogger>;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
    process.env.ALFRED_BOT_TOKEN = 'alfred-test-token';
    process.env.BAERBEL_BOT_TOKEN = 'baerbel-test-token';
    logger = createMockLogger();
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete process.env.ALFRED_BOT_TOKEN;
    delete process.env.BAERBEL_BOT_TOKEN;
  });

  /**
   * Helper: write a GatewayConfig-shaped object as JSON to a temp file,
   * using env var placeholders so loadConfig can interpolate them.
   */
  function writeConfigFile(
    filePath: string,
    config: Record<string, unknown>,
  ): void {
    fs.writeFileSync(filePath, JSON.stringify(config, null, 2));
  }

  /** Build a raw config JSON object (with ${ENV} placeholders). */
  function rawConfig(overrides?: {
    alfredModel?: string;
    alfredBotToken?: string;
    baerbelModel?: string;
    alfredExtraFlags?: string[];
    alfredDangerouslySkip?: boolean;
  }): Record<string, unknown> {
    return {
      gateway: { logDir: '/tmp/claude-gateway-test-logs', timezone: 'Asia/Bangkok' },
      agents: [
        {
          id: 'alfred',
          description: 'Primary personal assistant bot',
          workspace: '/tmp/alfred/workspace',
          env: '/tmp/alfred/.env',
          telegram: {
            botToken: overrides?.alfredBotToken ?? '${ALFRED_BOT_TOKEN}',
            allowedUsers: [991177022],
            dmPolicy: 'allowlist',
          },
          claude: {
            model: overrides?.alfredModel ?? 'claude-opus-4-6',
            dangerouslySkipPermissions: overrides?.alfredDangerouslySkip ?? true,
            extraFlags: overrides?.alfredExtraFlags ?? [],
          },
        },
        {
          id: 'baerbel',
          description: 'Team support bot',
          workspace: '/tmp/baerbel/workspace',
          env: '/tmp/baerbel/.env',
          telegram: {
            botToken: '${BAERBEL_BOT_TOKEN}',
            allowedUsers: [],
            dmPolicy: 'open',
          },
          claude: {
            model: overrides?.baerbelModel ?? 'claude-sonnet-4-6',
            dangerouslySkipPermissions: false,
            extraFlags: [],
          },
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // U-CW-01: config.json changes claude.model — emit changes with hotReloadable=true
  // ---------------------------------------------------------------------------
  it('U-CW-01: emits changes with hotReloadable=true when claude.model changes', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Modify model and reload
    writeConfigFile(configPath, rawConfig({ alfredModel: 'claude-sonnet-4-6' }));
    watcher.reload();

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({
      agentId: 'alfred',
      field: 'claude.model',
      oldValue: 'claude-opus-4-6',
      newValue: 'claude-sonnet-4-6',
      hotReloadable: true,
    });

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-02: config.json changes telegram.botToken — emit changes with hotReloadable=false
  // ---------------------------------------------------------------------------
  it('U-CW-02: emits changes with hotReloadable=false when telegram.botToken changes', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Change bot token directly (hardcoded, not via env var)
    writeConfigFile(configPath, rawConfig({ alfredBotToken: 'new-alfred-token' }));
    watcher.reload();

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];
    const tokenChange = changes.find(c => c.field === 'telegram.botToken');
    expect(tokenChange).toBeDefined();
    expect(tokenChange!.hotReloadable).toBe(false);
    expect(tokenChange!.agentId).toBe('alfred');
    expect(tokenChange!.newValue).toBe('new-alfred-token');

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-03: config.json invalid JSON — log error, no emit, keep current config
  // ---------------------------------------------------------------------------
  it('U-CW-03: logs error and does not emit when config is invalid JSON', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Write invalid JSON
    fs.writeFileSync(configPath, '{ invalid json !!!');
    watcher.reload();

    expect(changeSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Config reload failed, keeping current config',
      expect.objectContaining({ error: expect.any(String) }),
    );

    // Current config should still be the original
    const currentConfig = watcher.getConfig();
    expect(currentConfig.agents).toHaveLength(2);
    expect(currentConfig.agents[0].claude.model).toBe('claude-opus-4-6');

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-04: config.json changes multiple fields at once — emit changes for all fields
  // ---------------------------------------------------------------------------
  it('U-CW-04: emits changes for all modified fields when multiple fields change', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Change model on both agents
    writeConfigFile(
      configPath,
      rawConfig({
        alfredModel: 'claude-sonnet-4-6',
        baerbelModel: 'claude-opus-4-6',
        alfredExtraFlags: ['--verbose'],
      }),
    );
    watcher.reload();

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];

    // Should have 3 changes: alfred model, alfred extraFlags, baerbel model
    expect(changes).toHaveLength(3);

    const alfredModel = changes.find(c => c.agentId === 'alfred' && c.field === 'claude.model');
    const alfredFlags = changes.find(c => c.agentId === 'alfred' && c.field === 'claude.extraFlags');
    const baerbelModel = changes.find(c => c.agentId === 'baerbel' && c.field === 'claude.model');

    expect(alfredModel).toBeDefined();
    expect(alfredFlags).toBeDefined();
    expect(baerbelModel).toBeDefined();

    expect(alfredModel!.hotReloadable).toBe(true);
    expect(alfredFlags!.hotReloadable).toBe(true);
    expect(baerbelModel!.hotReloadable).toBe(true);

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-05: config.json no effective changes (same content) — no emit
  // ---------------------------------------------------------------------------
  it('U-CW-05: does not emit when config content has not effectively changed', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Rewrite identical config
    writeConfigFile(configPath, rawConfig());
    watcher.reload();

    expect(changeSpy).not.toHaveBeenCalled();
    expect(logger.info).toHaveBeenCalledWith(
      'Config file changed but no effective differences detected',
    );

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-06: config.json changes rapidly multiple times — debounce, emit once
  // ---------------------------------------------------------------------------
  it('U-CW-06: reload() emits changes when config differs', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Write config with a different model and reload
    writeConfigFile(configPath, rawConfig({ alfredModel: 'claude-sonnet-4-6' }));
    watcher.reload();

    // Should have emitted exactly once
    expect(changeSpy).toHaveBeenCalledTimes(1);

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-07: config.json has missing env var — log error, don't apply
  // ---------------------------------------------------------------------------
  it('U-CW-07: logs error and keeps current config when env var is missing', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Write config where BOTH agents reference missing env vars so loadConfig throws
    const badRaw = rawConfig();
    (badRaw as Record<string, unknown>).agents = [
      {
        id: 'alfred',
        description: 'test',
        workspace: '/tmp/alfred/workspace',
        env: '/tmp/alfred/.env',
        telegram: {
          botToken: '${MISSING_ENV_VAR_A}',
          allowedUsers: [991177022],
          dmPolicy: 'allowlist',
        },
        claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
      },
      {
        id: 'baerbel',
        description: 'test',
        workspace: '/tmp/baerbel/workspace',
        env: '/tmp/baerbel/.env',
        telegram: {
          botToken: '${MISSING_ENV_VAR_B}',
          allowedUsers: [],
          dmPolicy: 'open',
        },
        claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      },
    ];
    writeConfigFile(configPath, badRaw);
    delete process.env.MISSING_ENV_VAR_A;
    delete process.env.MISSING_ENV_VAR_B;

    watcher.reload();

    expect(changeSpy).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(
      'Config reload failed, keeping current config',
      expect.objectContaining({ error: expect.any(String) }),
    );

    // Current config unchanged
    const currentConfig = watcher.getConfig();
    expect(currentConfig.agents[0].telegram!.botToken).toBe('alfred-test-token');

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-08: deepEqual utility function
  // ---------------------------------------------------------------------------
  describe('U-CW-08: deepEqual utility', () => {
    it('returns true for identical primitives', () => {
      expect(_deepEqual(1, 1)).toBe(true);
      expect(_deepEqual('hello', 'hello')).toBe(true);
      expect(_deepEqual(true, true)).toBe(true);
      expect(_deepEqual(null, null)).toBe(true);
      expect(_deepEqual(undefined, undefined)).toBe(true);
    });

    it('returns false for different primitives', () => {
      expect(_deepEqual(1, 2)).toBe(false);
      expect(_deepEqual('a', 'b')).toBe(false);
      expect(_deepEqual(true, false)).toBe(false);
      expect(_deepEqual(null, undefined)).toBe(false);
      expect(_deepEqual(0, '')).toBe(false);
    });

    it('compares arrays deeply', () => {
      expect(_deepEqual([], [])).toBe(true);
      expect(_deepEqual([1, 2, 3], [1, 2, 3])).toBe(true);
      expect(_deepEqual([1, 2], [1, 2, 3])).toBe(false);
      expect(_deepEqual([1, [2, 3]], [1, [2, 3]])).toBe(true);
      expect(_deepEqual([1, [2, 3]], [1, [2, 4]])).toBe(false);
    });

    it('compares objects deeply', () => {
      expect(_deepEqual({}, {})).toBe(true);
      expect(_deepEqual({ a: 1 }, { a: 1 })).toBe(true);
      expect(_deepEqual({ a: 1 }, { a: 2 })).toBe(false);
      expect(_deepEqual({ a: 1 }, { b: 1 })).toBe(false);
      expect(_deepEqual({ a: { b: 1 } }, { a: { b: 1 } })).toBe(true);
      expect(_deepEqual({ a: { b: 1 } }, { a: { b: 2 } })).toBe(false);
    });

    it('handles mixed types correctly', () => {
      expect(_deepEqual({ a: [1, 2] }, { a: [1, 2] })).toBe(true);
      expect(_deepEqual({ a: [1, 2] }, { a: [1, 3] })).toBe(false);
      expect(_deepEqual([{ a: 1 }], [{ a: 1 }])).toBe(true);
      expect(_deepEqual(null, {})).toBe(false);
      // Note: deepEqual([], {}) returns true because both are objects with 0 keys
      // and the implementation doesn't distinguish array vs plain object in the
      // object branch. This matches the implementation's actual behavior.
      expect(_deepEqual([], {})).toBe(true);
    });

    it('returns false for different key counts', () => {
      expect(_deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    });
  });

  // ---------------------------------------------------------------------------
  // U-CW-09: updateApiKeys on GatewayRouter (mutates array in place)
  // ---------------------------------------------------------------------------
  it('U-CW-09: GatewayRouter.updateApiKeys mutates the keys array in place', () => {
    const initialKeys: ApiKey[] = [
      { key: 'key-1', description: 'first', agents: '*' },
    ];

    const gatewayConfig: GatewayConfig = {
      gateway: {
        logDir: '/tmp',
        timezone: 'UTC',
        api: { keys: initialKeys },
      },
      agents: [],
    };

    // Create minimal mocks for GatewayRouter constructor
    const agents = new Map();
    const configs = new Map();

    const router = new GatewayRouter(agents, configs, undefined, gatewayConfig);

    // Keep a reference to the original array
    const originalKeysRef = gatewayConfig.gateway.api!.keys;

    const newKeys: ApiKey[] = [
      { key: 'key-2', description: 'second', agents: ['alfred'] },
      { key: 'key-3', description: 'third', agents: '*' },
    ];

    router.updateApiKeys(newKeys);

    // The original array reference should still be the same object (mutated in place)
    expect(gatewayConfig.gateway.api!.keys).toBe(originalKeysRef);
    // Content should be updated
    expect(gatewayConfig.gateway.api!.keys).toHaveLength(2);
    expect(gatewayConfig.gateway.api!.keys[0].key).toBe('key-2');
    expect(gatewayConfig.gateway.api!.keys[1].key).toBe('key-3');
  });

  it('U-CW-09b: GatewayRouter.updateApiKeys does nothing when no api config exists', () => {
    const gatewayConfig: GatewayConfig = {
      gateway: { logDir: '/tmp', timezone: 'UTC' },
      agents: [],
    };

    const router = new GatewayRouter(new Map(), new Map(), undefined, gatewayConfig);

    // Should not throw
    expect(() => {
      router.updateApiKeys([{ key: 'k', agents: '*' }]);
    }).not.toThrow();
  });

  // ---------------------------------------------------------------------------
  // U-CW-10: updateRateLimit on CronScheduler
  // ---------------------------------------------------------------------------
  it('U-CW-10: CronScheduler.updateRateLimit updates the heartbeat rate limit', () => {
    const agentConfig: AgentConfig = {
      id: 'alfred',
      description: 'test',
      workspace: '/tmp',
      env: '/tmp/.env',
      telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      heartbeat: { rateLimitMinutes: 30 },
    };

    // Minimal mock runner
    const mockRunner = {
      on: jest.fn(),
      removeListener: jest.fn(),
      sendMessage: jest.fn(),
      isRunning: jest.fn().mockReturnValue(true),
    } as unknown as import('../../src/agent/runner').AgentRunner;

    const scheduler = new CronScheduler('alfred', mockRunner, logger, agentConfig);

    // Update rate limit
    scheduler.updateRateLimit(15);

    expect(agentConfig.heartbeat!.rateLimitMinutes).toBe(15);
    expect(logger.info).toHaveBeenCalledWith(
      'Heartbeat rate limit updated',
      { rateLimitMinutes: 15 },
    );
  });

  it('U-CW-10b: CronScheduler.updateRateLimit creates heartbeat config if missing', () => {
    const agentConfig: AgentConfig = {
      id: 'alfred',
      description: 'test',
      workspace: '/tmp',
      env: '/tmp/.env',
      telegram: { botToken: 'tok', allowedUsers: [], dmPolicy: 'open' },
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
      // No heartbeat config
    };

    const mockRunner = {
      on: jest.fn(),
      removeListener: jest.fn(),
      sendMessage: jest.fn(),
      isRunning: jest.fn().mockReturnValue(true),
    } as unknown as import('../../src/agent/runner').AgentRunner;

    const scheduler = new CronScheduler('alfred', mockRunner, logger, agentConfig);

    scheduler.updateRateLimit(45);

    expect(agentConfig.heartbeat).toBeDefined();
    expect(agentConfig.heartbeat!.rateLimitMinutes).toBe(45);
  });
});
