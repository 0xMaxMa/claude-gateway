#!/usr/bin/env node
// Disposable real-CLI vision + worker handoff probe. Supply an image containing
// a unique readable code and that expected code; neither code nor filename is in the prompt.
const { mkdtempSync, mkdirSync, writeFileSync, readFileSync, copyFileSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { randomUUID } = require('node:crypto');
const assert = require('node:assert/strict');
const { SessionStore } = require('../../dist/session/store');
const { SessionProcess } = require('../../dist/session/process');
const { HistoryDB } = require('../../dist/history/db');
const { AgentOrchestrationRuntime } = require('../../dist/orchestration/runtime');
(async () => {
  const [imagePath, expected] = process.argv.slice(2);
  if (!imagePath || !expected) throw Error('Usage: smoke-vision.cjs IMAGE EXPECTED_CODE');
  const root = mkdtempSync(join(tmpdir(), 'gateway-vision-'));
  const agentsRoot = join(root, 'agents'), agentDir = join(agentsRoot, 'probe'), workspace = join(agentDir, 'workspace');
  mkdirSync(workspace, { recursive: true }); mkdirSync(join(agentDir, 'media/c'), { recursive: true });
  copyFileSync(imagePath, join(agentDir, 'media/c/image.png'));
  writeFileSync(join(workspace, 'CLAUDE.md'), 'Be concise. Follow the orchestration role.');
  const agent = { id: 'probe', workspace, env: '', description: 'Disposable vision probe', claude: { model: process.env.ORCHESTRATION_SMOKE_MODEL || 'sonnet', extraFlags: [] }, orchestration: { conversation: { decisionTimeoutMs: 60000 }, tasks: { defaultTimeoutMs: 90000 } } };
  const gateway = { gateway: { orchestration: true, headless: true, logDir: join(root, 'logs'), timezone: 'UTC' }, agents: [agent] };
  const sessions = new SessionStore(agentsRoot), history = HistoryDB.forDir(agentDir, 'probe');
  const host = { createAgentSession: async (id, profile) => new SessionProcess(id, 'api', agent, gateway, sessions, undefined, profile), releaseAgentSession: async (_, p) => p.stop() };
  let runtime;
  try {
    runtime = await AgentOrchestrationRuntime.open(agent, gateway, agentDir, sessions, history, host);
    const scope = { agentId: 'probe', agentSessionId: randomUUID(), source: 'api', accountId: 'fixture', chatId: 'c', threadKey: '', principalId: 'fixture' };
    const send = text => runtime.send({ scope, text, attachmentIds: ['media/c/image.png'], requestId: randomUUID() }, { execute: true, writeMemory: false }, { timeoutMs: 60000 });
    const answer = await send('Read the code and describe the colored shapes in this image.');
    assert(answer.includes(expected), answer);
    assert.equal(runtime.store.get('SELECT COUNT(*) AS n FROM tasks').n, 0);
    console.log(JSON.stringify({ phase: 'agent_reads_image', answer, tasks: 0 }));
    const ack = await send('First inspect this image yourself, then ask a media-worker to write a file named vision-proof.txt containing the exact code shown. Tell it to verify the original image and stage the file. Include your visual observations in the task instructions.');
    console.log(JSON.stringify({ phase: 'dispatch', ack }));
    const deadline = Date.now() + 100000;
    let task;
    while (Date.now() < deadline) {
      const row = runtime.store.get('SELECT snapshot_json FROM tasks ORDER BY created_at DESC LIMIT 1');
      task = row && JSON.parse(row.snapshot_json);
      if (task && ['completed', 'failed', 'cancelled', 'needs_reconciliation'].includes(task.state)) break;
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
    assert.equal(task?.state, 'completed', JSON.stringify(task));
    const files = runtime.store.all('SELECT path FROM task_files WHERE task_id=?', task.taskId);
    assert(files.some(f => readFileSync(join(agentDir, f.path), 'utf8').includes(expected)), JSON.stringify(files));
    console.log(JSON.stringify({ phase: 'worker_verified_original_and_produced_file', taskId: task.taskId, state: task.state, files, root }));
  } finally { await runtime?.close(); history.db.close(); HistoryDB.evict(agentsRoot, 'probe'); }
})().catch(error => { console.error(error); process.exitCode = 1; });
