/**
 * Unit tests for agent.added event in ConfigWatcher (hot-add support).
 */

import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { ConfigWatcher } from '../../src/config/watcher';
import { GatewayConfig, AgentConfig, Logger } from '../../src/types';
import { loadConfig } from '../../src/config/loader';

const BOT_TOKEN = 'test-token-value';

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

function makeRawConfig(agents: unknown[]): Record<string, unknown> {
  return {
    gateway: { logDir: '/tmp/test-logs', timezone: 'UTC' },
    agents,
  };
}

function makeAgent(id: string, model = 'claude-sonnet-4-6'): Record<string, unknown> {
  process.env[`${id.toUpperCase()}_BOT_TOKEN`] = BOT_TOKEN;
  return {
    id,
    description: `Agent ${id}`,
    workspace: `/tmp/${id}/workspace`,
    env: '',
    telegram: {
      botToken: `\${${id.toUpperCase()}_BOT_TOKEN}`,
      allowedUsers: [],
      dmPolicy: 'open',
    },
    claude: {
      model,
      dangerouslySkipPermissions: true,
      extraFlags: [],
    },
  };
}

let tmpDir: string;
let logger: ReturnType<typeof createMockLogger>;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cw-hotadd-test-'));
  logger = createMockLogger();
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  delete process.env.ALFRED_BOT_TOKEN;
  delete process.env.HELPER_BOT_TOKEN;
  delete process.env.NEWBOT_BOT_TOKEN;
});

describe('ConfigWatcher — agent.added event', () => {
  function writeJson(filePath: string, obj: unknown) {
    fs.writeFileSync(filePath, JSON.stringify(obj, null, 2), 'utf8');
  }

  // AMW-01: new agent appended to config emits agent.added
  it('AMW-01: emits agent.added when a new agent is appended to config.json', () => {
    const configPath = path.join(tmpDir, 'config.json');

    writeJson(configPath, makeRawConfig([makeAgent('alfred')]));
    const initial = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initial, logger);

    const addedSpy = jest.fn();
    watcher.on('agent.added', addedSpy);

    // Append new agent
    writeJson(configPath, makeRawConfig([makeAgent('alfred'), makeAgent('helper')]));
    watcher.reload();

    expect(addedSpy).toHaveBeenCalledTimes(1);
    const emittedAgent: AgentConfig = addedSpy.mock.calls[0][0];
    expect(emittedAgent.id).toBe('helper');

    watcher.stop();
  });

  // AMW-02: agent.added does NOT emit for existing agents
  it('AMW-02: does not emit agent.added for existing agents', () => {
    const configPath = path.join(tmpDir, 'config.json');

    writeJson(configPath, makeRawConfig([makeAgent('alfred'), makeAgent('helper')]));
    const initial = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initial, logger);

    const addedSpy = jest.fn();
    watcher.on('agent.added', addedSpy);

    // Change a field — no new agent
    writeJson(configPath, makeRawConfig([makeAgent('alfred', 'claude-opus-4-6'), makeAgent('helper')]));
    watcher.reload();

    expect(addedSpy).not.toHaveBeenCalled();

    watcher.stop();
  });

  // AMW-03: both agent.added AND changes emit when config has both new agent and field change
  it('AMW-03: emits both agent.added and changes when config has new agent and field changes simultaneously', () => {
    const configPath = path.join(tmpDir, 'config.json');

    writeJson(configPath, makeRawConfig([makeAgent('alfred')]));
    const initial = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initial, logger);

    const addedSpy = jest.fn();
    const changesSpy = jest.fn();
    watcher.on('agent.added', addedSpy);
    watcher.on('changes', changesSpy);

    // Change alfred's model AND add new agent
    writeJson(
      configPath,
      makeRawConfig([makeAgent('alfred', 'claude-opus-4-6'), makeAgent('newbot')]),
    );
    watcher.reload();

    expect(addedSpy).toHaveBeenCalledTimes(1);
    expect(changesSpy).toHaveBeenCalledTimes(1);

    const emittedNew: AgentConfig = addedSpy.mock.calls[0][0];
    expect(emittedNew.id).toBe('newbot');

    watcher.stop();
  });

  // AMW-04: currentConfig updates when only new agents are added (no field changes)
  it('AMW-04: updates currentConfig when only new agents are added', () => {
    const configPath = path.join(tmpDir, 'config.json');

    writeJson(configPath, makeRawConfig([makeAgent('alfred')]));
    const initial = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initial, logger);

    watcher.on('agent.added', jest.fn());

    // Add new agent — no field changes
    writeJson(configPath, makeRawConfig([makeAgent('alfred'), makeAgent('helper')]));
    watcher.reload();

    // currentConfig should now include the new agent
    const current = watcher.getConfig();
    expect(current.agents.map((a) => a.id)).toContain('helper');

    // Reload again with same config — should NOT emit again
    const addedSpy2 = jest.fn();
    watcher.on('agent.added', addedSpy2);
    watcher.reload();
    expect(addedSpy2).not.toHaveBeenCalled();

    watcher.stop();
  });

  // AMW-05: adding two agents simultaneously emits agent.added twice
  it('AMW-05: emits agent.added once per new agent when multiple are added', () => {
    const configPath = path.join(tmpDir, 'config.json');

    writeJson(configPath, makeRawConfig([makeAgent('alfred')]));
    const initial = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initial, logger);

    const addedSpy = jest.fn();
    watcher.on('agent.added', addedSpy);

    writeJson(
      configPath,
      makeRawConfig([makeAgent('alfred'), makeAgent('helper'), makeAgent('newbot')]),
    );
    watcher.reload();

    expect(addedSpy).toHaveBeenCalledTimes(2);
    const ids = addedSpy.mock.calls.map((c: [AgentConfig]) => c[0].id);
    expect(ids).toContain('helper');
    expect(ids).toContain('newbot');

    watcher.stop();
  });

  // AMW-06: no agent.added when config is identical
  it('AMW-06: does not emit agent.added when config is identical', () => {
    const configPath = path.join(tmpDir, 'config.json');

    writeJson(configPath, makeRawConfig([makeAgent('alfred')]));
    const initial = loadConfig(configPath);
    const watcher = new ConfigWatcher(configPath, initial, logger);

    const addedSpy = jest.fn();
    watcher.on('agent.added', addedSpy);

    // Write identical config
    writeJson(configPath, makeRawConfig([makeAgent('alfred')]));
    watcher.reload();

    expect(addedSpy).not.toHaveBeenCalled();

    watcher.stop();
  });
});
