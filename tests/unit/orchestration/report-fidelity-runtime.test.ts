import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { WORKER_RESULT_FIDELITY } from '../../../src/orchestration/report-fidelity';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// A worker result is reported on more than the auto-notification turn: a user can ask about a
// finished task's findings on any channel ("what did the review flag?"), which is an ordinary
// turn, not a notification. The fidelity contract must therefore reach the user-facing agent's
// system overlay on every reporting turn, not only notification turns. This drives the real
// runtime and captures the profile overlay built for each turn. Before the fix the contract was
// attached to the per-turn prompt gated on active.notification, so an ordinary user turn's
// overlay never carried it — the ordinary-turn assertion below fails on that pre-fix wiring and
// passes once the contract lives in the always-on overlay. Capturing overlays.length before each
// send also proves a fresh turn/profile was actually built, so a short-circuited send cannot make
// a stale prior overlay satisfy the assertion.
test('the worker-result fidelity contract is in the user-facing overlay on every reporting turn, channel-agnostic', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-fidelity-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const overlays: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => { overlays.push(profile.overlay ?? ''); return Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter, _prompt: string) {
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: [] }));
        this.emit('output', JSON.stringify({ type: 'result', result: 'Reported.' }));
      },
    }) as unknown as SessionProcess; }, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  try {
    // An ordinary user turn (not a notification) on a non-Telegram channel: a plain follow-up
    // that reports a worker result. Its overlay must carry the contract — the case the pre-fix
    // notification-only gate missed.
    const beforeOrdinary = overlays.length;
    await runtime.send({ scope, text: 'What did the review flag?' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    expect(overlays.length).toBeGreaterThan(beforeOrdinary); // a fresh turn/profile was built
    expect(overlays.at(-1)).toContain(WORKER_RESULT_FIDELITY);

    // Complete a task whose result carries a severity heading, marker and blocking verdict, then
    // run its completion-notification report turn: that turn's overlay must carry it too.
    const input = runtime.store.acceptInput({ scope, text: 'Review the diff' });
    const decision = runtime.decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const task = runtime.tasks.spawn({ ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false, actionId: 'spawn' },
      { title: 'Review', instructions: 'Review the diff', targetProfile: 'default-worker' });
    const attempt = runtime.tasks.claim(task.taskId)!;
    runtime.tasks.started(attempt.attemptId, attempt.generation);
    runtime.decisions.finish(decision, 'Working');
    runtime.tasks.finish(attempt.attemptId, attempt.generation,
      { type: 'completed', result: { summary: '### 🔴 Critical (1)\n1. A blocking finding.\n\nVerdict: Not ready', artifactIds: [] } });
    const n = runtime.store.get("SELECT id FROM notifications WHERE status='pending' ORDER BY rowid DESC LIMIT 1")!;
    const beforeReport = overlays.length;
    await runtime.send({ scope, text: 'Report the result', storeUserMessage: false, ingressKey: 'notification:' + n.id },
      { execute: false, writeMemory: false }, { timeoutMs: 2000 });
    expect(overlays.length).toBeGreaterThan(beforeReport);
    expect(overlays.at(-1)).toContain(WORKER_RESULT_FIDELITY);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
