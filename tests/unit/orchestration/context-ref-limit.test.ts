import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { MAX_CONTEXT_REFS, TaskService } from '../../../src/orchestration/tasks/service';
import { DecisionService } from '../../../src/orchestration/decisions';

// Issue #574: semantic intake retains up to 100 input IDs and the runtime adds them all as
// context_refs; the task service must accept a full batch instead of failing with bare INVALID_INPUT.
function setup(inputs: number) {
  const root = mkdtempSync(join(tmpdir(), 'context-ref-limit-'));
  const store = new OrchestrationStore(join(root, 'db'), 'a');
  const scope = { agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const ids = Array.from({ length: inputs }, (_, i) => store.acceptInput({ scope, text: `message ${i}` }));
  const last = ids[ids.length - 1];
  const d = new DecisionService(store).begin(last.conversationId, 'owner', [last.inputId]);
  const service = new TaskService(store);
  const context = { ...last, ...d, principalId: 'owner', actionId: 'spawn', execute: true, writeMemory: false };
  const task = { title: 'T', instructions: 'work', targetProfile: 'default-worker' };
  return { root, store, service, context, task, refs: ids.map(i => i.inputId) };
}

test('a full semantic-intake batch of 100 input refs is accepted', () => {
  const t = setup(100);
  try {
    expect(t.refs).toHaveLength(100);
    expect(() => t.service.spawn(t.context, { ...t.task, contextRefs: t.refs })).not.toThrow();
  } finally { t.store.close?.(); rmSync(t.root, { recursive: true, force: true }); }
});

test('refs beyond the limit fail with an actionable message, not a bare code', () => {
  const t = setup(1);
  try {
    const refs = Array.from({ length: MAX_CONTEXT_REFS + 1 }, (_, i) => `r${i}`);
    expect(() => t.service.spawn(t.context, { ...t.task, contextRefs: refs })).toThrow(/context_refs has 257 entries; the limit is 256/);
  } finally { t.store.close?.(); rmSync(t.root, { recursive: true, force: true }); }
});
