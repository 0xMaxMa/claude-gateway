import { spawn } from 'child_process';
import { once } from 'events';
import { createServer } from 'http';
import { mkdtempSync, rmSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, resolve } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { recoverOrchestration } from '../../../src/orchestration/recovery';
import { DecisionService } from '../../../src/orchestration/decisions';
import { TaskService } from '../../../src/orchestration/tasks/service';
import { DeliveryOutbox } from '../../../src/orchestration/delivery';
import { acquireInstanceLock } from '../../../src/orchestration/instance-lock';

const childSource = `
const fs = require('fs'), path = require('path');
const [root, repo, boundary, provider] = process.argv.slice(1);
const {OrchestrationStore} = require(path.join(repo, 'src/orchestration/store'));
const {DecisionService} = require(path.join(repo, 'src/orchestration/decisions'));
const {TaskService} = require(path.join(repo, 'src/orchestration/tasks/service'));
const {DeliveryOutbox} = require(path.join(repo, 'src/orchestration/delivery'));
require(path.join(repo, 'src/orchestration/instance-lock')).acquireInstanceLock(path.join(root, 'orchestration-instance.lock'));
const store = new OrchestrationStore(path.join(root, 'orchestration.db'), 'a');
const input = store.acceptInput({scope:{agentId:'a',agentSessionId:'agentSession',source:'slack',accountId:'bot',chatId:'original-chat',threadKey:'original-thread',principalId:'owner'}, text:'fixture', capabilities:{execute:true,writeMemory:false}, model:'fixture'});
const ready = payload => { process.send(payload); setInterval(() => {}, 1000); };
(async () => {
 if (boundary === 'input') { ready(input); return; }
 const delivery = new DeliveryOutbox(store, async () => ({state:'unknown',code:'fixture'}));
 const decisions = new DecisionService(store, (r,b,text) => delivery.enqueue(r,b,text));
 const decision = decisions.begin(input.conversationId, 'owner', [input.inputId]);
 if (boundary === 'delivery') {
   decisions.finish(decision, 'provider fixture');
   store.run("UPDATE outbox SET state='processing' WHERE kind='delivery'");
   store.run("UPDATE deliveries SET state='sending'");
   await fetch(provider, {method:'POST', body:'fixture'});
   ready(input); return;
 }
 const tasks = new TaskService(store);
 const task = tasks.spawn({...input,...decision,principalId:'owner',actionId:'action',execute:true,writeMemory:false}, {title:'fixture',instructions:'fixture',targetProfile:'default-worker'});
 if (boundary === 'effect') {
   const attempt = tasks.claim(task.taskId); tasks.started(attempt.attemptId,attempt.generation,{pid:process.pid,startedAt:Date.now(),instanceId:'fixture'});
   const file = fs.openSync(path.join(root,'effect.txt'),'w'); fs.writeFileSync(file,'one effect'); fs.fsyncSync(file); fs.closeSync(file);
 }
 ready({...input,taskId:task.taskId});
})().catch(() => process.exit(1));
`;

test.each(['input', 'task', 'effect', 'delivery'])('SIGKILL at the %s boundary preserves acknowledged intent without blind side-effect replay', async boundary => {
  const root = mkdtempSync(join(tmpdir(), 'orchestration-crash-'));
  let acceptedByProvider = 0;
  const server = createServer((_req, res) => { acceptedByProvider++; res.end('accepted'); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const child = spawn(process.execPath, ['-r', 'ts-node/register/transpile-only', '-e', childSource, root, resolve(__dirname, '../../..'), boundary, url], { stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let store: OrchestrationStore | undefined, release: (() => void) | undefined;
  try {
    const receipt = await new Promise<Record<string, string>>((resolveReady, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture boundary timeout')), 5000);
      child.once('message', value => { clearTimeout(timer); resolveReady(value as Record<string, string>); });
      child.once('exit', () => { clearTimeout(timer); reject(new Error('Fixture exited before boundary')); });
      child.once('error', reject);
    });
    const exited = once(child, 'exit'); child.kill('SIGKILL'); await exited;
    release = acquireInstanceLock(join(root, 'orchestration-instance.lock'));
    store = new OrchestrationStore(join(root, 'orchestration.db'), 'a'); recoverOrchestration(store);
    expect(store.get('SELECT COUNT(*) n FROM conversation_inputs')!.n).toBe(1);
    if (boundary === 'input') expect(store.get('SELECT status FROM conversation_inputs')!.status).toBe('accepted');
    if (boundary === 'task') {
      expect(store.task(receipt.taskId)!.state).toBe('queued');
      expect(store.get('SELECT COUNT(*) n FROM task_commands')!.n).toBe(1);
      expect(store.get("SELECT COUNT(*) n FROM outbox WHERE kind='schedule'")!.n).toBe(1);
    }
    if (boundary === 'effect') {
      expect(store.task(receipt.taskId)!.state).toBe('needs_reconciliation');
      expect(new TaskService(store).claim(receipt.taskId)).toBeUndefined();
      expect(readFileSync(join(root, 'effect.txt'), 'utf8')).toBe('one effect');
    }
    if (boundary === 'task' || boundary === 'effect') {
      const decisions = new DecisionService(store), tasks = new TaskService(store);
      const decision = decisions.begin(receipt.conversationId, 'owner', [receipt.inputId]);
      const context = { ...decision, conversationId: receipt.conversationId, inputId: receipt.inputId,
        principalId: 'owner', actionId: 'new-tool-id-after-crash', execute: true, writeMemory: false };
      const command = { title: 'fixture', instructions: 'fixture', targetProfile: 'default-worker' };
      expect(tasks.spawn(context, command).taskId).toBe(receipt.taskId);
      expect(() => tasks.spawn({ ...context, actionId: 'rephrased-retry' }, { ...command, instructions: 'Rephrased original operation' })).toThrow('already committed');
      expect(store.get('SELECT COUNT(*) n FROM tasks')!.n).toBe(1);
      decisions.finish(decision, 'Recovered committed receipt.');
      const next = store.acceptInput({ scope: {agentId:'a',agentSessionId:'agentSession',source:'slack',accountId:'bot',chatId:'original-chat',threadKey:'original-thread',principalId:'owner'}, text:'Another operation' });
      expect(next.conversationId).toBe(receipt.conversationId);
      const nextDecision = decisions.begin(next.conversationId, 'owner', [next.inputId]);
      expect(tasks.spawn({...next,...nextDecision,principalId:'owner',actionId:'new-user-operation',execute:true,writeMemory:false}, command).taskId).not.toBe(receipt.taskId);
    }
    if (boundary === 'delivery') {
      const send = jest.fn(async () => ({ state: 'delivered' as const }));
      await new DeliveryOutbox(store, send).tick();
      expect(send).not.toHaveBeenCalled(); expect(acceptedByProvider).toBe(1);
      expect(store.get('SELECT state FROM deliveries')!.state).toBe('unknown');
    }
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    store?.close(); release?.(); await new Promise<void>(resolveClose => server.close(() => resolveClose())); rmSync(root, { recursive: true, force: true });
  }
}, 10000);
