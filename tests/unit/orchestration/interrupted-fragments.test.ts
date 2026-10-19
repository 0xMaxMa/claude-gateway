import { OrchestrationStore } from '../../../src/orchestration/store';
import { DecisionService } from '../../../src/orchestration/decisions';
import { FRAGMENT_MAX_AGE_MS, FRAGMENT_MAX_COUNT, interruptedFragmentContext, unansweredInputContext } from '../../../src/orchestration/unanswered-inputs';

// Issue #624: only this principal's live voice fragments, cut off by barge-in, recently.
function fixture() {
  const store = new OrchestrationStore(':memory:', 'a'), decisions = new DecisionService(store);
  const scope = (principalId = 'owner') => ({ agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId });
  let n = 0;
  const accept = (text: string, modality = 'live_voice', principalId = 'owner') =>
    store.acceptInput({ scope: scope(principalId), text, modality: modality as any, ingressKey: `k${n++}` });
  const cutOff = (text: string, options: { modality?: string; principalId?: string; bargeIn?: boolean; ageMs?: number } = {}) => {
    const input = accept(text, options.modality, options.principalId);
    const decision = decisions.begin(input.conversationId, options.principalId ?? 'owner', [input.inputId]);
    decisions.interrupt(decision);
    decisions.finish(decision, '', 'interrupted', undefined, false);
    if (options.bargeIn !== false) store.transaction(() => store.appendEvent(input.conversationId, 'response.barge_in', { responseId: decision.responseId, decisionId: decision.decisionId }));
    if (options.ageMs) store.run('UPDATE conversation_inputs SET created_at=created_at-? WHERE id=?', options.ageMs, input.inputId);
    return input;
  };
  const current = (text = 'ล่าสุด', modality = 'live_voice') => { const input = accept(text, modality); return interruptedFragmentContext(store, input.conversationId, input.inputId); };
  return { store, cutOff, current };
}

const listed = (context: string) => context ? JSON.parse(context.split(': ')[1].split('\n')[0]) : [];

test('recent barged-in fragments are listed oldest first, bounded in count', () => {
  const f = fixture();
  try {
    for (let i = 0; i < FRAGMENT_MAX_COUNT + 2; i++) f.cutOff(`part ${i}`);
    const context = f.current();
    expect(listed(context)).toEqual(Array.from({ length: FRAGMENT_MAX_COUNT }, (_, i) => `part ${i + 2}`));
    expect(context).toContain('The current user message below is the latest part');
  } finally { f.store.close(); }
});

test('an older fragment, a stop control, a typed input or the current input itself are not fragments', () => {
  const f = fixture();
  try {
    f.cutOff('too old', { ageMs: FRAGMENT_MAX_AGE_MS + 1000 });
    f.cutOff('stopped', { bargeIn: false });
    f.cutOff('typed', { modality: 'text' });
    expect(f.current()).toBe('');
    f.cutOff('recent');
    expect(listed(f.current())).toEqual(['recent']);
  } finally { f.store.close(); }
});

test('a typed current input gets no fragment context', () => {
  const f = fixture();
  try {
    f.cutOff('recent');
    expect(f.current('typed', 'text')).toBe('');
  } finally { f.store.close(); }
});

test('another principal fragments are never shown to this principal', () => {
  const f = fixture();
  try {
    const owner = f.store.acceptInput({ scope: { agentId: 'a', agentSessionId: 'session', source: 'api', accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'x', modality: 'text', ingressKey: 'seed' });
    f.store.run("INSERT INTO conversation_members VALUES(?,?,?)", owner.conversationId, 'guest', 'member');
    f.cutOff('guest words', { principalId: 'guest' });
    expect(f.current()).toBe('');
  } finally { f.store.close(); }
});

test('fragments from another live session are never carried over', () => {
  const f = fixture();
  try {
    f.cutOff('other session');
    const other = f.store.acceptInput({ scope: { agentId: 'a', agentSessionId: 'other-session', source: 'api', accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' }, text: 'ล่าสุด', modality: 'live_voice', ingressKey: 'other' });
    expect(interruptedFragmentContext(f.store, other.conversationId, other.inputId)).toBe('');
  } finally { f.store.close(); }
});

// A spoken acknowledgement is its own completed decision over the same input; it receipts the
// request, it does not answer it, so the reply that then fails still leaves the input unanswered.
test('an acknowledged input whose reply failed stays in the failed-input context', () => {
  const store = new OrchestrationStore(':memory:', 'a'), decisions = new DecisionService(store);
  try {
    const scope = { agentId: 'a', agentSessionId: 'session', source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
    const first = store.acceptInput({ scope, text: 'deploy the fix', ingressKey: 'one' });
    const decision = decisions.begin(first.conversationId, 'owner', [first.inputId]);
    decisions.acknowledge(decision, 'Deploying the fix now.');
    decisions.finish(decision, 'failed', 'failed');
    const next = store.acceptInput({ scope, text: 'and?', ingressKey: 'two' });
    expect(unansweredInputContext(store, next.conversationId, next.inputId)).toContain('deploy the fix');
  } finally { store.close(); }
});
