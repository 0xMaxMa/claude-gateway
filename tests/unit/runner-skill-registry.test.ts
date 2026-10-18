/**
 * A workspace/skills reload replaces the runner's skill registry. The CLI/extension
 * skills discovered for it must survive the swap: skill-learning's reviewer reads them
 * to avoid re-learning a plugin skill, and ingress resolves /commands against them.
 *
 * HistoryDB is mocked for the same node:sqlite reason as runner-disable-archive.test.ts.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

jest.mock('../../src/history/db', () => ({
  HistoryDB: {
    forDir: jest.fn(() => ({ insertMessage: jest.fn() })),
    forAgent: jest.fn(() => ({ insertMessage: jest.fn() })),
  },
}));

import { AgentRunner } from '../../src/agent/runner';
import type { AgentConfig, GatewayConfig } from '../../src/types';

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'runner-skill-registry-')); });
afterEach(() => fs.rmSync(tmpDir, { recursive: true, force: true }));

function makeRunner(): AgentRunner {
  const workspace = path.join(tmpDir, 'agents', 'bot', 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const agent: AgentConfig = {
    id: 'bot', description: 'test', workspace, env: '',
    telegram: { botToken: 'test-token' },
    claude: { model: 'claude-opus-4-6', dangerouslySkipPermissions: false, extraFlags: [] },
  };
  const gateway: GatewayConfig = { gateway: { orchestration: false, logDir: path.join(tmpDir, 'logs'), timezone: 'UTC' }, agents: [] };
  return new AgentRunner(agent, gateway);
}

describe('AgentRunner.setSkillRegistry', () => {
  const cliSkills = [{ name: 'pstack:tdd', description: 'tdd' }];

  it('a reloaded workspace registry keeps the CLI skills discovered before it', () => {
    const runner = makeRunner();
    runner.setSkillRegistry({ skills: new Map(), cliSkills, extensionServers: ['x'], extensionNotices: [] });
    const reloaded = { skills: new Map([['learned', {} as never]]), hiddenUntilUsed: new Set(['learned']) };
    runner.setSkillRegistry(reloaded);
    expect(runner.getSkillRegistry()).toMatchObject({ cliSkills, extensionServers: ['x'], hiddenUntilUsed: new Set(['learned']) });
    expect(runner.getSkillRegistry().skills.has('learned')).toBe(true);
  });

  it('a registry with its own CLI list (or a failed discovery) replaces the old one', () => {
    const runner = makeRunner();
    runner.setSkillRegistry({ skills: new Map(), cliSkills });
    runner.setSkillRegistry({ skills: new Map(), cliSkills: [] , cliDiscoveryError: 'CLI_SKILL_DISCOVERY_UNAVAILABLE' });
    expect(runner.getSkillRegistry()).toMatchObject({ cliSkills: [], cliDiscoveryError: 'CLI_SKILL_DISCOVERY_UNAVAILABLE' });
  });
});

describe('AgentRunner.recomposeWorkspace', () => {
  it('runs the wired workspace recomposer, and reports false when none is wired', async () => {
    const runner = makeRunner();
    await expect(runner.recomposeWorkspace()).resolves.toBe(false);
    const recompose = jest.fn(async () => undefined);
    runner.setWorkspaceRecomposer(recompose);
    await expect(runner.recomposeWorkspace()).resolves.toBe(true);
    expect(recompose).toHaveBeenCalledTimes(1);
  });
});
