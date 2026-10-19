import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SPEECH_OVERLAY, SPEECH_REMINDER } from '../../../src/orchestration/speech';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

// Issue #624: in a live call the user asked about npm after a command; the chat reply answered
// both, the spoken reply only acknowledged the command, and nothing recorded the omission.

test('both speech rule texts make spoken_text answer the latest question and cover what display_text answers', () => {
  for (const rules of [SPEECH_OVERLAY, SPEECH_REMINDER]) {
    expect(rules).toMatch(/spoken_text answers the (user's )?latest question[^.]* first/);
    expect(rules).toMatch(/covers every (other )?question display_text answers/);
    expect(rules).toMatch(/never (speak )?only an acknowledgement/);
    // Within the same speech budget, and keeping the user's Latin-script terms (npm) as written.
    expect(rules).toContain('within the same budget');
    expect(rules).toMatch(/Latin[- ]script terms? spelled as written|Latin script spelled as written/);
  }
});

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'speech-latest-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const prompts: string[] = [];
  // `reply` undefined holds the turn open until it is stopped, like a reply still being generated.
  let reply: string | undefined = 'Done.';
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async () => {
      const process = Object.assign(new EventEmitter(), {
        start: async () => {}, interrupt: () => true,
        stop: async () => { process.emit('exit', 0); },
        sendMessage: (prompt: string) => {
          prompts.push(prompt);
          if (reply !== undefined) process.emit('output', JSON.stringify({ type: 'result', result: reply }));
        },
      });
      return process as unknown as SessionProcess;
    }, releaseAgentSession: async () => {},
  });
  jest.spyOn((runtime as any).cliSessions, 'resolve').mockImplementation(() => ({ id: 'cli-fixture', resume: true }));
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const send = (text: string, modality = 'live_voice') => runtime.send({ scope, text, modality: modality as any }, { execute: false, writeMemory: false }, { timeoutMs: 2000 });
  /** A live voice turn whose reply the next part of the utterance cuts off. */
  const cutOff = async (text: string, reason: 'barge-in' | 'user' = 'barge-in') => {
    reply = undefined;
    const seen = prompts.length, pending = send(text);
    while (prompts.length === seen) await new Promise(resolve => setTimeout(resolve, 5));
    expect(runtime.stopResponse(sid, reason)).toBe(true);
    await pending.catch(() => '');
    reply = 'Done.';
  };
  const events = (type: string) => runtime.store.all('SELECT payload_json FROM conversation_events WHERE type=? ORDER BY seq', type).map(row => JSON.parse(String(row.payload_json)).payload);
  return { runtime, prompts, send, cutOff, events, setReply: (text: string) => { reply = text; },
    close: async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); } };
}

const fragmentsLine = (prompt: string) => prompt.split('\n').find(line => line.startsWith('Earlier fragments of this same spoken utterance'));

test('a live voice turn after barged-in fragments lists them as context and marks itself as the latest question', async () => {
  const f = await fixture();
  try {
    await f.cutOff('แก้ทั้งหมดเลย');
    await f.cutOff('แล้วผมอยากรู้ว่า');
    await f.send('ส่วนของ npm จะขึ้นยังไง');
    const prompt = f.prompts.at(-1)!;
    expect(fragmentsLine(prompt)).toContain(JSON.stringify(['แก้ทั้งหมดเลย', 'แล้วผมอยากรู้ว่า']));
    expect(prompt).toContain('The current user message below is the latest part and the question to answer first');
    // Per-turn content goes last, next to the message it labels, so the reusable prefix stays intact.
    expect(prompt.indexOf('Earlier fragments')).toBeGreaterThan(prompt.indexOf('Recent committed command receipts'));
    expect(prompt.indexOf('Earlier fragments')).toBeGreaterThan(prompt.indexOf(SPEECH_REMINDER));
    expect(prompt.endsWith(`${fragmentsLine(prompt)}\nThe current user message below is the latest part and the question to answer first, in spoken_text too; read it together with these fragments as one request.\n\n[Current user message — the request to answer now]\nส่วนของ npm จะขึ้นยังไง`)).toBe(true);
    expect(f.events('response.barge_in')).toHaveLength(2);
    // Once that turn is answered, its fragments are not carried into the next one.
    await f.send('ขอบคุณ');
    expect(fragmentsLine(f.prompts.at(-1)!)).toBeUndefined();
  } finally { await f.close(); }
});

test('a reply stopped by a stop control is not an utterance fragment, and a typed turn gets no fragments', async () => {
  const f = await fixture();
  try {
    await f.cutOff('หยุดก่อน', 'user');
    await f.send('npm ล่ะ');
    expect(fragmentsLine(f.prompts.at(-1)!)).toBeUndefined();
    expect(f.events('response.barge_in')).toEqual([]);
    await f.cutOff('แก้ทั้งหมดเลย');
    await f.send('npm ล่ะ', 'text');
    expect(fragmentsLine(f.prompts.at(-1)!)).toBeUndefined();
  } finally { await f.close(); }
});

// Coverage is the model's job under the rules above. The gateway does not guess it from the
// words of the input and the two surfaces (issue #629): no token heuristic, no event.
test('the words of a reply are not scanned for coverage of the latest question', async () => {
  const f = await fixture();
  try {
    const spoken = 'ได้ค่ะ จะแก้ทั้ง 4 ข้อแล้ว push ขึ้น branch เดิม ยังไม่ merge นะคะ';
    f.setReply(JSON.stringify({ display_text: 'จะแก้ทั้ง 4 ข้อแล้ว push ขึ้น branch เดิมค่ะ\n- npm: แสดงเป็น package ใหม่ใน registry', spoken_text: spoken }));
    await f.send('แล้วส่วนของ npm จะขึ้นยังไง');
    expect(f.events('response.speech_coverage_gap')).toEqual([]);
    expect(f.runtime.store.all('SELECT text FROM response_speech').map(row => String(row.text))).toEqual([spoken]);
  } finally { await f.close(); }
});
