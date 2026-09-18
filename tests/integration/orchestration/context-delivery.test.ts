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
