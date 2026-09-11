#!/usr/bin/env node
// Explicit offline operator resolution; no automatic liveness/side-effect guess.
const { dirname, join } = require('node:path');
const { readFileSync } = require('node:fs');
const { OrchestrationStore } = require('../../dist/orchestration/store');
const { TaskService } = require('../../dist/orchestration/tasks/service');
const { acquireInstanceLock } = require('../../dist/orchestration/instance-lock');
const [database, agentId, taskId, state, evidenceFile] = process.argv.slice(2);
if (!evidenceFile || !['queued', 'failed', 'cancelled'].includes(state)) {
  console.error('Usage: node scripts/orchestration/reconcile.cjs ORCHESTRATION_DB AGENT_ID TASK_ID queued|failed|cancelled EVIDENCE_FILE');
  console.error('Stop the gateway and verify process liveness and side effects first. queued explicitly authorizes another attempt.');
  process.exit(2);
}
let release, store;
try {
  release = acquireInstanceLock(join(dirname(database), 'orchestration-instance.lock'));
  store = new OrchestrationStore(database, agentId);
  const result = new TaskService(store).reconcile(taskId, state, readFileSync(evidenceFile, 'utf8'));
  console.log(JSON.stringify({ taskId: result.taskId, state: result.state, stateVersion: result.stateVersion }));
} catch (error) { console.error(error.code || error.message); process.exitCode = 1; }
finally { store?.close(); release?.(); }
