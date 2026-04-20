/**
 * Tests for update-agent-channel script.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  detectConnectedChannels,
  removeChannel,
  findAgent,
  loadConfig,
} from '../../scripts/update-agent-channel';

describe('detectConnectedChannels()', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-test-'));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeAgent(overrides: Partial<{ telegram: any; discord: any }>): Parameters<typeof detectConnectedChannels>[0] {
    return {
      id: 'test-agent',
      workspace: tmpDir,
      ...overrides,
    };
  }

  it('UAC1: returns [] when no channels configured', () => {
    const agent = makeAgent({});
    expect(detectConnectedChannels(agent)).toEqual([]);
  });

  it('UAC2: returns ["telegram"] when telegram config exists', () => {
    const agent = makeAgent({ telegram: { botToken: '123:abc', allowedUsers: [], dmPolicy: 'open' } });
    expect(detectConnectedChannels(agent)).toEqual(['telegram']);
  });

  it('UAC3: returns ["discord"] when discord config exists', () => {
    const agent = makeAgent({ discord: { botToken: 'abc.def.ghi' } });
    expect(detectConnectedChannels(agent)).toEqual(['discord']);
  });

  it('UAC4: returns both when both channels configured', () => {
    const agent = makeAgent({
      telegram: { botToken: '123:abc', allowedUsers: [], dmPolicy: 'open' },
      discord: { botToken: 'abc.def.ghi' },
    });
    const result = detectConnectedChannels(agent);
    expect(result).toContain('telegram');
    expect(result).toContain('discord');
  });

  it('UAC5: detects telegram via .env file even without config field', () => {
    const stateDir = path.join(tmpDir, '.telegram-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.env'), 'TELEGRAM_BOT_TOKEN=123:abc\n');
    const agent = makeAgent({});
    expect(detectConnectedChannels(agent)).toContain('telegram');
  });

  it('UAC6: detects discord via .env file even without config field', () => {
    const stateDir = path.join(tmpDir, '.discord-state');
    fs.mkdirSync(stateDir, { recursive: true });
    fs.writeFileSync(path.join(stateDir, '.env'), 'DISCORD_BOT_TOKEN=abc.def.ghi\n');
    const agent = makeAgent({});
    expect(detectConnectedChannels(agent)).toContain('discord');
  });
});

describe('removeChannel()', () => {
  let tmpDir: string;
  let configFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gw-remove-'));
    configFile = path.join(tmpDir, 'config.json');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeConfig(agentId: string, workspace: string): Parameters<typeof removeChannel>[0] {
    const config = {
      gateway: { logDir: '~/logs', timezone: 'UTC' },
      agents: [
        {
          id: agentId,
          workspace,
          telegram: { botToken: '123:abc', allowedUsers: [], dmPolicy: 'open' },
          discord: { botToken: 'abc.def.ghi' },
          claude: { model: 'claude-sonnet-4-6', dangerouslySkipPermissions: true, extraFlags: [] },
        },
      ],
    };
    fs.writeFileSync(configFile, JSON.stringify(config, null, 2));
    process.env['GATEWAY_CONFIG'] = configFile;
    return config as any;
  }

  afterEach(() => {
    delete process.env['GATEWAY_CONFIG'];
  });

  it('UAC7: removeChannel("telegram") deletes .telegram-state/', () => {
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(path.join(wsDir, '.telegram-state'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.telegram-state', 'access.json'), '{}');

    const config = makeConfig('test-agent', wsDir);
    const agent = config.agents[0];

    removeChannel(config as any, agent as any, 'telegram');

    expect(fs.existsSync(path.join(wsDir, '.telegram-state'))).toBe(false);
  });

  it('UAC8: removeChannel("telegram") clears telegram field in config', () => {
    const wsDir = path.join(tmpDir, 'workspace');
    fs.mkdirSync(wsDir, { recursive: true });

    const config = makeConfig('test-agent', wsDir);
    const agent = config.agents[0];

    removeChannel(config as any, agent as any, 'telegram');

    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(onDisk.agents[0].telegram).toBeUndefined();
  });

  it('UAC9: removeChannel("discord") deletes .discord-state/', () => {
    const wsDir = path.join(tmpDir, 'workspace2');
    fs.mkdirSync(path.join(wsDir, '.discord-state'), { recursive: true });
    fs.writeFileSync(path.join(wsDir, '.discord-state', 'access.json'), '{}');

    const config = makeConfig('test-agent', wsDir);
    const agent = config.agents[0];

    removeChannel(config as any, agent as any, 'discord');

    expect(fs.existsSync(path.join(wsDir, '.discord-state'))).toBe(false);
  });

  it('UAC10: removeChannel("discord") clears discord field in config', () => {
    const wsDir = path.join(tmpDir, 'workspace3');
    fs.mkdirSync(wsDir, { recursive: true });

    const config = makeConfig('test-agent', wsDir);
    const agent = config.agents[0];

    removeChannel(config as any, agent as any, 'discord');

    const onDisk = JSON.parse(fs.readFileSync(configFile, 'utf8'));
    expect(onDisk.agents[0].discord).toBeUndefined();
  });
});

describe('findAgent()', () => {
  it('UAC11: finds agent by id', () => {
    const config = {
      agents: [
        { id: 'alfred', workspace: '~/alfred' },
        { id: 'butler', workspace: '~/butler' },
      ],
    };
    expect(findAgent(config as any, 'alfred')?.id).toBe('alfred');
    expect(findAgent(config as any, 'butler')?.id).toBe('butler');
  });

  it('UAC12: returns undefined for unknown agent', () => {
    const config = { agents: [{ id: 'alfred', workspace: '~/alfred' }] };
    expect(findAgent(config as any, 'nonexistent')).toBeUndefined();
  });
});
