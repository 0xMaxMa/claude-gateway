import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

/** The direct reply, or a marker once 3 s pass; the timer is cleared either way (third review of #591, L13). */
async function replyOrTimeout(response: Promise<unknown>): Promise<unknown> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([response.catch(() => 'model turn'), new Promise<string>(resolve => { timer = setTimeout(() => resolve('no direct reply'), 3000); })]);
  } finally { clearTimeout(timer); }
}

/**
 * Dev e2e of #591: an agent that was not set up still listed pstack's skills in
 * its decision-turn catalog (the CLI skill probe had no pstack gate), so
 * `/pstack:why` was accepted and a worker read the plugin's SKILL.md from disk.
 */

const settingsOf = (args: string[]) => JSON.parse(args[args.indexOf('--settings') + 1]);

describe('CLI skill discovery gates pstack like the worker', () => {
  const child = require('child_process') as typeof import('child_process');
  afterEach(() => jest.restoreAllMocks());
  const probeArgs = async (pstack?: object) => {
    const { discoverCliSkills } = await import('../../../src/orchestration/cli-skills');
    const spawn = jest.spyOn(child, 'spawn').mockImplementation(() => { throw new Error('captured'); });
    const cwd = mkdtempSync(join(tmpdir(), 'pstack-probe-'));
    try {
      const agent = { id: 'a', workspace: cwd, claude: { model: 'm' }, orchestration: { tasks: { workspaceMode: 'host' } }, ...(pstack ? { pstack } : {}) } as unknown as AgentConfig;
      await expect(discoverCliSkills(agent)).rejects.toThrow('captured');
      return spawn.mock.calls[0][1] as string[];
    } finally { rmSync(cwd, { recursive: true, force: true }); }
  };

  test('an agent that is not set up probes with pstack off', async () => {
    expect(settingsOf(await probeArgs()).enabledPlugins).toEqual({ 'pstack@pstack-claude': false });
  });

  test('a set-up agent probes with pstack on', async () => {
    expect(settingsOf(await probeArgs({})).enabledPlugins).toEqual({ 'pstack@pstack-claude': true });
  });
});

async function fixture(pstack?: object) {
  const root = mkdtempSync(join(tmpdir(), 'pstack-ingress-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] }, orchestration: {}, ...(pstack ? { pstack } : {}) } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const createAgentSession = jest.fn(async () => { throw new Error('no model turn in this test'); });
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, { createAgentSession, releaseAgentSession: async () => {} });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'telegram' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  return { runtime, scope, createAgentSession, close: async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); } };
}

describe('an explicit /pstack: command on an agent that is not set up', () => {
  test.each(['/pstack:why the build is slow', '/pstack:interrogate@claude_bot src/a.ts'])('%s is answered without a model turn or task', async text => {
    const f = await fixture();
    try {
      const submitted = f.runtime.submitInput({ scope: f.scope, text, ingressKey: 'm1' }, { execute: true, writeMemory: false });
      const reply = await replyOrTimeout(submitted.response);
      expect(reply).toContain('pstack is not set up for this agent');
      // Telegram links a tapped command only up to the first '-', so it names the tappable spelling.
      expect(reply).toContain('/pstack_setup in a direct message');
      expect(f.createAgentSession).not.toHaveBeenCalled();
      expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(0);
      expect(f.runtime.store.get("SELECT COUNT(*) n FROM conversation_inputs WHERE status='accepted'")!.n).toBe(0);
    } finally { await f.close(); }
  });

  test('a set-up agent and other commands are not intercepted', async () => {
    const { pstackNotSetUpReply } = await import('../../../src/pstack/overlay');
    expect(pstackNotSetUpReply('/pstack:why x', 'telegram', {})).toBeUndefined();
    expect(pstackNotSetUpReply('/pstack-setup on', 'telegram', undefined)).toBeUndefined();
    expect(pstackNotSetUpReply('/code-review', 'telegram', undefined)).toBeUndefined();
    expect(pstackNotSetUpReply('please run pstack:why', 'telegram', undefined)).toBeUndefined();
    expect(pstackNotSetUpReply('/pstack:why', 'api', undefined)).toContain('/pstack-setup on (needs an API key with write access to this agent) or PUT /api/v1/agents/<agent-id>/pstack');
    expect(pstackNotSetUpReply('/pstack:why', 'discord', undefined)).toContain('/pstack-setup in a direct message');
  });
});

