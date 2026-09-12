#!/usr/bin/env node
// Read-only operator inspection. Never print tickets, prompts or credentials.
const { DatabaseSync } = require('node:sqlite');
if (process.argv.length !== 3) { console.error('Usage: node scripts/orchestration/inspect.cjs /path/to/agent/orchestration.db'); process.exit(2); }
const db = new DatabaseSync(process.argv[2], { readOnly: true });
try {
  const all = sql => db.prepare(sql).all();
  console.log(JSON.stringify({
    conversations: all('SELECT status,COUNT(*) count FROM conversations GROUP BY status'),
    inputs: all('SELECT status,COUNT(*) count FROM conversation_inputs GROUP BY status'),
    tasks: all('SELECT state,COUNT(*) count FROM tasks GROUP BY state'),
    outbox: all('SELECT kind,state,COUNT(*) count FROM outbox GROUP BY kind,state'),
    resources: all('SELECT mode,lifecycle_state,COUNT(*) count FROM task_resources GROUP BY mode,lifecycle_state'),
    reconcile: all("SELECT t.id,t.state,t.active_attempt_id,r.worktree_path FROM tasks t LEFT JOIN task_resources r ON r.task_id=t.id WHERE t.state='needs_reconciliation'"),
  }, null, 2));
} finally { db.close(); }
