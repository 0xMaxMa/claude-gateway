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
    publicUrl?: string;
    logs?: Record<string, unknown>;
    alfredConnectors?: Record<string, { enabled: boolean }>;
    customConnectors?: Record<string, unknown>;
    connectorsDefaultEnabled?: boolean;
    oauthReturnUrl?: string;
  }): Record<string, unknown> {
    return {
      gateway: {
        logDir: '/tmp/claude-gateway-test-logs',
        timezone: 'Asia/Bangkok',
        ...(overrides?.publicUrl ? { publicUrl: overrides.publicUrl } : {}),
        ...(overrides?.logs ? { logs: overrides.logs } : {}),
        ...(overrides?.customConnectors ? { customConnectors: overrides.customConnectors } : {}),
        ...(overrides?.connectorsDefaultEnabled !== undefined
          ? { connectorsDefaultEnabled: overrides.connectorsDefaultEnabled }
          : {}),
        ...(overrides?.oauthReturnUrl ? { oauthReturnUrl: overrides.oauthReturnUrl } : {}),
      },
      agents: [
        {
          id: 'alfred',
          description: 'Primary personal assistant bot',
          workspace: '/tmp/alfred/workspace',
          env: '/tmp/alfred/.env',
          telegram: {
            botToken: overrides?.alfredBotToken ?? '${ALFRED_BOT_TOKEN}',
          },
          claude: {
            model: overrides?.alfredModel ?? 'claude-opus-4-6',
            dangerouslySkipPermissions: overrides?.alfredDangerouslySkip ?? true,
            extraFlags: overrides?.alfredExtraFlags ?? [],
          },
          ...(overrides?.alfredConnectors ? { connectors: overrides.alfredConnectors } : {}),
        },
        {
          id: 'baerbel',
          description: 'Team support bot',
          workspace: '/tmp/baerbel/workspace',
          env: '/tmp/baerbel/.env',
          telegram: {
            botToken: '${BAERBEL_BOT_TOKEN}',
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
  // U-CW-12: gateway.logs is diffed and hot-reloadable (#435)
  // ---------------------------------------------------------------------------
  it('U-CW-12: emits gateway.logs as a hot-reloadable gateway-level change', () => {
    // Without this the block would be a silent no-op: a field the watcher does
    // not diff produces no change at all, so an operator editing `level` sees
    // nothing happen and gets no hint that a restart is needed either.
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig({ logs: { level: 'info' } }));

    const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);
    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    writeConfigFile(configPath, rawConfig({ logs: { level: 'debug', maxFiles: 5 } }));
    watcher.reload();

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];
    const logsChange = changes.find((c) => c.field === 'gateway.logs');
    expect(logsChange).toMatchObject({
      agentId: '',
      field: 'gateway.logs',
      oldValue: { level: 'info' },
      newValue: { level: 'debug', maxFiles: 5 },
      // Turning the level up to chase a live problem is exactly when a restart
      // is unaffordable — it kills the sessions being investigated.
      hotReloadable: true,
    });

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // Connector config (per-agent `connectors` + gateway-level `customConnectors`)
  // must hot-reload too — previously missing from the field-diff list, which
  // meant connecting/adding a connector required a full gateway restart before
  // any session (new or existing) would see it, even though the file on disk
  // was already correct. See connector_push.go / connectors-router.ts for the
  // write side; this only covers the watcher detecting + flagging the change.
  // ---------------------------------------------------------------------------
  it('emits changes with hotReloadable=true when a per-agent connectors toggle changes', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig({ alfredConnectors: { gmail: { enabled: false } } }));

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    writeConfigFile(configPath, rawConfig({ alfredConnectors: { gmail: { enabled: true } } }));
    watcher.reload();

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];
    const connectorsChange = changes.find(c => c.field === 'connectors');
    expect(connectorsChange).toMatchObject({
      agentId: 'alfred',
      field: 'connectors',
      oldValue: { gmail: { enabled: false } },
      newValue: { gmail: { enabled: true } },
      hotReloadable: true,
    });

    watcher.stop();
  });

  it('emits changes with hotReloadable=true when gateway.customConnectors changes', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const initialConfig = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initialConfig, logger);

    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    const gmailEntry = {
      label: 'Gmail',
      config: { type: 'stdio', command: 'npx', args: ['-y', 'gmail-mcp'], env: { GOOGLE_ACCESS_TOKEN: '{access_token}' } },
      secretNames: ['access_token'],
      credentialOwner: 'external',
    };
    writeConfigFile(configPath, rawConfig({ customConnectors: { gmail: gmailEntry } }));
    watcher.reload();

    expect(changeSpy).toHaveBeenCalledTimes(1);
    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];
    const customConnectorsChange = changes.find(c => c.field === 'gateway.customConnectors');
    expect(customConnectorsChange).toMatchObject({
      agentId: '',
      field: 'gateway.customConnectors',
      oldValue: undefined,
      newValue: { gmail: gmailEntry },
      hotReloadable: true,
    });

    watcher.stop();
  });

  // Regression (round 10). Only `gateway.customConnectors` was watched, so the
  // other two connector-shaped gateway fields were invisible: an edit to either
  // produced no ConfigChange at all, and the watcher's "restart required" warning
  // never fired either — the operator got silence and a file that read as applied.
  //
  // They differ in how they must be reported, and the difference is where the
  // value is read, not how important it is:
  //   - connectorsDefaultEnabled is taken off the live config object at spawn
  //     (SessionProcess.writeMcpConfig, AgentRunner.restartSessionsUsingConnector),
  //     so index.ts can install it in place → hot-reloadable. It is also the
  //     switch that shuts every not-explicitly-enabled connector off on a shared
  //     box, which is the worst possible thing to make wait for a restart.
  //   - oauthReturnUrl is captured as a plain argument when the callback router is
  //     mounted (gateway-router.ts), so nothing can reach it afterwards →
  //     reported as restart-required, exactly like gateway.publicUrl.
  it('reports gateway.connectorsDefaultEnabled as a hot-reloadable change', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);
    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    writeConfigFile(configPath, rawConfig({ connectorsDefaultEnabled: false }));
    watcher.reload();

    const changes: ConfigChange[] = changeSpy.mock.calls[0]?.[0] ?? [];
    expect(changes.find((c) => c.field === 'gateway.connectorsDefaultEnabled')).toMatchObject({
      agentId: '',
      oldValue: undefined,
      newValue: false,
      hotReloadable: true,
    });

    watcher.stop();
  });

  // Regression (round 11). Hot-reload of a gateway-level field works by MUTATING
  // the long-lived config object index.ts booted with — `config.gateway.x = ...`
  // in its `changes` handler — because every agent's runner holds a reference to
  // that one object and reads the field at spawn time. getConfig() returns
  // something else: `currentConfig`, a structuredClone that the NEXT reload()
  // replaces outright. So an agent handed getConfig() at hot-add time is handed a
  // snapshot that goes stale the moment anything else changes, and it goes stale
  // silently — connectors connected afterwards never reach that one agent, with
  // no error and a gateway restart as the only cure.
  //
  // This replicates index.ts's two handlers (the same approach
  // skills-hot-reload.test.ts takes to the watchSkills callback) so the choice
  // between the two objects is the thing under test.
  it('hands a hot-added agent the config object that hot-reload mutates, not a snapshot', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    // The boot config, exactly as index.ts holds it.
    const config = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, config, logger);

    // index.ts's `changes` handler, for the connector fields.
    watcher.on('changes', (changes: ConfigChange[]) => {
      for (const change of changes) {
        if (!change.hotReloadable || change.agentId !== '') continue;
        if (change.field === 'gateway.customConnectors') {
          config.gateway.customConnectors = change.newValue as GatewayConfig['gateway']['customConnectors'];
        }
      }
    });

    // index.ts's `agent.added` handler: whatever it passes to startAgent is what
    // that agent's runner keeps for its lifetime.
    const handedToNewAgent: GatewayConfig[] = [];
    watcher.on('agent.added', () => {
      handedToNewAgent.push(config);
    });

    const gmailEntry = {
      label: 'Gmail',
      config: { type: 'stdio', command: 'npx', args: ['-y', 'gmail-mcp'], env: { GOOGLE_ACCESS_TOKEN: '{access_token}' } },
      secretNames: ['access_token'],
      credentialOwner: 'external',
    };

    // 1) An agent is hot-added.
    const withNewAgent = rawConfig() as { agents: Record<string, unknown>[] };
    withNewAgent.agents.push({
      id: 'newcomer',
      description: 'added while running',
      workspace: '/tmp/newcomer/workspace',
      env: '/tmp/newcomer/.env',
      claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
    });
    writeConfigFile(configPath, withNewAgent);
    // The snapshot getConfig() would have handed it, captured at that moment.
    watcher.reload();
    expect(handedToNewAgent).toHaveLength(1);
    const snapshotItWouldHaveGot = watcher.getConfig();

    // 2) A connector is connected afterwards.
    const afterConnect = withNewAgent as unknown as { gateway: Record<string, unknown> };
    afterConnect.gateway.customConnectors = { gmail: gmailEntry };
    writeConfigFile(configPath, afterConnect);
    watcher.reload();

    // The object the new agent was handed sees it...
    expect(handedToNewAgent[0]!.gateway.customConnectors).toEqual({ gmail: gmailEntry });
    // ...and the snapshot never will: reload() replaced currentConfig rather
    // than updating it, so the reference an agent captured is now orphaned.
    expect(snapshotItWouldHaveGot.gateway.customConnectors).toBeUndefined();
    expect(watcher.getConfig()).not.toBe(snapshotItWouldHaveGot);

    watcher.stop();
  });

  it('reports gateway.oauthReturnUrl as restart-required', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig());

    const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);
    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    writeConfigFile(configPath, rawConfig({ oauthReturnUrl: 'https://panel.example.com/connectors' }));
    watcher.reload();

    const changes: ConfigChange[] = changeSpy.mock.calls[0]?.[0] ?? [];
    expect(changes.find((c) => c.field === 'gateway.oauthReturnUrl')).toMatchObject({
      agentId: '',
      newValue: 'https://panel.example.com/connectors',
      hotReloadable: false,
    });

    watcher.stop();
  });

  // ---------------------------------------------------------------------------
  // U-CW-13: an unchanged gateway.logs block is not reported as a change
  // ---------------------------------------------------------------------------
  it('U-CW-13: an identical gateway.logs block produces no change', () => {
    const configPath = path.join(tmpDir, 'config.json');
    writeConfigFile(configPath, rawConfig({ logs: { level: 'warn', maxFiles: 2 } }));

    const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);
    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    // Same values, rewritten — deepEqual must see through the new object.
    writeConfigFile(configPath, rawConfig({ logs: { level: 'warn', maxFiles: 2 } }));
    watcher.reload();

    const changes: ConfigChange[] = changeSpy.mock.calls[0]?.[0] ?? [];
    expect(changes.find((c) => c.field === 'gateway.logs')).toBeUndefined();

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

  it('reports gateway.publicUrl changes as restart-required', () => {
    const configPath = path.join(tmpDir, 'config-public-url.json');
    writeConfigFile(configPath, rawConfig());
    const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);
    const changeSpy = jest.fn();
    watcher.on('changes', changeSpy);

    writeConfigFile(
      configPath,
      rawConfig({ publicUrl: 'https://vm.example.com/gateway' }),
    );
    watcher.reload();

    const changes: ConfigChange[] = changeSpy.mock.calls[0][0];
    expect(changes).toContainEqual(expect.objectContaining({
      agentId: '',
      field: 'gateway.publicUrl',
      oldValue: undefined,
      newValue: 'https://vm.example.com/gateway',
      hotReloadable: false,
    }));
    expect(logger.warn).toHaveBeenCalledWith(
      'Config changes require restart to take effect',
      expect.objectContaining({ fields: expect.arrayContaining(['gateway.publicUrl']) }),
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
      telegram: { botToken: 'tok' },
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
      telegram: { botToken: 'tok' },
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

  // ---------------------------------------------------------------------------
  // U-CW-11: per-agent .env files are refreshed before every reload (issue #427)
  //
  // MCP `agent_create` writes the real bot token to a brand-new
  // agents/<id>/.env and only a ${VAR} placeholder into config.json. A gateway
  // that was already running has never seen that variable, so before the fix
  // loadConfig() dropped the agent, the diff came back empty, and `agent.added`
  // — whose handler is what used to load the .env — never fired.
  // ---------------------------------------------------------------------------
  describe('U-CW-11: agent .env refresh on reload', () => {
    const OWNED_VARS = ['CARLOS_BOT_TOKEN', 'ALFRED_DISCORD_TOKEN', 'NOWHERE_BOT_TOKEN'];

    beforeEach(() => {
      for (const v of OWNED_VARS) delete process.env[v];
    });

    afterEach(() => {
      for (const v of OWNED_VARS) delete process.env[v];
    });

    /** Write agents/<id>/.env under the temp gateway root (sibling of config.json). */
    function writeAgentEnv(agentId: string, contents: string): void {
      const dir = path.join(tmpDir, 'agents', agentId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, '.env'), contents);
    }

    /** A raw agent entry whose telegram token is the given ${VAR} placeholder. */
    function rawAgentWithToken(id: string, tokenPlaceholder: string): Record<string, unknown> {
      return {
        id,
        description: `${id} bot`,
        workspace: `/tmp/${id}/workspace`,
        env: `/tmp/${id}/.env`,
        telegram: { botToken: tokenPlaceholder },
        claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
      };
    }

    it('U-CW-11a: emits agent.added for an agent whose token only exists in a new agents/<id>/.env', () => {
      const configPath = path.join(tmpDir, 'config.json');
      writeConfigFile(configPath, rawConfig());
      const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);

      const addedSpy = jest.fn();
      watcher.on('agent.added', addedSpy);

      // What agent_create does: token to a fresh .env, placeholder to config.json.
      writeAgentEnv('carlos', 'CARLOS_BOT_TOKEN=carlos-secret-token\n');
      const raw = rawConfig();
      (raw.agents as unknown[]).push(rawAgentWithToken('carlos', '${CARLOS_BOT_TOKEN}'));
      writeConfigFile(configPath, raw);

      expect(process.env.CARLOS_BOT_TOKEN).toBeUndefined();
      watcher.reload();

      expect(addedSpy).toHaveBeenCalledTimes(1);
      const added: AgentConfig = addedSpy.mock.calls[0][0];
      expect(added.id).toBe('carlos');
      // The placeholder must be resolved, not passed through verbatim — the
      // receiver would authenticate with the literal "${CARLOS_BOT_TOKEN}".
      expect(added.telegram!.botToken).toBe('carlos-secret-token');

      watcher.stop();
    });

    it('U-CW-11b: emits channel.added when an existing agent gains a channel whose token is in .env', () => {
      const configPath = path.join(tmpDir, 'config.json');
      writeConfigFile(configPath, rawConfig());
      const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);

      const channelSpy = jest.fn();
      watcher.on('channel.added', channelSpy);

      // What agent_update/add_channel does.
      writeAgentEnv('alfred', 'ALFRED_DISCORD_TOKEN=alfred-discord-secret\n');
      const raw = rawConfig();
      const alfred = (raw.agents as Record<string, unknown>[])[0];
      alfred.discord = { botToken: '${ALFRED_DISCORD_TOKEN}' };
      writeConfigFile(configPath, raw);

      watcher.reload();

      expect(channelSpy).toHaveBeenCalledWith('alfred', 'discord');
      expect(watcher.getConfig().agents[0].discord!.botToken).toBe('alfred-discord-secret');

      watcher.stop();
    });

    it('U-CW-11c: logs the skip and the missing variable when no .env resolves the placeholder', () => {
      const configPath = path.join(tmpDir, 'config.json');
      writeConfigFile(configPath, rawConfig());
      const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);

      const addedSpy = jest.fn();
      watcher.on('agent.added', addedSpy);

      // Placeholder with no .env anywhere: the agent must still be skipped
      // rather than crash the reload — but the skip has to be visible.
      const raw = rawConfig();
      (raw.agents as unknown[]).push(rawAgentWithToken('nowhere', '${NOWHERE_BOT_TOKEN}'));
      writeConfigFile(configPath, raw);

      expect(() => watcher.reload()).not.toThrow();

      expect(addedSpy).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
      expect(logger.warn).toHaveBeenCalledWith(
        'Agent skipped during config reload',
        { id: 'nowhere', reason: 'Missing environment variable: NOWHERE_BOT_TOKEN', missingVar: 'NOWHERE_BOT_TOKEN' },
      );
      // The healthy agents are untouched by their neighbour's bad token.
      expect(watcher.getConfig().agents.map(a => a.id)).toEqual(['alfred', 'baerbel']);

      watcher.stop();
    });

    it('U-CW-11d: does not let a per-agent .env overwrite a variable already in process.env', () => {
      const configPath = path.join(tmpDir, 'config.json');
      writeConfigFile(configPath, rawConfig());
      const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);

      const addedSpy = jest.fn();
      watcher.on('agent.added', addedSpy);

      // An operator-exported value must win over the file on disk, otherwise
      // reload would silently swap out a token the operator set deliberately.
      process.env.CARLOS_BOT_TOKEN = 'from-process-env';
      writeAgentEnv('carlos', 'CARLOS_BOT_TOKEN=from-dotenv\n');
      const raw = rawConfig();
      (raw.agents as unknown[]).push(rawAgentWithToken('carlos', '${CARLOS_BOT_TOKEN}'));
      writeConfigFile(configPath, raw);

      watcher.reload();

      expect(addedSpy).toHaveBeenCalledTimes(1);
      expect((addedSpy.mock.calls[0][0] as AgentConfig).telegram!.botToken).toBe('from-process-env');
      expect(process.env.CARLOS_BOT_TOKEN).toBe('from-process-env');

      watcher.stop();
    });

    it('U-CW-11e: swaps the receiver over to a rotated token without a restart', () => {
      const configPath = path.join(tmpDir, 'config.json');
      writeConfigFile(configPath, rawConfig());
      const watcher = new ConfigWatcher(configPath, loadConfig(configPath), logger);

      // agent_create: token A in a fresh .env, placeholder in config.json.
      writeAgentEnv('carlos', 'CARLOS_BOT_TOKEN=token-a\n');
      const withCarlos = rawConfig();
      (withCarlos.agents as unknown[]).push(rawAgentWithToken('carlos', '${CARLOS_BOT_TOKEN}'));
      writeConfigFile(configPath, withCarlos);
      watcher.reload();
      expect(watcher.getConfig().agents.find(a => a.id === 'carlos')!.telegram!.botToken)
        .toBe('token-a');

      // Token A is revoked. agent_update remove_channel strips the .env line
      // and drops the channel from config.json...
      const withoutChannel = rawConfig();
      const carlosRaw = rawAgentWithToken('carlos', '${CARLOS_BOT_TOKEN}');
      delete carlosRaw.telegram;
      (withoutChannel.agents as unknown[]).push(carlosRaw);
      writeAgentEnv('carlos', '');
      writeConfigFile(configPath, withoutChannel);
      watcher.reload();

      // ...then add_channel writes token B and puts the same placeholder back.
      const channelSpy = jest.fn();
      watcher.on('channel.added', channelSpy);
      writeAgentEnv('carlos', 'CARLOS_BOT_TOKEN=token-b\n');
      writeConfigFile(configPath, withCarlos);
      watcher.reload();

      // Before the ownership ledger this resolved to the revoked token-a: the
      // reload reported success, the receiver started, and every poll 401'd.
      expect(channelSpy).toHaveBeenCalledWith('carlos', 'telegram');
      expect(watcher.getConfig().agents.find(a => a.id === 'carlos')!.telegram!.botToken)
        .toBe('token-b');

      watcher.stop();
    });
  });
});
