import { ORCHESTRATION_DEFAULTS } from '../../../src/orchestration/config';
import { EventEmitter } from 'events';
import { mkdtempSync, rmSync, readFileSync, mkdirSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import express from 'express';
import request from 'supertest';
import { AgentOrchestrationRuntime, AgentOrchestrationHost } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { AgentRunner } from '../../../src/agent/runner';
import { createApiRouter } from '../../../src/api/router';
import { SkillRegistry } from '../../../src/skills';
import { parseSkill } from '../../../src/skills/parser';
import { ConversationScope } from '../../../src/orchestration/types';

const registry: SkillRegistry = { skills: new Map([['review', parseSkill('---\nname: review\ndescription: Review code\n---\nReview $ARGUMENTS', { filePath: '/fixture/skills/review/SKILL.md', source: 'workspace' })!]]) };
async function fixture(source: ConversationScope['source'] = 'api', answer = 'Still available.') {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-review-')), agentDir = join(root, 'agents', 'a');
  const sessions = new SessionStore(join(root, 'agents')), history = HistoryDB.forDir(agentDir, 'a');
  const agent: AgentConfig = { id: 'a', description: '', workspace: join(agentDir, 'workspace'), env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, conversation: { notificationPolicy: 'next_user_turn' } }, voice: { ...ORCHESTRATION_DEFAULTS.voice, enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const prompts: string[] = [], profiles: string[] = [], workers: Array<() => void> = [];
  const host: AgentOrchestrationHost = { skills: () => registry,
    transcribeNote: jest.fn(async () => '/review 465'),
    createAgentSession: jest.fn(async (_, profile) => {
      profiles.push(profile.overlay);
      const agentSession = new EventEmitter() as SessionProcess;
      agentSession.start = async () => {}; agentSession.stop = async () => {};
      agentSession.sendMessage = prompt => { prompts.push(prompt); agentSession.emit('output', JSON.stringify({ type: 'result', result: answer })); };
      return agentSession;
    }), releaseAgentSession: async () => {},
  };
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, agentDir, sessions, history, host, {
    start: async () => { let complete!: () => void; const result = new Promise<any>(resolve => { complete = () => resolve({ type: 'completed', result: { summary: 'Review found an access control bug.', artifactIds: [] } }); }); workers.push(complete); return { accepted: Promise.resolve(), result, stop: async () => complete() }; },
  });
  const scope: ConversationScope = { agentId: 'a', agentSessionId: 's', source, accountId: 'a', chatId: 'c', threadKey: 'topic', principalId: 'p' };
  return { root, sessions, runtime, scope, host, prompts, profiles, agent, gateway, workers,
    close: async () => { workers.forEach(f => f()); await runtime.close(); (history as any).db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test.each(['api', 'telegram', 'discord', 'line'] as const)('explicit %s skills queue without agent inference; follow-up stays responsive and retries do not duplicate', async source => {
  const f = await fixture(source);
  try {
    const input = { scope: f.scope, text: '/review\n465', ingressKey: 'event1' };
    const first = f.runtime.submitInput(input, { execute: true, writeMemory: false });
    expect(await first.response).toContain("I've queued /review");
    expect(f.host.createAgentSession).not.toHaveBeenCalled();
    expect(await f.runtime.submitInput(input, { execute: true, writeMemory: false }).response).toContain("I've queued /review");
    expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
    const task = f.runtime.store.task(String(f.runtime.store.get('SELECT id FROM tasks')!.id))!;
    expect(task).toMatchObject({ targetProfile: 'skill-worker', skill: { name: 'review', args: '465' } });
    const deadline = Date.now() + 2000;
    while (!f.workers.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 10));
    expect(f.runtime.store.task(task.taskId)!.state).toBe('running');
    expect(await f.runtime.send({ scope: f.scope, text: 'Are you available?' }, { execute: true, writeMemory: false }, { timeoutMs: 1000 })).toBe('Still available.');
    expect(f.host.createAgentSession).toHaveBeenCalledTimes(1);
    expect(f.prompts[0]).not.toContain('Review $ARGUMENTS');
    expect(f.prompts[0]).not.toContain('/fixture/skills');
    if (source !== 'api') expect(f.runtime.store.get("SELECT COUNT(*) n FROM outbox WHERE kind='delivery'")!.n).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test('execution-disabled explicit skills create no tasks', async () => {
  const f = await fixture();
  try {
    await expect(f.runtime.send({ scope: f.scope, text: '/review 466' }, { execute: false, writeMemory: false }, { timeoutMs: 1000 })).rejects.toThrow('EXECUTION_DENIED');
    expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(0);
    expect(f.host.createAgentSession).not.toHaveBeenCalled();
  } finally { await f.close(); }
});

test('live review retains complete canonical text but exposes only the separate summary to speech', async () => {
  const display = 'Review details\n```ts\nsecretExample();\n```\n' + 'Detailed evidence. '.repeat(300), spoken = 'พบปัญหาการตรวจสิทธิ์หนึ่งจุด รายละเอียดอยู่ในแชตครับ';
  const f = await fixture('api', JSON.stringify({ display_text: display, spoken_text: spoken }));
  try {
    const accepted = f.runtime.submitInput({ scope: f.scope, text: 'Review result?', modality: 'live_voice' }, { execute: true, writeMemory: false });
    const chunks: string[] = []; const consume = (async () => { for await (const c of accepted.stream!) chunks.push(c.text); })();
    expect(await accepted.response).toBe(display); await consume;
    expect(chunks).toEqual([spoken]);
    expect(f.runtime.store.get('SELECT generated_text FROM assistant_responses')!.generated_text).toBe(display);
    expect(f.runtime.store.get('SELECT text FROM response_speech')!.text).toBe(spoken);
    expect((await f.sessions.loadSession('a', 's')).at(-1)!.content).toBe(display);
    expect(f.host.createAgentSession).toHaveBeenCalledTimes(1);
    expect(f.profiles[0]).toContain('spoken_text');
  } finally { await f.close(); }
});

test('voice notes are durably accepted before STT, transcribed once, and can dispatch skills', async () => {
  const f = await fixture('telegram');
  try {
    const media = join(f.root, 'agents', 'a', 'media');
    mkdirSync(media, { recursive: true });
    writeFileSync(join(media, 'test.ogg'), 'OggS fixture audio');
    (f.host.transcribeNote as jest.Mock).mockImplementation(async () => {
      expect(f.runtime.store.get("SELECT COUNT(*) n FROM conversation_inputs WHERE modality='voice_note'")!.n).toBe(1);
      return '/review 465';
    });
    const input = { scope: f.scope, text: '(voice message)', modality: 'voice_note' as const, attachmentIds: ['media/test.ogg'], ingressKey: 'note1' };
    expect(await f.runtime.submitInput(input, { execute: true, writeMemory: false }).response).toContain("I've queued /review");
    expect(await f.runtime.submitInput(input, { execute: true, writeMemory: false }).response).toContain("I've queued /review");
    expect(f.host.transcribeNote).toHaveBeenCalledTimes(1);
    expect(f.host.createAgentSession).not.toHaveBeenCalled();
    expect(f.runtime.store.get('SELECT text FROM conversation_inputs')!.text).toBe('/review 465');
  } finally { await f.close(); }
});

test('STT failures return an explicit text error without invoking agent session or dispatching work', async () => {
  const f = await fixture('line');
  try {
    (f.host.transcribeNote as jest.Mock).mockRejectedValue(new Error('provider down'));
    const response = await f.runtime.submitInput({ scope: f.scope, text: '(voice)', modality: 'voice_note', attachmentIds: ['media/test.m4a'] }, { execute: true, writeMemory: false }).response;
    expect(response).toContain('could not be transcribed'); expect(response).not.toContain('provider down');
    expect(f.host.createAgentSession).not.toHaveBeenCalled();
    expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(0);
  } finally { await f.close(); }
});

test.each([false, true])('existing messages API dispatches installed skills (SSE=%s)', async stream => {
  const f = await fixture();
  const runner = new AgentRunner(f.agent, f.gateway); (runner as any).orchestration = f.runtime;
  const app = express(); app.use(express.json());
  app.use('/api', createApiRouter(new Map([['a', runner]]), new Map([['a', f.agent]]), [{ id: 'owner', key: 'fixture', agents: ['a'], allow_tools: true }]));
  try {
    const result = await request(app).post('/api/v1/agents/a/messages').set('Authorization', 'Bearer fixture').send({ chat_id: 'chat', message: '/review 465', stream });
    expect(result.status).toBe(200);
    expect(stream ? result.text : result.body.response).toContain("I've queued /review");
    if (stream) expect(result.text).toContain('data: [DONE]');
    expect(f.host.createAgentSession).not.toHaveBeenCalled();
    expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
  } finally { await f.close(); }
});


test.each([
  { source: 'api', modality: 'text' }, { source: 'telegram', modality: 'text' }, { source: 'line', modality: 'text' },
  { source: 'api', modality: 'live_voice' }, { source: 'api', modality: 'live_voice', slash: true }, { source: 'telegram', modality: 'voice_note' }, { source: 'line', modality: 'voice_note' },
] as const)('natural-language $source/$modality dispatches through the real task bridge and delivers its worker result', async scenario => {
  const { source, modality } = scenario;
  const text = 'slash' in scenario ? '/review 465' : 'ช่วยตรวจโค้ด PR 465';
  const f = await fixture(source); let calls = 0;
  (f.host.transcribeNote as jest.Mock).mockResolvedValue('ช่วยตรวจโค้ด PR 465');
  (f.host.createAgentSession as jest.Mock).mockImplementation(async (_, profile) => {
    expect(profile.overlay).toContain('"name":"review"');
    expect(profile.overlay).not.toContain('Review $ARGUMENTS');
    const config = JSON.parse(readFileSync(profile.mcpConfigPath, 'utf8'));
    const ticket = JSON.parse(readFileSync(config.mcpServers.gateway.env.GATEWAY_ORCHESTRATION_TICKET_FILE, 'utf8'));
    const session = new EventEmitter() as SessionProcess;
    session.start = async () => {}; session.stop = async () => {};
    session.sendMessage = prompt => { void (async () => {
      if (calls++ === 0) {
        expect(prompt).toContain(text);
        const command = { tool: 'task_spawn', action_id: 'implicit-review', args: { title: 'Review PR 465', instructions: 'Review PR 465 and report findings.', target_profile: 'skill-worker', skill_name: 'review', skill_args: '465', spoken_acknowledgement: 'ผมจะตรวจโค้ด PR 465 และสรุปจุดที่ควรแก้ให้ครับ' } };
        for (const args of [ { ...command.args, skill_name: 'unknown' }, { ...command.args, skill_name: '../review' }, { ...command.args, target_profile: 'default-worker' } ]) {
          const denied = await fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ ...command, args }) });
          expect(denied.status).toBe(400);
        }
        const call = () => fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(command) });
        const response = await call(); expect(response.status).toBe(200);
        const receipt = await response.json() as any; expect(receipt.skill).toBeUndefined();
        expect((await (await call()).json() as any).taskId).toBe(receipt.taskId);
      } else expect(prompt).toContain('Review found an access control bug.');
      session.emit('output', JSON.stringify({ type: 'result', result: calls === 1 ? 'Queued review. You can keep chatting.' : 'Review found an access control bug.' }));
    })().catch(error => session.emit('error', error)); };
    return session;
  });
  try {
    const response = await f.runtime.send({ scope: f.scope, text: modality === 'voice_note' ? '(voice message)' : text, modality, ...(modality === 'voice_note' ? { attachmentIds: ['media/note.ogg'] } : {}) }, { execute: true, writeMemory: false }, { timeoutMs: 3000 });
    expect(response).toContain('Queued review');
    expect(f.runtime.store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
    expect(f.runtime.store.task(String(f.runtime.store.get('SELECT id FROM tasks')!.id))).toMatchObject({ targetProfile: 'skill-worker', skill: { name: 'review', args: '465' } });
    const deadline = Date.now() + 2000;
    while (!f.workers.length && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(f.workers).toHaveLength(1); f.workers[0]();
    while (f.runtime.store.get('SELECT state FROM tasks')!.state !== 'completed' && Date.now() < deadline) await new Promise(resolve => setTimeout(resolve, 5));
    expect(await f.runtime.send({ scope: f.scope, text: 'What did you find?' }, { execute: true, writeMemory: false }, { timeoutMs: 3000 })).toContain('access control bug');
  } finally { await f.close(); }
});

test('refreshing CLI catalog before routing recognizes native slash skills on the first input',async()=>{
 const f=await fixture('api');
 f.host.refreshSkills=async()=>{registry.cliSkills=[{name:'code-review',description:'Bundled native review'}];};
 try{
  const text=await f.runtime.send({scope:f.scope,text:'/code-review low'}, {execute:true,writeMemory:false},{timeoutMs:1000});
  expect(text).toContain("I've queued /code-review");expect(f.host.createAgentSession).not.toHaveBeenCalled();
  const task=f.runtime.store.task(String(f.runtime.store.get('SELECT id FROM tasks')!.id))!;
  expect(task.skill).toMatchObject({name:'code-review',args:'low',invocation:'cli',content:'',filePath:''});
 }finally{delete registry.cliSkills;await f.close();}
});
