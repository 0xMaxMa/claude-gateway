import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { LIVE_VOICE_STT_NOTE, SPEECH_OVERLAY, SPEECH_REMINDER } from '../../../src/orchestration/speech';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Session a3a24184 (shadow): every resumed turn appended ~7 KB of unchanged text (empty data
// lines, the computer-table rules and the full voice rules) and resent running tasks whose only
// change was a 15-second process sample. The CLI history kept every copy.
const snapshots = (prompt: string): any[] => JSON.parse(prompt.split('Recent committed command receipts')[0].trim().split('\n').slice(-1)[0]);

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'turn-delta-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const prompts: string[] = [], overlays: string[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      start: async () => {}, stop: async () => {}, interrupt: () => true,
      sendMessage: function (this: EventEmitter, prompt: string) {
        overlays.push(profile.overlay); prompts.push(prompt);
        this.emit('output', JSON.stringify({ type: 'result', result: 'Done.' }));
      },
    }) as unknown as SessionProcess, releaseAgentSession: async () => {},
  });
  // One resumed CLI conversation, as in production after the first turn.
  jest.spyOn((runtime as any).cliSessions, 'resolve').mockImplementation(() => ({ id: 'cli-fixture', resume: true }));
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const send = (text: string, extra: Record<string, unknown> = {}) => runtime.send({ scope, text, ...extra }, { execute: true, writeMemory: false }, { timeoutMs: 2000 });
  return { runtime, prompts, overlays, scope, send, close: async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); } };
}

test('a turn leaves out data lines that are empty, and keeps the ones that carry something', async () => {
  const f = await fixture();
  try {
    await f.send('Hello');
    const prompt = f.prompts[0];
    for (const empty of ['Pending question attention', 'Reply-to question context', 'Attachment details', 'Attachment refs', 'Images attached to this turn',
      'End-of-session screenshots', 'Computer state tables', 'Fresh computer control evidence', 'Computer task snapshots', 'Reused images', 'Unavailable attachments'])
      expect(prompt).not.toContain(empty);
    // Always present: the task index, receipts, this turn's capabilities and the request itself.
    expect(prompt).toContain('[Orchestration context: persisted task snapshots');
    expect(prompt).toContain('Recent committed command receipts (do not repeat their originating work): []');
    expect(prompt).toContain('Execution eligible: true.');
    expect(prompt).toContain('Semantic intake is inactive for this turn');
    expect(prompt.endsWith('\nHello')).toBe(true);
    // A line with a value is still there.
    await f.send('Look at this', { attachmentIds: ['media/missing.png'] });
    expect(f.prompts[1]).toContain('Attachment refs (automatically inherited by workers; previously delivered images remain in resumed context): ["media/missing.png"]');
    expect(f.prompts[1]).toContain('Unavailable attachments: ');
  } finally { await f.close(); }
});