// Dev e2e of #591 (G2): pstack's principle-* skills are `user-invocable: false`.
// An explicit `/pstack:principle-*` went to the agent's decision turn and once
// timed out there; like Claude Code, it is not a command, and the gateway says so at once.
describe('an explicit /pstack: command for a skill that is not user-invocable', () => {
  const { pstackClaudeConfig } = require('../../helpers/pstack-fixture');
  let plugin: { configDir: string; installPath: string; cleanup: () => void }, previous: string | undefined;
  beforeEach(() => {
    plugin = pstackClaudeConfig(); previous = process.env.CLAUDE_CONFIG_DIR; process.env.CLAUDE_CONFIG_DIR = plugin.configDir;
    for (const [name, invocable] of [['principle-attack-the-premise', false], ['how', true]] as const) {
      mkdirSync(join(plugin.installPath, 'skills', name), { recursive: true });
      writeFileSync(join(plugin.installPath, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n${invocable ? '' : 'user-invocable: false\n'}---\n\nBody\n`);
    }
  });
  afterEach(() => { if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = previous; plugin.cleanup(); });

  test('a set-up agent answers it without a model turn or task', async () => {
    const f = await fixture({});
    try {
      const submitted = f.runtime.submitInput({ scope: f.scope, text: '/pstack:principle-attack-the-premise check this plan', ingressKey: 'm1' }, { execute: true, writeMemory: false });
      const reply = await replyOrTimeout(submitted.response);
      expect(reply).toContain('/pstack:principle-attack-the-premise');
      expect(reply).toContain('not a command');
      expect(f.createAgentSession).not.toHaveBeenCalled();
      expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(0);
    } finally { await f.close(); }
  });

  test('user-invocable skills and agents that are not set up are left alone', async () => {
    const { pstackCommandReply } = await import('../../../src/pstack/overlay');
    expect(pstackCommandReply('/pstack:how x', 'telegram', {})).toBeUndefined();
    expect(pstackCommandReply('/pstack:principle-attack-the-premise', 'telegram', undefined)).toBeUndefined();
    expect(pstackCommandReply('/pstack:nope', 'telegram', undefined)).toBeUndefined();
    expect(pstackCommandReply('/code-review', 'telegram', {})).toBeUndefined();
    expect(pstackCommandReply('/pstack:../../etc', 'telegram', {})).toBeUndefined(); // not a command shape
    expect(pstackCommandReply('/pstack:principle-attack-the-premise@claude_bot', 'telegram', {})).toContain('not a command');
  });

  // Dev e2e of #591: an unknown `/pstack:<name>` went to the decision turn, which once
  // spawned a task to search for it. Claude Code rejects an unknown command at once.
  test('an unknown name is answered without a model turn or task', async () => {
    const f = await fixture({});
    try {
      const submitted = f.runtime.submitInput({ scope: f.scope, text: '/pstack:principle-boring-tech', ingressKey: 'm1' }, { execute: true, writeMemory: false });
      const reply = await replyOrTimeout(submitted.response);
      expect(reply).toContain('/pstack:principle-boring-tech is not a pstack command');
      expect(f.createAgentSession).not.toHaveBeenCalled();
      expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(0);
    } finally { await f.close(); }
  });

  // Dev e2e of #591: a one-letter typo (/pstack:reflct) got no suggestion from substring matching.
  test('a misspelled name suggests the nearest user-invocable commands', async () => {
    for (const name of ['reflect', 'interrogate', 'why', 'poteto-help', 'poteto-mode']) {
      mkdirSync(join(plugin.installPath, 'skills', name), { recursive: true });
      writeFileSync(join(plugin.installPath, 'skills', name, 'SKILL.md'), `---\nname: ${name}\ndescription: fixture\n---\n\nBody\n`);
    }
    const { pstackCommandReply } = await import('../../../src/pstack/overlay');
    expect(pstackCommandReply('/pstack:reflct', 'telegram', {})).toContain('Did you mean /pstack:reflect?');
    expect(pstackCommandReply('/pstack:refelct', 'telegram', {})).toContain('Did you mean /pstack:reflect?');
    expect(pstackCommandReply('/pstack:interogate', 'telegram', {})).toContain('Did you mean /pstack:interrogate?');
    expect(pstackCommandReply('/pstack:hwo', 'telegram', {})).toContain('Did you mean /pstack:how?');
    // The nearest name comes first, ahead of names that only share a word.
    expect(pstackCommandReply('/pstack:poteto-mod', 'telegram', {})).toContain('Did you mean /pstack:poteto-mode, /pstack:poteto-help?');
    // Too far from every name, or only near a skill that is not user-invocable: no guess.
    expect(pstackCommandReply('/pstack:deploy', 'telegram', {})).not.toContain('Did you mean');
    expect(pstackCommandReply('/pstack:principle-atack-the-premise', 'telegram', {})).not.toContain('Did you mean');
  });

  test('an unknown name suggests close user-invocable commands', async () => {
    const { pstackCommandReply } = await import('../../../src/pstack/overlay');
    expect(pstackCommandReply('/pstack:ho', 'telegram', {})).toContain('Did you mean /pstack:how?');
    expect(pstackCommandReply('/pstack:principle-attack', 'telegram', {})).not.toContain('Did you mean');
    for (const text of ['/pstack:nope', '/pstack:a:b', '/pstack:', '/pstack:..']) expect(pstackCommandReply(text, 'telegram', {})).toContain('is not a pstack command');
    // An unreadable skill list proves nothing about the name; the agent decides.
    rmSync(join(plugin.installPath, 'skills'), { recursive: true, force: true });
    expect(pstackCommandReply('/pstack:nope', 'telegram', {})).toBeUndefined();
  });
});
