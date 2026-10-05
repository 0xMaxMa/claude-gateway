import { EventEmitter } from 'events';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrationRuntime, AgentOrchestrationHost } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { WorkerDriver } from '../../../src/orchestration/tasks/scheduler';

type Call = (tool: string, args: Record<string, unknown>) => Promise<any>;
type Script = (call: Call, process: SessionProcess, turn: number) => Promise<void>;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6L9sAAAAASUVORK5CYII=', 'base64');
const finish = (process: SessionProcess, result = '') => process.emit('output', JSON.stringify({ type: 'result', result }));
const snapshots = (prompt: string): any[] => JSON.parse(prompt.split('Recent committed command receipts')[0].trim().split('\n').slice(-1)[0]);
const receipts = (prompt: string): any[] => JSON.parse(prompt.split('Recent committed command receipts (do not repeat their originating work): ')[1].split('\n')[0]);

async function fixture(script: Script = async (_call, process) => { finish(process); }) {
  const root = mkdtempSync(join(tmpdir(), 'context-delivery-flow-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a/workspace'), description: 'fixture', env: '', claude: { model: 'fixture', extraFlags: [] },
    orchestration: { conversation: { semanticIntake: true, inputDebounceMs: 100, inputMaxWaitMs: 500, intakeWaitMs: 60000, notificationPolicy: 'next_user_turn' } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  mkdirSync(join(root, 'a/media/c'), { recursive: true });
  writeFileSync(join(root, 'a/media/c/image.png'), png);
  writeFileSync(join(root, 'a/media/c/image-alias.png'), png);
  const prompts: string[] = [], images: unknown[][] = [], failures: unknown[] = [];
  let turn = 0, action = 0, cliId = 'fixture-cli';
  const host: AgentOrchestrationHost = { createAgentSession: async (_id, profile) => {
    const config = JSON.parse(readFileSync(profile.mcpConfigPath, 'utf8'));
    const ticket = JSON.parse(readFileSync(config.mcpServers.gateway.env.GATEWAY_ORCHESTRATION_TICKET_FILE, 'utf8'));
    const call: Call = async (tool, args) => {
      const response = await fetch(ticket.url, { method: 'POST', headers: { Authorization: `Bearer ${ticket.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ tool, args, action_id: `action-${++action}` }) });
      return response.json();
    };
    const process = new EventEmitter() as SessionProcess;
    process.start = async () => {};
    process.interrupt = () => true;
    process.stop = async () => { process.emit('exit', 0); };
    process.sendMessage = (text, inputImages) => {
      prompts.push(text); images.push([...(inputImages ?? [])]);
      void script(call, process, ++turn).catch(error => { failures.push(error); finish(process, 'fixture failed'); });
    };
    return process;
  }, releaseAgentSession: async () => {} };
  const worker: WorkerDriver = { start: async () => {
    let complete!: (value: { type: 'stopped' }) => void;
    return { accepted: Promise.resolve(), result: new Promise(resolve => { complete = resolve; }), stop: async () => { complete({ type: 'stopped' }); } };
  } };
  let runtime: AgentOrchestrationRuntime;
  const open = async () => {
    runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, host, worker);
    (runtime as any).delivery.send = async () => ({state:'delivered',providerId:'fixture'});
    jest.spyOn((runtime as any).cliSessions, 'resolve').mockImplementation(() => ({ id: cliId, resume: true }));
  };
  await open();
  const scope = { agentId: 'a', agentSessionId: 's', source: 'telegram' as const, accountId: 'key', chatId: 'c', threadKey: '', principalId: 'p' };
  return { get runtime() { return runtime; }, scope, prompts, images, failures, sessions,
    send: (text: string, attachmentIds?: string[]) => runtime.send({ scope, text, attachmentIds }, { execute: true, writeMemory: false }, { timeoutMs: 3000 }),
    newCli: () => { cliId += '-new'; },
    restart: async () => { await runtime.close(); await open(); },
    close: async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); },
  };
}

const spawnArgs = {title:'Inspect signing',instructions:'Inspect the two workflows read-only.',target_profile:'default-worker'};
const submit = (f: Awaited<ReturnType<typeof fixture>>, text: string, attachmentIds?: string[]) =>
  f.runtime.submitInput({scope:f.scope,text,attachmentIds},{execute:true,writeMemory:false});

test('text fragments and an image are one durable decision and one task, with one acknowledgement', async () => {
  const f = await fixture(async (call, process, turn) => {
    expect(turn).toBe(1);
    expect(f.prompts[0]).toContain('Inspect repo A');
    expect(f.prompts[0]).toContain('and repo B');
    expect(f.prompts[0]).toContain('(photo)');
    expect(f.images[0]).toHaveLength(1);
    await call('conversation_intake',{mode:'ready',acknowledgement:'Inspecting the two workflows.'});
    expect((await call('task_spawn',spawnArgs)).taskId).toBeTruthy();
    finish(process, 'Started.');
  });
  try {
    const a=submit(f,'Inspect repo A'), b=submit(f,'and repo B'), c=submit(f,'(photo)',['media/c/image.png']);
    expect(await Promise.all([a.response,b.response,c.response])).toEqual(Array(3).fill('Inspecting the two workflows.'));
    expect(f.failures).toEqual([]);
    expect(f.prompts).toHaveLength(1);
    const decision=f.runtime.store.get("SELECT input_ids_json FROM conversation_decisions WHERE kind='user'")!;
    expect(JSON.parse(String(decision.input_ids_json))).toEqual([a.inputId,b.inputId,c.inputId]);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    const revision=JSON.parse(String(f.runtime.store.get('SELECT payload_json FROM task_revisions')!.payload_json));
    expect(revision.contextRefs).toEqual(expect.arrayContaining([a.inputId,b.inputId,c.inputId,'media/c/image.png']));
    const messages=await f.sessions.loadTelegramSession('a','c','s','telegram');
    expect(messages.filter(row=>row.role==='user').map(row=>row.content)).toEqual(['Inspect repo A','and repo B','(photo)']);
    expect(messages.filter(row=>row.role==='assistant').map(row=>row.content)).toEqual(['Inspecting the two workflows.']);
    // A transport retry of a handled batch member reuses the one answer.
    expect(await f.runtime.submitInput({scope:f.scope,text:'and repo B',acceptedInputId:b.inputId},{execute:true,writeMemory:false}).response).toBe('Inspecting the two workflows.');
    expect(f.prompts).toHaveLength(1);
  } finally {await f.close();}
});

test('new text while thinking discards the unsent answer and reconsiders both inputs once', async () => {
  let ready!:()=>void, release!:()=>void;
  const started=new Promise<void>(resolve=>{ready=resolve;});
  const proceed=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(async (_call,process,turn)=>{
    if(turn===1){ready();await proceed;finish(process,'STALE answer to only the first fragment');}
    else{expect(turn).toBe(2);expect(f.prompts[1]).toContain('Compare repo A');expect(f.prompts[1]).toContain('with repo B');finish(process,'Combined comparison.');}
  });
  try{
    const a=submit(f,'Compare repo A');await started;
    const b=submit(f,'with repo B');release();
    expect(await Promise.all([a.response,b.response])).toEqual(['Combined comparison.','Combined comparison.']);
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get("SELECT count(*) n FROM conversation_events WHERE type='response.superseded'")!.n).toBe(1);
    expect((await f.sessions.loadTelegramSession('a','c','s','telegram')).filter(row=>row.role==='assistant').map(row=>row.content)).toEqual(['Combined comparison.']);
    expect(f.runtime.store.get("SELECT count(*) n FROM conversation_inputs WHERE status!='handled'")!.n).toBe(0);
  }finally{release();await f.close();}
});

test('a follow-up after task commit updates the existing task and never replays the original dispatch',async()=>{
  let ready!:()=>void,release!:()=>void,taskId='';
  const started=new Promise<void>(resolve=>{ready=resolve;});const proceed=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(async(call,process,turn)=>{
    if(turn===1){
      await call('conversation_intake',{mode:'ready',acknowledgement:'Inspecting repo A.'});
      taskId=(await call('task_spawn',spawnArgs)).taskId;expect(taskId).toBeTruthy();ready();await proceed;
    }else{
      expect(turn).toBe(2);
      await call('conversation_intake',{mode:'update',task_id:taskId,acknowledgement:'Including repo B.'});
      expect((await call('task_update',{task_id:taskId,expected_revision:1,instruction:'Inspect repo A and repo B read-only.',mode:'when_ready'})).revision).toBe(2);
    }
    finish(process);
  });
  try{
    const a=submit(f,'Inspect repo A');await started;const b=submit(f,'Include repo B too');release();
    await Promise.all([a.response,b.response]);
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    expect(f.runtime.store.task(taskId)?.revision).toBe(2);
    expect(f.runtime.store.get("SELECT count(*) n FROM conversation_events WHERE type='response.superseded'")!.n).toBe(0);
  }finally{release();await f.close();}
});

test('a deferred batch preserves every original input when another message arrives after acknowledgement',async()=>{
  let ready!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{ready=resolve;});const proceed=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(async(call,process,turn)=>{
    if(turn===1){
      await call('conversation_intake',{mode:'ready',acknowledgement:'Inspecting the workflows.',preparation:'Compare the two repositories.'});
      ready();await proceed;
      expect(await call('task_spawn',spawnArgs)).toMatchObject({error:'NEW_INPUT_PENDING'});
    }else{
      expect(turn).toBe(2);expect(f.prompts[1]).toContain('Original repo A');expect(f.prompts[1]).toContain('Original repo B');
      await call('conversation_intake',{mode:'ready',acknowledgement:'Including the signing configuration.'});
      const task=await call('task_spawn',spawnArgs);expect(task.taskId).toBeTruthy();
      await call('conversation_intake',{mode:'resolve',task_id:task.taskId,resolution:'Both original repositories and the latest constraint are queued.'});
    }
    finish(process);
  });
  try{
    const a=submit(f,'Original repo A'),b=submit(f,'Original repo B');await started;
    const c=submit(f,'Include signing configuration');release();await Promise.all([a.response,b.response,c.response]);
    expect(f.failures).toEqual([]);expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    const revision=JSON.parse(String(f.runtime.store.get('SELECT payload_json FROM task_revisions')!.payload_json));
    expect(revision.contextRefs).toEqual(expect.arrayContaining([a.inputId,b.inputId,c.inputId]));
    expect(f.runtime.store.get('SELECT count(*) n FROM conversation_intake')!.n).toBe(0);
  }finally{release();await f.close();}
});

test('a restart during the debounce window recovers the whole burst from durable inputs',async()=>{
  const f=await fixture(async(_call,process,turn)=>{expect(turn).toBe(1);finish(process,'Recovered both fragments.');});
  try{
    const a=submit(f,'Durable fragment A'),b=submit(f,'Durable fragment B');
    void a.response.catch(()=>{});void b.response.catch(()=>{});
    await f.restart();
    for(let i=0;i<300 && f.runtime.store.get("SELECT count(*) n FROM conversation_inputs WHERE status!='handled'")!.n;i++)await new Promise(resolve=>setTimeout(resolve,10));
    expect(f.failures).toEqual([]);expect(f.prompts).toHaveLength(1);
    expect(f.prompts[0]).toContain('Durable fragment A');expect(f.prompts[0]).toContain('Durable fragment B');
    expect(JSON.parse(String(f.runtime.store.get("SELECT input_ids_json FROM conversation_decisions WHERE kind='user'")!.input_ids_json))).toEqual([a.inputId,b.inputId]);
  }finally{await f.close();}
});

test.each([
  ['a reply to a different message', {metadata:{repliedMessageId:'other-message'}}, undefined],
  ['a different execution grant', {}, {execute:false,writeMemory:false}],
  ['a recorded voice note', {modality:'voice_note' as const}, undefined],
  ['an installed skill', {skill:{name:'fixture-skill',args:'',content:'Fixture skill.',filePath:'/fixture/SKILL.md'}}, undefined],
  ['a different model', {model:'other-model'}, undefined],
])('%s arriving while thinking gets its own turn instead of replaying the answer',async(_label,change,capabilities)=>{
  let ready!:()=>void,release!:()=>void;
  const started=new Promise<void>(resolve=>{ready=resolve;});const proceed=new Promise<void>(resolve=>{release=resolve;});
  const f=await fixture(async(_call,process,turn)=>{
    if(turn===1){ready();await proceed;finish(process,'Answer about repo A.');}
    else finish(process,'Separate answer.');
  });
  try{
    const a=submit(f,'Explain repo A');await started;
    const b=f.runtime.submitInput({scope:f.scope,text:'Follow-up',...change},capabilities??{execute:true,writeMemory:false});
    void b.response.catch(()=>{});release();
    expect(await a.response).toBe('Answer about repo A.');
    expect(f.prompts.filter(prompt=>prompt.includes('Explain repo A'))).toHaveLength(1);
    expect(f.runtime.store.get("SELECT count(*) n FROM conversation_events WHERE type='response.superseded'")!.n).toBe(0);
  }finally{release();await f.close();}
});