test('a running task is not resent when only its process sample changed', async () => {
  const f = await fixture();
  try {
    await f.send('Start');
    const input = f.runtime.store.acceptInput({ scope: f.scope, text: 'work' }), decision = f.runtime.decisions.begin(input.conversationId, 'owner', [input.inputId]);
    const task = f.runtime.tasks.spawn({ ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false, actionId: 'spawn' }, { title: 'Long job', instructions: 'Work', targetProfile: 'default-worker' });
    f.runtime.decisions.finish(decision, 'Queued');
    const attempt = f.runtime.tasks.claim(task.taskId)!;
    f.runtime.tasks.started(attempt.attemptId, attempt.generation);
    const sample = (at: number, cpu: number) => f.runtime.tasks.observeExecution(attempt.attemptId, attempt.generation, {
      observedAt: at, lastProgressAt: 1000, phase: 'tool', activeTools: ['Bash'], quiet: at % 2 === 0, lastTool: { name: 'Bash', status: 'returned', observedAt: at },
      attemptId: attempt.attemptId, lastActivityAt: at, status: cpu ? 'process_activity' : 'waiting_for_tool',
      process: { observedAt: at, available: true, processCount: 3, ioAvailable: true, cpuTicksDelta: cpu, childCpuTicksDelta: 0, readBytesDelta: cpu * 10, writeBytesDelta: 0, membershipChanged: false },
    } as any);
    sample(Date.now(), 5);
    await f.send('How is it going?');
    expect(snapshots(f.prompts[1]).map(t => t.taskId)).toEqual([task.taskId]);
    expect(snapshots(f.prompts[1])[0].execution).toEqual({ phase: 'tool', activeTools: ['Bash'], lastProgressAt: 1000, attemptId: attempt.attemptId, lastTool: { name: 'Bash', status: 'returned' } });
    sample(Date.now() + 15001, 9);
    await f.send('And now?');
    expect(snapshots(f.prompts[2])).toEqual([]);
    // A real change is sent.
    f.runtime.tasks.progress(attempt.attemptId, attempt.generation, 'Half done');
    await f.send('Any news?');
    expect(snapshots(f.prompts[3]).map(t => t.taskId)).toEqual([task.taskId]);
    // The full sample is still one task_status call away.
    expect(f.runtime.tasks.status(task.conversationId, 'owner', task.taskId)[0].execution).toMatchObject({ process: { cpuTicksDelta: 9 } });
  } finally { await f.close(); }
});

test('the voice rules are sent in full once per CLI context, then as a reminder, with a stable system prompt', async () => {
  const f = await fixture();
  try {
    await f.send('สวัสดี', { modality: 'live_voice' });
    await f.send('ทำอะไรอยู่', { modality: 'live_voice' });
    expect(f.prompts[0]).toContain(SPEECH_OVERLAY);
    expect(f.prompts[1]).not.toContain(SPEECH_OVERLAY);
    expect(f.prompts[1]).toContain(SPEECH_REMINDER);
    expect(Buffer.byteLength(f.prompts[1])).toBeLessThan(Buffer.byteLength(f.prompts[0]) - 2500);
    // The cached system prefix is byte-identical across the two turns.
    expect(f.overlays[1]).toBe(f.overlays[0]);
    // A compaction drops what the context held, so the full rules come back.
    f.runtime.contextDelivery.invalidateConversation(String(f.runtime.store.get('SELECT id FROM conversations')!.id));
    await f.send('ต่อเลย', { modality: 'live_voice' });
    expect(f.prompts[2]).toContain(SPEECH_OVERLAY);
    // A new CLI conversation also gets them in full.
    jest.spyOn((f.runtime as any).cliSessions, 'resolve').mockImplementation(() => ({ id: 'cli-other', resume: false }));
    await f.send('อีกรอบ', { modality: 'live_voice' });
    expect(f.prompts[3]).toContain(SPEECH_OVERLAY);
  } finally { await f.close(); }
});

test('live-voice turns carry the realtime STT caveat on both the full and reminder paths; typed speech does not', async () => {
  const f = await fixture();
  try {
    await f.send('สวัสดี', { modality: 'live_voice' });
    await f.send('ทำอะไรอยู่', { modality: 'live_voice' });
    expect(f.prompts[0]).toContain(SPEECH_OVERLAY);
    expect(f.prompts[1]).toContain(SPEECH_REMINDER);
    for (const prompt of f.prompts.slice(0, 2)) expect(prompt).toContain(LIVE_VOICE_STT_NOTE);
    // Typed chat spoken to a connected listener is speech, but not a realtime transcript.
    const unsubscribe = f.runtime.subscribeVoiceResults(f.scope.agentSessionId, 'owner', () => {});
    await f.send('Typed question');
    unsubscribe();
    expect(f.prompts[2]).toContain(SPEECH_REMINDER);
    expect(f.prompts[2]).not.toContain(LIVE_VOICE_STT_NOTE);
    await f.send('Plain text');
    expect(f.prompts[3]).not.toContain(LIVE_VOICE_STT_NOTE);
  } finally { await f.close(); }
});
