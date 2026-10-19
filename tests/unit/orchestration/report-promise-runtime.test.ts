import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { isEmptyReply, SPEECH_OVERLAY, SPEECH_REMINDER, splitSpeechResponse } from '../../../src/orchestration/speech';
import { displayPrefix } from '../../../src/orchestration/display-stream';
import { progressReviewResult } from '../../../src/orchestration/progress-review';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Issue #605: a report turn (execute off) answered a GATEWAY_SHUTDOWN failure with "I will re-run
// the review right away next turn". It committed no task, nothing ran, and the conversation went
// silent. Issue #629: guessing such a promise from the reply's words appended a system note to
// questions and descriptions. The reply now declares follow_up itself, and a mismatch with the
// real task state is recorded for operators, never shown or spoken.
const THAI_PROMISE = 'โค้ดรีวิวรอบ 6 ถูกตัดกลางคันเพราะ gateway รีสตาร์ท ผมจะสั่งรันรีวิวรอบ 6 ใหม่ให้ทันทีในรอบถัดไปครับ';
const NOTE = /หมายเหตุจากระบบ|Note from the gateway/;
const payload = (display_text: string, follow_up?: string) => JSON.stringify({ display_text, ...(follow_up ? { follow_up } : {}) });

async function withRuntime(reply: string, run: (runtime: AgentOrchestrationRuntime, report: (taskState?: 'failed' | 'queued' | 'auto') => Promise<string>) => Promise<void>) {
  const prompts: string[] = [];
  const root = mkdtempSync(join(tmpdir(), 'report-promise-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter, prompt: string) {
        prompts.push(prompt);
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: [] }));
        this.emit('output', JSON.stringify({ type: 'result', result: reply }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  let spawned = 0;
  const report = async (other?: 'failed' | 'queued' | 'auto') => {
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
    if (other === 'auto') {
      // The scheduled report path: the runtime builds the report-turn instructions itself.
      (runtime as any).pumpMailbox();
      for (let i = 0; i < 200 && !prompts.some(p => p.includes('Report the persisted task status update')); i++) await new Promise(r => setTimeout(r, 10));
      return prompts.find(p => p.includes('Report the persisted task status update')) ?? '';
    }
    const n = runtime.store.get("SELECT id FROM notifications WHERE task_id=? AND status='pending'", task.taskId)!;
    return runtime.send({ scope, text: 'Report the task status', storeUserMessage: false, ingressKey: 'notification:' + n.id },
      { execute: false, writeMemory: false }, { timeoutMs: 2000 });
  };
  try { await run(runtime, report); }
  finally { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
}

const stored = (runtime: AgentOrchestrationRuntime) => String(runtime.store.get('SELECT generated_text FROM assistant_responses ORDER BY created_at DESC, rowid DESC LIMIT 1')!.generated_text);
const unbacked = (runtime: AgentOrchestrationRuntime) => runtime.store.all("SELECT 1 FROM conversation_events WHERE type='response.unbacked_promise'").length;

test('a report reply is published exactly as written, whatever words it uses', async () => {
  // Verbatim report replies that drew the note (17–19 Oct): questions and descriptions, not promises.
  for (const reply of ['จะให้ผมเริ่มแก้เลยไหมครับ', 'รอคำสั่งคุณก่อนว่าจะให้ดำเนินการต่อไหม', 'workflow จะไปรันผิด repo',
    'ก่อนที่ agent จะเริ่มทำงาน', 'ทุก turn จะเริ่มตอบช้าลง 0.8 วินาที', THAI_PROMISE, "The review was interrupted. I'll re-run it right away."]) {
    await withRuntime(reply, async (runtime, report) => {
      expect(await report()).toBe(reply);
      expect(stored(runtime)).not.toMatch(NOTE);
      expect(unbacked(runtime)).toBe(0);
    });
  }
  await withRuntime(payload('จะให้ผมเริ่มแก้เลยไหมครับ', 'asks_user'), async (runtime, report) => {
    expect(await report()).toBe('จะให้ผมเริ่มแก้เลยไหมครับ');
    expect(unbacked(runtime)).toBe(0);
  });
});

test('a report reply that declares work continues with nothing committed or queued is recorded, not changed', async () => {
  const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
  try {
    await withRuntime(payload(THAI_PROMISE, 'continues'), async (runtime, report) => {
      expect(await report()).toBe(THAI_PROMISE);
      expect(stored(runtime)).toBe(THAI_PROMISE);
      expect(unbacked(runtime)).toBe(1);
      expect(warn.mock.calls.some(([line]) => String(line).includes('Task report says work continues but no task is committed or pending'))).toBe(true);
    });
  } finally { warn.mockRestore(); }
});

test('a declared continuation backed by queued work, or a reply that declares none, records nothing', async () => {
  const backed = "The review was interrupted. I'll continue once the queued follow-up starts.";
  await withRuntime(payload(backed, 'continues'), async (runtime, report) => {
    expect(await report('queued')).toBe(backed);
    expect(unbacked(runtime)).toBe(0);
  });
  const blocker = 'The review stopped after repeated gateway restarts. The branch and pushed commits are intact.';
  await withRuntime(payload(blocker, 'none'), async (runtime, report) => {
    expect(await report()).toBe(blocker);
    expect(unbacked(runtime)).toBe(0);
  });
});

test('a payload that opens with follow_up is still our payload: only display_text is shown', () => {
  const raw = JSON.stringify({ follow_up: 'none', display_text: 'Review finished.', spoken_text: 'Done.' });
  expect(splitSpeechResponse(raw)).toEqual({ display: 'Review finished.', spoken: 'Done.', outcome: 'structured', followUp: 'none' });
  expect(displayPrefix(raw.slice(0, 30))).toBe('');
  expect(displayPrefix(`Checked.\n${raw.slice(0, 16)}`)).toBe('Checked.\n');
  expect(displayPrefix('{"follow')).toBe('');
  expect(progressReviewResult(JSON.stringify({ follow_up: 'none', notify_user: true, display_text: 'Tests pass.' }), []).display).toBe('Tests pass.');
  // An undeclared value is not a declaration.
  expect(splitSpeechResponse(JSON.stringify({ display_text: 'x', follow_up: 'maybe' })).followUp).toBeUndefined();
});

test('the scheduled report turn asks the reply to declare follow_up', async () => {
  await withRuntime(payload('Review finished.', 'none'), async (_runtime, report) => {
    expect(await report('auto')).toContain('set follow_up to "continues" only when your reply tells the user work will continue');
  });
  // A voice report turn may carry it too: the speech rules allow it when asked.
  for (const rules of [SPEECH_OVERLAY, SPEECH_REMINDER]) expect(rules).toContain("plus follow_up only when this turn's instructions ask for it");
});

test('parsing the same payload twice gives the same result: the shared regex keeps no position', () => {
  const raw = `Done.\n${JSON.stringify({ display_text: 'Review finished.', follow_up: 'none' })}`;
  expect(splitSpeechResponse(raw).display).toBe('Review finished.');
  expect(splitSpeechResponse(raw).display).toBe('Review finished.');
  expect(displayPrefix(raw)).toBe('Done.\n');
  expect(displayPrefix(raw)).toBe('Done.\n');
});

test('an empty reply that also declares follow_up is still empty, so a control step stays silent', () => {
  expect(isEmptyReply(JSON.stringify({ display_text: '', follow_up: 'none' }))).toBe(true);
  expect(isEmptyReply(JSON.stringify({ display_text: '', spoken_text: ' ' }))).toBe(true);
  expect(isEmptyReply('  ')).toBe(true);
  expect(isEmptyReply(JSON.stringify({ display_text: 'Done.', follow_up: 'none' }))).toBe(false);
  expect(isEmptyReply(JSON.stringify({ display_text: '', notify_user: false }))).toBe(false);
  expect(isEmptyReply('{"display_text":')).toBe(false);
});
