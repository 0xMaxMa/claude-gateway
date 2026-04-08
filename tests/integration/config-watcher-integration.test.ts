/**
 * Integration tests: ConfigWatcher
 *
 * Test IDs: I-CW-01 through I-CW-04
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ConfigWatcher, ConfigChange } from '../../src/config-watcher';
import { GatewayConfig, Logger } from '../../src/types';
import { loadConfig } from '../../src/config-loader';

// ─── helpers ────────────────────────────────────────────────────────────────

const FIXTURE_PATH = path.resolve(__dirname, '../fixtures/configs/valid-2-agents.json');

function createMockLogger(): Logger & {
  calls: { info: unknown[][]; warn: unknown[][]; error: unknown[][]; debug: unknown[][] };
} {
  const calls = { info: [] as unknown[][], warn: [] as unknown[][], error: [] as unknown[][], debug: [] as unknown[][] };
  return {
    calls,
    info: (...args: unknown[]) => { calls.info.push(args); },
    warn: (...args: unknown[]) => { calls.warn.push(args); },
    error: (...args: unknown[]) => { calls.error.push(args); },
    debug: (...args: unknown[]) => { calls.debug.push(args); },
  };
}

function createTempConfig(): { configPath: string; cleanup: () => void } {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-test-'));
  const configPath = path.join(tmpDir, 'config.json');
  fs.copyFileSync(FIXTURE_PATH, configPath);
  return {
    configPath,
    cleanup: () => fs.rmSync(tmpDir, { recursive: true, force: true }),
  };
}

/**
 * Read the temp config file, parse it, apply a mutation, and write it back.
 * Works on the raw JSON (before env interpolation) so ${VAR} placeholders are preserved.
 */
function mutateConfigFile(
  configPath: string,
  mutator: (raw: Record<string, unknown>) => void,
): void {
  const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  mutator(raw);
  fs.writeFileSync(configPath, JSON.stringify(raw, null, 2), 'utf-8');
}

// ─── tests ──────────────────────────────────────────────────────────────────

