import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { promisesWork } from '../../../src/orchestration/report-promise';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Issue #605: a report turn (execute off) answered a GATEWAY_SHUTDOWN failure with "I will re-run
// the review right away next turn". It committed no task, nothing ran, and the conversation went
// silent. The "no promise without a committed task receipt" rule was prompt-only.
const THAI_PROMISE = 'โค้ดรีวิวรอบ 6 ถูกตัดกลางคันเพราะ gateway รีสตาร์ท ผมจะสั่งรันรีวิวรอบ 6 ใหม่ให้ทันทีในรอบถัดไปครับ';

async function withRuntime(reply: string, run: (runtime: AgentOrchestrationRuntime, report: (taskState?: 'failed' | 'queued') => Promise<string>) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), 'report-promise-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter) {
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: [] }));
        this.emit('output', JSON.stringify({ type: 'result', result: reply }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  let spawned = 0;
  const report = async (other?: 'failed' | 'queued') => {
    const input = runtime.store.acceptInput({ scope, text: 'Run code review round 6' });
    const decision = runtime.decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const context = { ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false };
    const task = runtime.tasks.spawn({ ...context, actionId: `spawn-${spawned++}` }, { title: 'Review', instructions: 'Review the PR', targetProfile: 'default-worker' });
    if (other === 'queued') runtime.tasks.spawn({ ...context, actionId: `spawn-${spawned++}` }, { title: 'Follow-up', instructions: 'Re-run the review', targetProfile: 'default-worker' });
    const attempt = runtime.tasks.claim(task.taskId)!;
    runtime.tasks.started(attempt.attemptId, attempt.generation);
    runtime.decisions.finish(decision, 'Working');
    runtime.tasks.finish(attempt.attemptId, attempt.generation,
      { type: 'failed', failure: { code: 'GATEWAY_SHUTDOWN_REPEATED', message: 'Gateway restarts interrupted this task 4 times.', observedAt: Date.now() } });
    const n = runtime.store.get("SELECT id FROM notifications WHERE task_id=? AND status='pending'", task.taskId)!;
    return runtime.send({ scope, text: 'Report the task status', storeUserMessage: false, ingressKey: 'notification:' + n.id },
      { execute: false, writeMemory: false }, { timeoutMs: 2000 });
  };
  try { await run(runtime, report); }
  finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
}

const stored = (runtime: AgentOrchestrationRuntime) => String(runtime.store.get('SELECT generated_text FROM assistant_responses ORDER BY created_at DESC, rowid DESC LIMIT 1')!.generated_text);

test('a report turn that promises to re-run work with nothing queued tells the user that nothing will run', async () => {
  await withRuntime(THAI_PROMISE, async (runtime, report) => {
    const text = await report();
    expect(text).toContain(THAI_PROMISE);
    expect(text).toContain('ยังไม่มีงานที่กำลังรันหรือรอรันอยู่');
    expect(stored(runtime)).toContain('ยังไม่มีงานที่กำลังรันหรือรอรันอยู่');
    expect(runtime.store.get("SELECT 1 FROM conversation_events WHERE type='response.unbacked_promise'")).toBeDefined();
  });
  await withRuntime("The review was interrupted. I'll re-run it right away.", async (_runtime, report) => {
    expect(await report()).toContain('no task is running or queued');
  });
});

test('a report turn whose promise is backed by queued work, or that promises nothing, is unchanged', async () => {
  const backed = "The review was interrupted. I'll continue once the queued follow-up starts.";
  await withRuntime(backed, async (_runtime, report) => {
    expect(await report('queued')).toBe(backed);
  });
  const blocker = 'The review stopped after repeated gateway restarts. The branch and pushed commits are intact.';
  await withRuntime(blocker, async (_runtime, report) => {
    expect(await report()).toBe(blocker);
  });
});

test('promisesWork recognizes commitments to (re)start work, not reports of what happened', () => {
  for (const text of [THAI_PROMISE, "I'll re-run the review next turn.", 'I will restart the deployment now.', 'Let me retry it.',
    'เดี๋ยวผมรันใหม่ให้ครับ', 'ผมจะดำเนินการต่อทันทีครับ'])
    expect(promisesWork(text)).toBe(true);
  for (const text of ['The review ran and found two issues.', 'Gateway restarts interrupted the task; the branch is intact.',
    'รีวิวเสร็จแล้ว พบปัญหา 2 ข้อครับ', 'งานหยุดเพราะ gateway รีสตาร์ทซ้ำหลายครั้ง',
    'I will not re-run it automatically.', "I'll never retry a failed publish.", 'ผมจะไม่รันซ้ำเองครับ', 'งานจะยังไม่เริ่มจนกว่าจะได้คำตอบ'])
    expect(promisesWork(text)).toBe(false);
});
