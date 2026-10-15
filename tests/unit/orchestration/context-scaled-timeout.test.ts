import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import * as processTurn from '../../../src/orchestration/process-turn';
import { contextScaledTimeouts, resolveOrchestrationConfig } from '../../../src/orchestration/config';
import { recordTokenTurn } from '../../../src/orchestration/token-ledger';
import { AgentCliSessions } from '../../../src/orchestration/agent-cli-session';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Session a3a24184 (shadow): at ~826k context tokens the first token, and the next request
// after each tool result, took longer than the fixed 120 s, so the turn failed with TIMEOUT.
async function timeoutsFor(contextTokens: number | undefined, resume = true) {
  const root = mkdtempSync(join(tmpdir(), 'context-timeout-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Fixture identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const spy = jest.spyOn(processTurn, 'startProcessTurn');
  // The measured context belongs to the CLI context this turn resumes, or to none at all.
  const resolve = AgentCliSessions.prototype.resolve;
  const cli = jest.spyOn(AgentCliSessions.prototype, 'resolve').mockImplementation(function (this: AgentCliSessions, ...args) {
    const decision = resolve.apply(this, args);
    return contextTokens !== undefined && resume ? { id: decision.id, resume: true } : decision;
  });
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    releaseAgentSession: async () => {},
    createAgentSession: async (_session, profile) => Object.assign(new EventEmitter(), { runtimeProfile: profile,
      start: async () => {}, stop: async () => {}, interrupt: () => {},
      sendMessage: function (this: EventEmitter) { this.emit('output', JSON.stringify({ type: 'result', result: 'Done' })); } }) as unknown as SessionProcess,
  });
  try {
    if (contextTokens !== undefined) {
      const usage = { inputTokens: 10, cacheCreationTokens: 2000, cacheReadTokens: contextTokens - 2010, outputTokens: 500, totalTokens: contextTokens + 500 };
      recordTokenTurn(runtime.store, { id: 'previous-turn', sessionId: sid, role: 'agent', category: 'input', toolIds: [], inputTokens: contextTokens, totalTokens: contextTokens + 500,
        startedAt: Date.now() - 60000, model: 'fixture', requests: [{ id: 'r1', usage }] } as any);
    }
    const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    await expect(runtime.send({ scope, text: 'Hello' }, { execute: false, writeMemory: false }, { timeoutMs: 1000 })).resolves.toBe('Done');
    const policy = spy.mock.calls.at(-1)![6]!;
    return { firstResponse: policy.firstResponseTimeoutMs, idle: policy.idleTimeoutMs };
  } finally {
    spy.mockRestore(); cli.mockRestore();
    await runtime.close().catch(() => {}); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
}

test('a new or small session keeps the configured first-response and idle timeouts', async () => {
  expect(await timeoutsFor(undefined)).toEqual({ firstResponse: 120000, idle: 120000 });
  expect(await timeoutsFor(150000)).toEqual({ firstResponse: 120000, idle: 120000 });
});

test('a large context gets a proportionally longer budget, up to the cap', async () => {
  // 400k (plus this turn's prompt) is about twice the 200k scale point: about twice the 120 s base.
  const doubled = await timeoutsFor(400000);
  expect(doubled.firstResponse).toBe(doubled.idle);
  expect(doubled.firstResponse).toBeGreaterThanOrEqual(240000);
  expect(doubled.firstResponse).toBeLessThan(245000);
  // 826k would be ~496 s; the default cap is 300 s.
  expect(await timeoutsFor(826000)).toEqual({ firstResponse: 300000, idle: 300000 });
});

test('scale point and cap are configurable; the cap never shortens a configured base', () => {
  const config = resolveOrchestrationConfig({ conversation: { contextTimeoutScaleTokens: 100000, maxContextTimeoutMs: 400000 } });
  expect(config.conversation).toMatchObject({ contextTimeoutScaleTokens: 100000, maxContextTimeoutMs: 400000 });
  expect(resolveOrchestrationConfig().conversation).toMatchObject({ contextTimeoutScaleTokens: 200000, maxContextTimeoutMs: 300000 });
  const scaled = (tokens: number) => contextScaledTimeouts({ firstResponseTimeoutMs: 120000, idleTimeoutMs: 300000, contextTimeoutScaleTokens: 200000, maxContextTimeoutMs: 300000 }, tokens);
  expect(scaled(0)).toEqual({ firstResponseTimeoutMs: 120000, idleTimeoutMs: 300000 });
  expect(scaled(2_000_000)).toEqual({ firstResponseTimeoutMs: 300000, idleTimeoutMs: 300000 });
  expect(scaled(Number.NaN)).toEqual({ firstResponseTimeoutMs: 120000, idleTimeoutMs: 300000 });
});

test('invalid scaling config is rejected', () => {
  for (const conversation of [
    { contextTimeoutScaleTokens: 0 }, { contextTimeoutScaleTokens: -1 }, { contextTimeoutScaleTokens: 1.5 }, { contextTimeoutScaleTokens: '200000' },
    { contextTimeoutScaleTokens: 999 }, { contextTimeoutScaleTokens: 10_000_001 },
    { maxContextTimeoutMs: 0 }, { maxContextTimeoutMs: 60000 }, { maxContextTimeoutMs: 600001 },
    { firstResponseTimeoutMs: 200000, maxContextTimeoutMs: 150000 },
  ]) expect(() => resolveOrchestrationConfig({ conversation } as any)).toThrow(/contextTimeout|maxContextTimeoutMs|Invalid|must/);
});

test('a config that was valid before scaling existed still loads, with the cap raised to its own budgets', () => {
  // Long budgets, including the legacy decisionTimeoutMs alias for idleTimeoutMs.
  expect(resolveOrchestrationConfig({ conversation: { idleTimeoutMs: 450000 } }).conversation.maxContextTimeoutMs).toBe(450000);
  expect(resolveOrchestrationConfig({ conversation: { decisionTimeoutMs: 400000 } }).conversation.maxContextTimeoutMs).toBe(400000);
  expect(resolveOrchestrationConfig({ conversation: { firstResponseTimeoutMs: 350000 } }).conversation.maxContextTimeoutMs).toBe(350000);
  // A short whole-turn limit lowers the default cap instead of rejecting the config.
  expect(resolveOrchestrationConfig({ conversation: { maxDecisionDurationMs: 200000 } }).conversation.maxContextTimeoutMs).toBe(200000);
  // An explicit cap is still checked.
  expect(() => resolveOrchestrationConfig({ conversation: { idleTimeoutMs: 450000, maxContextTimeoutMs: 300000 } })).toThrow(/maxContextTimeoutMs/);
});

test('a fresh CLI context does not inherit the size measured in the one it replaced', async () => {
  // After /new, a model switch or an unreadable transcript, the previous 826k turn is not in this context.
  expect(await timeoutsFor(826000, false)).toEqual({ firstResponse: 120000, idle: 120000 });
});
