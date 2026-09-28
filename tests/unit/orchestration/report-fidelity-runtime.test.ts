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

// The reporting boundary must instruct the agent to preserve a worker result's severity
// markers, counts and verdict. This drives the real runtime: a completed task whose result
// carries `🔴 Critical (1)` and a not-ready verdict raises a completion notification, and the
// report turn's prompt is captured. Before the fidelity overlay was wired in, that prompt
// pushed only "concise... rewrite worker reports" with no preservation rule — so this test
// fails on the pre-fix code and passes once the boundary carries the contract. It also proves
// the overlay is scoped: an ordinary user turn and a question-review turn must not receive it.
test('a worker-result report turn carries the fidelity contract; ordinary and question turns do not', async () => {
  const root = mkdtempSync(join(tmpdir(), 'report-fidelity-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const prompts: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter, prompt: string) {
        prompts.push(prompt);
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: [] }));
        this.emit('output', JSON.stringify({ type: 'result', result: 'Reported.' }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  try {
    // An ordinary user turn: no worker result to preserve, so no fidelity overlay.
    await runtime.send({ scope, text: 'Hello' }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
    expect(prompts.at(-1)).not.toContain(WORKER_RESULT_FIDELITY);

    // Complete a task whose result carries a severity heading, marker and blocking verdict.
    const input = runtime.store.acceptInput({ scope, text: 'Review the diff' });
    const decision = runtime.decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const task = runtime.tasks.spawn({ ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false, actionId: 'spawn' },
      { title: 'Review', instructions: 'Review the diff', targetProfile: 'default-worker' });
    const attempt = runtime.tasks.claim(task.taskId)!;
    runtime.tasks.started(attempt.attemptId, attempt.generation);
    runtime.decisions.finish(decision, 'Working');
    runtime.tasks.finish(attempt.attemptId, attempt.generation,
      { type: 'completed', result: { summary: '### 🔴 Critical (1)\n1. A blocking finding.\n\nVerdict: Not ready', artifactIds: [] } });

    // The completion notification report turn must carry the fidelity contract.
    const n = runtime.store.get("SELECT id FROM notifications WHERE status='pending' ORDER BY rowid DESC LIMIT 1")!;
    await runtime.send({ scope, text: 'Report the result', storeUserMessage: false, ingressKey: 'notification:' + n.id },
      { execute: false, writeMemory: false }, { timeoutMs: 2000 });
    expect(prompts.at(-1)).toContain(WORKER_RESULT_FIDELITY);

    // A question-review turn is a notification-flagged turn that reports no worker result;
    // the overlay must not leak into it.
    await runtime.send({ scope, text: 'Review pending questions', storeUserMessage: false, ingressKey: 'question-review:' + input.conversationId + ':1' },
      { execute: false, writeMemory: false }, { timeoutMs: 2000 });
    expect(prompts.at(-1)).not.toContain(WORKER_RESULT_FIDELITY);
  } finally {
    await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true });
  }
});