describe('config-watcher integration', () => {
  let configPath: string;
  let cleanup: () => void;
  let logger: ReturnType<typeof createMockLogger>;
  let initialConfig: GatewayConfig;
  let watcher: ConfigWatcher;

  const ALFRED_TOKEN = 'test-alfred-token-12345';
  const BAERBEL_TOKEN = 'test-baerbel-token-67890';

  beforeEach(() => {
    process.env.ALFRED_BOT_TOKEN = ALFRED_TOKEN;
    process.env.BAERBEL_BOT_TOKEN = BAERBEL_TOKEN;

    const tmp = createTempConfig();
    configPath = tmp.configPath;
    cleanup = tmp.cleanup;

    logger = createMockLogger();
    initialConfig = loadConfig(configPath);
    watcher = new ConfigWatcher(configPath, initialConfig, logger);
  });

  afterEach(() => {
    watcher.stop();
    delete process.env.ALFRED_BOT_TOKEN;
    delete process.env.BAERBEL_BOT_TOKEN;
    cleanup();
  });

  // ── I-CW-01: Change model in config.json ──────────────────────────────

  it('I-CW-01: emits changes when model is updated and new config reflects the new model', () => {
    const NEW_MODEL = 'claude-sonnet-4-20250514';

    // Mutate the config file: change alfred's model
    mutateConfigFile(configPath, (raw) => {
      const agents = raw.agents as Record<string, unknown>[];
      const alfred = agents.find((a) => a.id === 'alfred')!;
      (alfred.claude as Record<string, unknown>).model = NEW_MODEL;
    });

    // Collect emitted changes
    const emitted: { changes: ConfigChange[]; newConfig: GatewayConfig }[] = [];
    watcher.on('changes', (changes: ConfigChange[], newConfig: GatewayConfig) => {
      emitted.push({ changes, newConfig });
    });

    // Trigger reload
    watcher.reload();

    // Should have emitted exactly one event
    expect(emitted).toHaveLength(1);
    const { changes, newConfig } = emitted[0];

    // Find the model change
    const modelChange = changes.find((c) => c.agentId === 'alfred' && c.field === 'claude.model');
    expect(modelChange).toBeDefined();
    expect(modelChange!.oldValue).toBe('claude-opus-4-6');
    expect(modelChange!.newValue).toBe(NEW_MODEL);
    expect(modelChange!.hotReloadable).toBe(true);

    // The watcher's internal config should be updated
    const updatedConfig = watcher.getConfig();
    const alfredAgent = updatedConfig.agents.find((a) => a.id === 'alfred')!;
    expect(alfredAgent.claude.model).toBe(NEW_MODEL);

    // Simulate what index.ts would do: apply changes to an agentConfig object
    const agentConfig = structuredClone(initialConfig.agents.find((a) => a.id === 'alfred')!);
    expect(agentConfig.claude.model).toBe('claude-opus-4-6'); // before
    // Apply the new model from newConfig
    const newAlfred = newConfig.agents.find((a) => a.id === 'alfred')!;
    agentConfig.claude.model = newAlfred.claude.model;
    expect(agentConfig.claude.model).toBe(NEW_MODEL); // after

    // Logger should have logged hot-reload info
    const infoCall = logger.calls.info.find(
      (args) => typeof args[0] === 'string' && args[0].includes('hot-reloaded'),
    );
    expect(infoCall).toBeDefined();
  });

  // ── I-CW-02: Change API key in config.json ────────────────────────────

  it('I-CW-02: emits changes when botToken is updated (not hot-reloadable)', () => {
    const NEW_TOKEN = 'new-alfred-token-updated';

    // Update the env var so loadConfig picks up the new value
    process.env.ALFRED_BOT_TOKEN = NEW_TOKEN;

    // Re-write the config file (content unchanged, but env var changed)
    // Since the fixture uses ${ALFRED_BOT_TOKEN}, reloading with the new env var
    // produces a different botToken value
    watcher.reload();

    // Check that the watcher detected the botToken change
    const updatedConfig = watcher.getConfig();
    const alfredAgent = updatedConfig.agents.find((a) => a.id === 'alfred')!;
    expect(alfredAgent.telegram.botToken).toBe(NEW_TOKEN);

    // Check that the change was flagged as not hot-reloadable
    const warnCall = logger.calls.warn.find(
      (args) => typeof args[0] === 'string' && args[0].includes('restart'),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toEqual(
      expect.objectContaining({
        fields: expect.arrayContaining(['alfred.telegram.botToken']),
      }),
    );
  });

  // ── I-CW-03: Change botToken in config.json ───────────────────────────

  it('I-CW-03: logs warning "restart required" when a non-hot-reloadable field changes', () => {
    // Change workspace (non-hot-reloadable field) for baerbel
    mutateConfigFile(configPath, (raw) => {
      const agents = raw.agents as Record<string, unknown>[];
      const baerbel = agents.find((a) => a.id === 'baerbel')!;
      baerbel.workspace = '/tmp/baerbel/new-workspace';
    });

    const emitted: ConfigChange[][] = [];
    watcher.on('changes', (changes: ConfigChange[]) => {
      emitted.push(changes);
    });

    watcher.reload();

    expect(emitted).toHaveLength(1);

    const workspaceChange = emitted[0].find(
      (c) => c.agentId === 'baerbel' && c.field === 'workspace',
    );
    expect(workspaceChange).toBeDefined();
    expect(workspaceChange!.hotReloadable).toBe(false);
    expect(workspaceChange!.oldValue).toBe('/tmp/baerbel/workspace');
    expect(workspaceChange!.newValue).toBe('/tmp/baerbel/new-workspace');

    // Logger should warn about restart
    const warnCall = logger.calls.warn.find(
      (args) => typeof args[0] === 'string' && args[0].includes('restart'),
    );
    expect(warnCall).toBeDefined();
    expect(warnCall![1]).toEqual(
      expect.objectContaining({
        fields: expect.arrayContaining(['baerbel.workspace']),
      }),
    );
  });

  // ── I-CW-04: config.json becomes invalid → fix back to valid ──────────

  it('I-CW-04: reload keeps current config on invalid JSON, then succeeds when fixed', () => {
    const configBefore = watcher.getConfig();

    // Write invalid JSON
    fs.writeFileSync(configPath, '{ this is not valid json !!!', 'utf-8');

    watcher.reload();

    // Config should remain unchanged
    const configAfterBadReload = watcher.getConfig();
    expect(configAfterBadReload).toEqual(configBefore);

    // Logger should have logged an error
    const errorCall = logger.calls.error.find(
      (args) => typeof args[0] === 'string' && args[0].includes('Config reload failed'),
    );
    expect(errorCall).toBeDefined();

    // No 'changes' event should have been emitted
    let changesEmitted = false;
    watcher.on('changes', () => { changesEmitted = true; });

    // Now fix the config: restore from fixture and apply a change
    const NEW_MODEL = 'claude-haiku-4-20250514';
    fs.copyFileSync(FIXTURE_PATH, configPath);
    mutateConfigFile(configPath, (raw) => {
      const agents = raw.agents as Record<string, unknown>[];
      const alfred = agents.find((a) => a.id === 'alfred')!;
      (alfred.claude as Record<string, unknown>).model = NEW_MODEL;
    });

    watcher.reload();

    // Now the config should be updated with the new model
    const configAfterFix = watcher.getConfig();
    const alfredAgent = configAfterFix.agents.find((a) => a.id === 'alfred')!;
    expect(alfredAgent.claude.model).toBe(NEW_MODEL);

    // Changes event should have fired on the good reload
    // (we attached the listener after the bad reload, so changesEmitted tracks only the fix)
    expect(changesEmitted).toBe(true);

    // Logger info should mention hot-reload
    const infoCall = logger.calls.info.find(
      (args) => typeof args[0] === 'string' && args[0].includes('hot-reloaded'),
    );
    expect(infoCall).toBeDefined();
  });

  // ── Edge case: no effective changes ────────────────────────────────────

  it('does not emit changes when config file is rewritten with identical content', () => {
    let changesEmitted = false;
    watcher.on('changes', () => { changesEmitted = true; });

    // Reload with same content
    watcher.reload();

    expect(changesEmitted).toBe(false);

    // Logger should note no differences
    const infoCall = logger.calls.info.find(
      (args) => typeof args[0] === 'string' && args[0].includes('no effective differences'),
    );
    expect(infoCall).toBeDefined();
  });
});
