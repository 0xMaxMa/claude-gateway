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
    orchestration: { conversation: { semanticIntake: true, intakeWaitMs: 60000, notificationPolicy: 'next_user_turn' } } };
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
    jest.spyOn((runtime as any).cliSessions, 'resolve').mockImplementation(() => ({ id: cliId, resume: true }));
  };
  await open();
  const scope = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'key', chatId: 'c', threadKey: '', principalId: 'p' };
  return { get runtime() { return runtime; }, scope, prompts, images, failures, sessions,
    send: (text: string, attachmentIds?: string[]) => runtime.send({ scope, text, attachmentIds }, { execute: true, writeMemory: false }, { timeoutMs: 3000 }),
    newCli: () => { cliId += '-new'; },
    restart: async () => { await runtime.close(); await open(); },
    close: async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); },
  };
}

test('resumed prompt does not repeat unchanged tasks or committed receipts; changed and completed states arrive once', async () => {
  const f = await fixture();
  try {
    const input = f.runtime.store.acceptInput({ scope: f.scope, text: 'Original task request' });
    const decision = f.runtime.decisions.begin(input.conversationId, 'p', [input.inputId]);
    const task = f.runtime.tasks.spawn({ ...input, ...decision, principalId: 'p', execute: true, writeMemory: false, actionId: 'seed-task' },
      { title: 'Unique regression task', instructions: 'Preserve the full original report.', targetProfile: 'default-worker' });
    // Stable pending work, with no worker timing involved in the prompt assertions.
    const waiting = f.runtime.store.task(task.taskId)!;
    f.runtime.store.transaction(() => { waiting.state = 'waiting_input'; f.runtime.store.saveTask(waiting, waiting.stateVersion); });
    f.runtime.decisions.finish(decision, 'Task accepted', 'interrupted');
    await f.send('First follow-up');
    expect(snapshots(f.prompts[0]).map(row => row.taskId)).toContain(task.taskId);
    expect(receipts(f.prompts[0])).toHaveLength(1);
    await f.send('Second follow-up');
    expect(snapshots(f.prompts[1])).toEqual([]);
    expect(receipts(f.prompts[1])).toEqual([]);
    const changed = f.runtime.store.task(task.taskId)!;
    f.runtime.store.transaction(() => { changed.title = 'Updated unique task'; f.runtime.store.saveTask(changed, changed.stateVersion); });
    await f.send('Third follow-up');
    expect(snapshots(f.prompts[2])).toHaveLength(1);
    expect(snapshots(f.prompts[2])[0].title).toBe('Updated unique task');
    await f.send('Fourth follow-up');
    expect(snapshots(f.prompts[3])).toEqual([]);
    const completed = f.runtime.store.task(task.taskId)!;
    f.runtime.store.transaction(() => { completed.state = 'completed'; completed.result = { summary: 'Complete stored result', artifactIds: [] }; f.runtime.store.saveTask(completed, completed.stateVersion); });
    await f.send('Fifth follow-up');
    expect(snapshots(f.prompts[4])[0].state).toBe('completed');
    await f.send('Sixth follow-up');
    expect(snapshots(f.prompts[5])).toEqual([]);
    expect(f.runtime.store.task(task.taskId)?.result?.summary).toBe('Complete stored result');
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
});

test('pending original text and images survive canonically but are not resent after resumed turns and restart', async () => {
  const f = await fixture(async (call, process, turn) => {
    if (turn === 1) expect(await call('conversation_intake', { mode: 'wait', preparation: 'Unique prepared report', clarification: 'What should I inspect?' })).toEqual({ waiting: true, prepared: true });
    finish(process);
  });
  try {
    await f.send('Unique original image material', ['media/c/image.png']);
    expect(f.images[0]).toHaveLength(1);
    await f.send('Still considering it');
    expect(f.images[1]).toEqual([]);
    expect(f.prompts[1]).not.toContain('Unique original image material');
    expect(f.prompts[1]).not.toContain('Unique prepared report'); // supplied by the completed intake tool call
    await f.restart();
    await f.send('Continue considering it');
    expect(f.images[2]).toEqual([]);
    expect(f.prompts[2]).not.toContain('Unique original image material');
    expect(f.prompts[2]).not.toContain('Unique prepared report');
    f.newCli();
    await f.send('A fresh context');
    expect(f.images[3]).toHaveLength(1);
    expect(f.prompts[3]).toContain('Unique original image material');
    expect(f.prompts[3]).toContain('Unique prepared report');
    const conversationId = String(f.runtime.store.get('SELECT id FROM conversations')!.id);
    (f.runtime as any).contextDelivery.invalidateConversation(conversationId);
    await f.send('After compact');
    expect(f.images[4]).toHaveLength(1);
    expect(f.prompts[4]).toContain('Unique original image material');
    const history = await f.sessions.loadSession('a', 's');
    expect(history.some(message => message.content === 'Unique original image material')).toBe(true);
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
});

test.each(['failed', 'interrupted'] as const)('%s turns do not commit delivery of image context', async mode => {
  let ready!: () => void, release!: () => void;
  const reading = new Promise<void>(resolve => { ready = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (_call, process, turn) => {
    if (turn === 1) {
      ready(); await proceed;
      if (mode === 'failed') process.emit('output', JSON.stringify({ type: 'result', is_error: true, result: 'fixture provider failure' }));
      else finish(process);
    } else finish(process);
  });
  try {
    const first = f.send('Inspect this image', ['media/c/image.png']).catch(() => 'expected failure');
    await reading;
    if (mode === 'interrupted') expect(f.runtime.stopResponse('s')).toBe(true);
    release(); await first;
    await f.send('Retry image inspection', ['media/c/image.png']);
    expect(f.images[0]).toHaveLength(1);
    expect(f.images[1]).toHaveLength(1);
    await f.send('Image is already known', ['media/c/image.png']);
    expect(f.images[2]).toEqual([]);
    expect(f.failures).toEqual([]);
  } finally { release(); await f.close(); }
});

test('worker progress after the task tool receipt remains new context on the following turn', async () => {
  let taskId = '';
  const f = await fixture(async (call, process, turn) => {
    if (turn === 1) {
      expect((await call('conversation_intake', { mode: 'ready', acknowledgement: 'I am reviewing it.' })).acknowledged).toBe(true);
      const receipt = await call('task_spawn', { title: 'Progress race task', instructions: 'Review the complete supplied report.', target_profile: 'default-worker' });
      expect(receipt.taskId).toBeTruthy();
      taskId = receipt.taskId;
      const advanced = f.runtime.store.task(taskId)!;
      f.runtime.store.transaction(() => {
        advanced.state = 'running';
        f.runtime.store.saveTask(advanced, advanced.stateVersion);
      });
    }
    finish(process);
  });
  try {
    await f.send('Review the report');
    await f.send('How is it going?');
    expect(snapshots(f.prompts[1])).toEqual(expect.arrayContaining([expect.objectContaining({ taskId, state: 'running' })]));
    await f.send('Keep working');
    expect(snapshots(f.prompts[2])).toEqual([]);
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
});

test('identical image bytes at new refs are omitted until an automatic compact boundary resets delivery', async () => {
  const f = await fixture(async (_call, process, turn) => {
    if (turn === 3) process.emit('output', JSON.stringify({ type: 'system', subtype: 'compact_boundary' }));
    finish(process);
  });
  try {
    await f.send('Inspect this', ['media/c/image.png']);
    await f.send('The same content via a new ref', ['media/c/image-alias.png']);
    expect(f.images[0]).toHaveLength(1);
    expect(f.images[1]).toEqual([]);
    expect(f.prompts[1]).toContain('media/c/image-alias.png'); // references remain available to workers
    await f.send('Continue with a compact boundary', ['media/c/image.png']);
    expect(f.images[2]).toEqual([]);
    await f.send('Continue after compaction', ['media/c/image.png']);
    expect(f.images[3]).toHaveLength(1);
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
});

test('deduplicated image aliases identify the original among multiple images and survive restart', async () => {
  const f = await fixture();
  try {
    const media = join((f.runtime as any).agent.workspace, '../media/c');
    writeFileSync(join(media, 'different.png'), Buffer.concat([png, Buffer.from('different')]));
    await f.send('First screenshot', ['media/c/image.png']);
    await f.send('Second screenshot', ['media/c/different.png']);
    await f.send('What is in this screenshot?', ['media/c/image-alias.png']);
    expect(f.images[2]).toEqual([]);
    expect(f.prompts[2]).toContain('media/c/image-alias.png');
    const mapping = {ref: 'media/c/image-alias.png', originalRef: 'media/c/image.png'};
    expect(f.prompts[2]).toContain(JSON.stringify([mapping]));
    await f.restart();
    await f.send('Look at that same screenshot again', ['media/c/image-alias.png']);
    expect(f.images[3]).toEqual([]);
    expect(f.prompts[3]).toContain(JSON.stringify([mapping]));
    f.newCli();
    await f.send('Inspect in a new context', ['media/c/image-alias.png']);
    expect(f.images[4]).toHaveLength(1);
    expect(f.prompts[4]).not.toContain(JSON.stringify(mapping));
  } finally { await f.close(); }
});

test('resumed deferred recovery replays the pending obligation but not materials the CLI already holds', async () => {
  let reading!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (call, process, turn) => {
    if (turn === 1) {
      reading(); await proceed;
      expect(await call('conversation_intake', {mode:'ready', acknowledgement:'Inspecting the signing workflow.', preparation:'Inspect both repositories for the signing workflow.'})).toMatchObject({deferred:true});
    } else {
      const prompt = f.prompts[turn - 1];
      // The unresolved obligation (state + preparation) is replayed on every recovery turn...
      expect(prompt).toContain('"deferredDispatch":true');
      expect(prompt).toContain('Inspect both repositories for the signing workflow.');
      // ...but source materials already delivered to this resumed CLI context (turn 1) are not injected again (#576).
      expect(prompt).not.toContain('Inspect original signing workflow');
      if (turn === 2) { finish(process, 'These are signing secret names.'); return; }
      expect(turn).toBe(3);
      await call('conversation_intake', {mode:'ready', acknowledgement:'Inspecting both repositories now.'});
      const task = await call('task_spawn', {title:'Inspect signing', instructions:'Inspect both repositories read-only.', target_profile:'default-worker'});
      expect(task.taskId).toBeTruthy();
      expect(await call('conversation_intake', {mode:'resolve',task_id:task.taskId,resolution:'Original inspection dispatched.'})).toEqual({resolved:true});
    }
    finish(process);
  });
  try {
    const first = f.runtime.submitInput({scope:f.scope,text:'Inspect original signing workflow'}, {execute:true,writeMemory:false});
    await started;
    const second = f.runtime.submitInput({scope:f.scope,text:'Here is the screenshot'}, {execute:true,writeMemory:false});
    release(); await first.response; await second.response;
    for (let i=0;i<300 && !f.runtime.store.get('SELECT id FROM tasks');i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    for (let i=0;i<100 && (f.runtime as any).active.size;i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(f.runtime.store.get('SELECT count(*) n FROM conversation_intake')!.n).toBe(0);
  } finally { release(); await f.close(); }
});

test('resumed deferred recovery in a fresh CLI context after deferred intake still receives the source materials', async () => {
  let reading!: () => void, release!: () => void;
  const started = new Promise<void>(resolve => { reading = resolve; });
  const proceed = new Promise<void>(resolve => { release = resolve; });
  const f = await fixture(async (call, process, turn) => {
    if (turn === 1) {
      reading(); await proceed;
      expect(await call('conversation_intake', {mode:'ready', acknowledgement:'Inspecting the signing workflow.', preparation:'Inspect both repositories for the signing workflow.'})).toMatchObject({deferred:true});
    } else {
      const prompt = f.prompts[turn - 1];
      // The unresolved obligation (state + preparation) is replayed on every recovery turn...
      expect(prompt).toContain('"deferredDispatch":true');
      expect(prompt).toContain('Inspect both repositories for the signing workflow.');
      if (turn === 2) { expect(prompt).not.toContain('Inspect original signing workflow'); f.newCli(); finish(process, 'These are signing secret names.'); return; }
      expect(turn).toBe(3);
      // A replaced CLI context has never seen the materials, so they must be bootstrapped again.
      expect(prompt).toContain('Inspect original signing workflow');
      await call('conversation_intake', {mode:'ready', acknowledgement:'Inspecting both repositories now.'});
      const task = await call('task_spawn', {title:'Inspect signing', instructions:'Inspect both repositories read-only.', target_profile:'default-worker'});
      expect(task.taskId).toBeTruthy();
      expect(await call('conversation_intake', {mode:'resolve',task_id:task.taskId,resolution:'Original inspection dispatched.'})).toEqual({resolved:true});
    }
    finish(process);
  });
  try {
    const first = f.runtime.submitInput({scope:f.scope,text:'Inspect original signing workflow'}, {execute:true,writeMemory:false});
    await started;
    const second = f.runtime.submitInput({scope:f.scope,text:'Here is the screenshot'}, {execute:true,writeMemory:false});
    release(); await first.response; await second.response;
    for (let i=0;i<300 && !f.runtime.store.get('SELECT id FROM tasks');i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(f.failures).toEqual([]);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(1);
    for (let i=0;i<100 && (f.runtime as any).active.size;i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(f.runtime.store.get('SELECT count(*) n FROM conversation_intake')!.n).toBe(0);
  } finally { release(); await f.close(); }
});

test('ready without dispatch gets one recovery; an acknowledgement alone is a visible failure, not success', async () => {
  const f = await fixture(async (call, process, turn) => {
    if (turn === 1) await call('conversation_intake', {mode:'ready', acknowledgement:'I will inspect both repositories.', preparation:'Inspect the original signing workflow.'});
    else { expect(turn).toBe(2); expect(f.prompts[1]).toContain('Inspect the original signing workflow.'); }
    finish(process, 'Understood.');
  });
  try {
    await f.send('Inspect the original signing workflow.');
    for (let i=0;i<300 && !f.runtime.store.get("SELECT event_id FROM conversation_events WHERE type='response.dispatch_unresolved'");i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(f.failures).toEqual([]);
    const failed = f.runtime.store.get("SELECT generated_text FROM assistant_responses WHERE state='failed'");
    expect(failed?.generated_text).toMatch(/not started/);
    expect(failed?.generated_text).toMatch(/still saved.*send a short follow-up message to retry or say that you want to cancel it/);
    expect(f.runtime.store.get('SELECT count(*) n FROM tasks')!.n).toBe(0);
    expect(JSON.parse(String(f.runtime.store.get('SELECT data_json FROM conversation_intake')!.data_json)).deferredDispatch).toBe(true);
    expect(f.prompts).toHaveLength(2);
    expect((await f.sessions.loadSession('a','s')).filter(row => row.role==='assistant').some(row => row.content==='Understood.')).toBe(false);
  } finally { await f.close(); }
});

// Issue #574: retained intake (60 inputs, 8 of them with an attachment) used to inject 68 refs into every
// spawn because attachment refs were added on top of the input refs that already carry them.
test('a spawn after 60 retained inputs with 8 attachments is accepted without duplicating attachment refs', async () => {
  const f = await fixture(async (call, process, turn) => {
    if (turn === 1) {
      await call('conversation_intake', {mode:'ready', acknowledgement:'Working on it.', preparation:'Do the retained work.'});
      const task = await call('task_spawn', {title:'Retained work', instructions:'Do the retained work.', target_profile:'default-worker'});
      expect(task.taskId).toBeTruthy();
    }
    finish(process);
  });
  try {
    const retained = Array.from({length:59}, (_, i) => f.runtime.store.acceptInput({scope:f.scope, text:`retained ${i}`, attachmentIds: i < 8 ? [`media/c/retained-${i}.png`] : []}));
    const ids = retained.map(r => r.inputId);
    const first = retained[0];
    const seeded = f.runtime.decisions.begin(first.conversationId, 'p', [first.inputId]);
    f.runtime.decisions.finish(seeded, 'retained', 'completed');
    f.runtime.store.run("UPDATE conversation_inputs SET status='handled'");
    f.runtime.store.run(`INSERT INTO conversation_intake (conversation_id,principal_id,binding_id,mode,data_json,latest_input_seq,last_received_at,clarified_seq,decision_id)
      VALUES(?,?,?,?,?,?,?,?,?)`, first.conversationId, 'p', f.runtime.store.get('SELECT binding_id FROM conversation_inputs WHERE id=?', first.inputId)!.binding_id,
      'ready', JSON.stringify({mode:'ready', inputIds: ids, deferredDispatch: true, preparation: 'Do the retained work.'}), 0, Date.now(), null, seeded.decisionId);
    await f.send('Please do it now');
    for (let i=0;i<300 && !f.runtime.store.get('SELECT id FROM tasks');i++) await new Promise(resolve => setTimeout(resolve,10));
    expect(f.failures).toEqual([]);
    const task = f.runtime.store.get('SELECT id FROM tasks')!;
    const refs = f.runtime.tasks.revision(String(task.id), 1).contextRefs;
    expect(refs).toHaveLength(60);
    expect(refs.every(ref => !ref.startsWith('media/'))).toBe(true);
    // Attachments still reach the worker: each input ref the driver expands keeps its own attachment.
    for (let i=0;i<8;i++) expect(JSON.parse(String(f.runtime.store.get('SELECT attachment_refs_json FROM conversation_inputs WHERE id=?', ids[i])!.attachment_refs_json))).toEqual([`media/c/retained-${i}.png`]);
    expect(ids.slice(0,8).every(id => refs.includes(id))).toBe(true);
  } finally { await f.close(); }
});
