import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { OrchestrationStore } from '../../../src/orchestration/store';
import { MAX_AGENT_CONTEXT_REFS, MAX_CONTEXT_REFS, TaskService, mergeContextRefs } from '../../../src/orchestration/tasks/service';
import { MAX_INTAKE_INPUTS } from '../../../src/orchestration/conversation-intake';
import { DecisionService } from '../../../src/orchestration/decisions';

// Issue #574: semantic intake retains up to MAX_INTAKE_INPUTS input IDs and the runtime adds them all as
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

test('a full semantic-intake batch of input refs is accepted', () => {
  const t = setup(MAX_INTAKE_INPUTS);
  try {
    expect(t.refs).toHaveLength(MAX_INTAKE_INPUTS);
    expect(() => t.service.spawn(t.context, { ...t.task, contextRefs: t.refs })).not.toThrow();
  } finally { t.store.close(); rmSync(t.root, { recursive: true, force: true }); }
});

test('the service cap is a safety net above any gateway-built set; beyond it the error names the sources', () => {
  const t = setup(1);
  try {
    const refs = Array.from({ length: MAX_CONTEXT_REFS + 1 }, (_, i) => `r${i}`);
    expect(() => t.service.spawn(t.context, { ...t.task, contextRefs: refs })).toThrow(new RegExp(`context_refs has ${MAX_CONTEXT_REFS + 1} entries.*agent refs plus pending input IDs.*the limit is ${MAX_CONTEXT_REFS}`));
  } finally { t.store.close(); rmSync(t.root, { recursive: true, force: true }); }
});

test('mergeContextRefs bounds agent refs and gateway input IDs independently, so the merged set cannot exceed the cap', () => {
  const inputs = Array.from({ length: MAX_INTAKE_INPUTS }, (_, i) => `in${i}`);
  const own = Array.from({ length: MAX_AGENT_CONTEXT_REFS }, (_, i) => `own${i}`);
  expect(mergeContextRefs(['own', 'in0'], inputs)).toEqual(['own', ...inputs]);
  expect(mergeContextRefs(undefined, [])).toEqual([]);
  expect(mergeContextRefs(own, inputs)).toHaveLength(MAX_CONTEXT_REFS);
  expect(() => mergeContextRefs([...own, 'one-more'], inputs)).toThrow(new RegExp(`context_refs has ${MAX_AGENT_CONTEXT_REFS + 1} entries; an agent may reference at most ${MAX_AGENT_CONTEXT_REFS}`));
});
