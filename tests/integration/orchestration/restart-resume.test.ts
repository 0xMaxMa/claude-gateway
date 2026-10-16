import { EventEmitter } from 'events';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { SessionStore } from '../../../src/session/store';
import { SessionProcess } from '../../../src/session/process';
import { HistoryDB } from '../../../src/history/db';
import { AgentConfig, GatewayConfig } from '../../../src/types';
import { WorkerDriver } from '../../../src/orchestration/tasks/scheduler';

const until = async (predicate: () => boolean) => {
  for (let i = 0; i < 150; i++) { if (predicate()) return; await new Promise(r => setTimeout(r, 20)); }
  throw Error('condition not reached');
};

// Issue #603: after a gateway restart, interrupted authorized work used to surface only as a
// non-executing failure report, so the agent asked the user to type "continue". The gateway
// must resume it by itself, and any report turn must forbid asking for permission to continue.
test('a gateway restart resumes the interrupted task by itself and no report asks the user to continue', async () => {
  const root = mkdtempSync(join(tmpdir(), 'restart-resume-'));
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a');
  const agent: AgentConfig = { id: 'a', workspace: join(root, 'a', 'workspace'), description: '', env: '', claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] } as GatewayConfig;
  const reports: string[] = [], starts: string[] = [];
  let runtime: AgentOrchestrationRuntime | undefined;
  const host = {
    createAgentSession: async () => {
      const process = new EventEmitter() as SessionProcess;
      process.start = async () => {}; process.stop = async () => {};
      process.sendMessage = prompt => {
        if (prompt.includes('Report the persisted')) reports.push(prompt);
        else {
          const d = runtime!.store.get("SELECT * FROM conversation_decisions WHERE state='running'")!;
          runtime!.tasks.spawn({ conversationId: String(d.conversation_id), principalId: 'p', inputId: JSON.parse(String(d.input_ids_json))[0], decisionId: String(d.id), epoch: Number(d.epoch), actionId: 'a', execute: true, writeMemory: false }, { title: 'Release', instructions: 'Tag, push and publish', targetProfile: 'media-worker' });
        }
        process.emit('output', JSON.stringify({ type: 'result', result: 'Done.' }));
      };
      return process;
    }, releaseAgentSession: async () => {},
  };
  // The first gateway's worker runs until shutdown stops it; after the restart it completes.
  const driver = (restarted: boolean): WorkerDriver => ({ start: async task => {
    starts.push(task.taskId);
    let stop!: () => void;
    const result = restarted ? Promise.resolve({ type: 'completed' as const, result: { summary: 'Published after verifying the existing tag.', artifactIds: [] } })
      : new Promise<{ type: 'stopped' }>(resolve => { stop = () => resolve({ type: 'stopped' }); });
    return { accepted: Promise.resolve(), result, stop: async () => stop?.() };
  } });
  try {
    runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, host, driver(false));
    await runtime.send({ scope: { agentId: 'a', agentSessionId: 's', source: 'api', accountId: 'key', chatId: 'chat', threadKey: '', principalId: 'p' }, text: 'Release 2.1.0' }, { execute: true, writeMemory: false }, { timeoutMs: 1000 });
    await until(() => runtime!.store.get("SELECT id FROM tasks WHERE state='running'") !== undefined);
    const taskId = String(runtime.store.get('SELECT id FROM tasks')!.id);
    await runtime.close();

    runtime = await AgentOrchestrationRuntime.open(agent, gateway, root, sessions, history, host, driver(true));
    await until(() => runtime!.store.task(taskId)?.state === 'completed' && reports.length === 1 && !runtime!.isBusy('s'));
    expect(starts).toEqual([taskId, taskId]);
    // The only report is the completion; no turn reported the shutdown as a failure to act on.
    expect(runtime.store.get("SELECT COUNT(*) n FROM notifications WHERE task_id=?", taskId)!.n).toBe(1);
    expect(reports[0]).toContain('For work interrupted by a gateway restart, never ask the user whether to continue it');
    expect(reports[0]).toContain('never tell them to type "continue"');
  } finally { await runtime?.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); }
});
