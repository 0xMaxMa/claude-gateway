import { ProviderRefusals } from '../../../src/session/provider-refusal';
import { ProcessDiagnostics } from '../../../src/session/process-diagnostics';

// Shapes recorded from Claude Code 2.1.296 stream-json (--include-partial-messages)
// and its native transcript; values are synthetic.
const EXPLANATION = 'This request triggered restrictions on violative cyber content and was blocked under Anthropic\'s Usage Policy. To learn more, see https://platform.claude.com/docs/en/build-with-claude/refusals-and-fallback.';
const start = (id: string) => ({ type: 'stream_event', event: { type: 'message_start', message: { id, model: 'claude-opus-5-5', content: [], stop_reason: null, stop_details: null } } });
const delta = (stop_reason: string, stop_details: unknown) => ({ type: 'stream_event', event: { type: 'message_delta', delta: { stop_reason, stop_sequence: null, stop_details, container: null } } });
const refusal = (details: Record<string, unknown> = {}) => ({ type: 'refusal', category: 'cyber', explanation: EXPLANATION, ...details });

function observe(events: Record<string, unknown>[]): ProviderRefusals {
  const ledger = new ProviderRefusals();
  for (const event of events) ledger.observe(event);
  return ledger;
}

describe('ProviderRefusals (#586)', () => {
  it('records the provider category and explanation from a streamed message_delta, correlated to message_start', () => {
    expect(observe([start('msg_refused'), delta('refusal', refusal())]).list())
      .toEqual([{ messageId: 'msg_refused', category: 'cyber', explanation: EXPLANATION }]);
  });

  it.each([
    'Blocked for reasons the provider chose to word differently.',
    'คำขอนี้ถูกปฏิเสธตามนโยบายของผู้ให้บริการ',
  ])('passes any explanation wording through unchanged (%s)', explanation => {
    expect(observe([start('m'), delta('refusal', refusal({ category: 'other', explanation }))]).list())
      .toEqual([{ messageId: 'm', category: 'other', explanation }]);
  });

  it('never derives a refusal from prose: ordinary text about safety or refusals is not an event', () => {
    const prose = 'This request triggered restrictions and was blocked under the Usage Policy (refusal).';
    expect(observe([
      start('m'),
      { type: 'assistant', message: { id: 'm', stop_reason: null, content: [{ type: 'text', text: prose }] } },
      delta('end_turn', null),
      { type: 'assistant', message: { id: 'm2', stop_reason: 'end_turn', stop_details: null, content: [{ type: 'text', text: prose }] } },
      { type: 'result', subtype: 'success', result: prose, stop_reason: 'end_turn' },
    ]).list()).toEqual([]);
  });

  it.each([
    ['missing details', undefined],
    ['null details', null],
    ['unknown details type', { type: 'something_new', category: 'cyber', explanation: EXPLANATION }],
    ['non-string fields', { type: 'refusal', category: 7, explanation: { text: EXPLANATION } }],
    ['blank fields', { type: 'refusal', category: ' ', explanation: '' }],
  ])('keeps the refusal but supplies no cause for %s', (_label, details) => {
    expect(observe([start('m'), delta('refusal', details)]).list()).toEqual([{ messageId: 'm' }]);
  });

  it('collapses the streamed, final and synthetic API-error representations of one native refusal', () => {
    const ledger = observe([
      start('msg_refused'),
      delta('refusal', null),
      { type: 'assistant', message: { id: 'msg_refused', stop_reason: 'refusal', stop_details: refusal(), content: [{ type: 'tool_use', id: 't', name: 'Bash', input: {} }] } },
      { type: 'assistant', isApiErrorMessage: true, error: 'invalid_request', refusedMessageId: 'msg_refused',
        message: { id: 'synthetic-1', model: '<synthetic>', stop_reason: 'refusal', stop_details: refusal(), content: [{ type: 'text', text: 'API Error' }] } },
      // Without refusedMessageId, a synthetic record still replaces the message being streamed.
      { type: 'assistant', isApiErrorMessage: true, message: { id: 'synthetic-2', stop_reason: 'refusal', stop_details: refusal(), content: [] } },
    ]);
    expect(ledger.list()).toEqual([{ messageId: 'msg_refused', category: 'cyber', explanation: EXPLANATION, toolCalls: [{ id: 't', name: 'Bash', result: false }] }]);
  });

  it('keeps distinct refusals in order and bounds the ledger', () => {
    const events = Array.from({ length: 20 }, (_, i) => [start(`m${i}`), delta('refusal', refusal({ category: `c${i}` }))]).flat();
    const list = observe(events).list();
    expect(list).toHaveLength(16);
    expect(list.slice(0, 2).map(entry => entry.messageId)).toEqual(['m0', 'm1']);
  });

  it('redacts credentials and bounds provider text with the existing provider-message sanitizer', () => {
    const [entry] = observe([start('m'), delta('refusal', refusal({ category: 'x'.repeat(200), explanation: `Blocked. api_key=abc123 ${'y'.repeat(5000)}` }))]).list();
    expect(entry.category).toHaveLength(64);
    expect(entry.explanation).toContain('api_key=[redacted]');
    expect(entry.explanation).not.toContain('abc123');
    expect(entry.explanation!.length).toBeLessThanOrEqual(2048);
  });

  it('keeps tool calls of a refused message distinguishable by whether an execution result was recorded', () => {
    const toolUse = (id: string, name: string) => ({ type: 'tool_use', id, name, input: {} });
    const ledger = observe([
      start('msg_refused'),
      { type: 'stream_event', event: { type: 'content_block_start', index: 0, content_block: toolUse('t1', 'Bash') } },
      { type: 'assistant', message: { id: 'msg_refused', stop_reason: null, content: [toolUse('t1', 'Bash'), toolUse('t2', 'Read')] } },
      delta('refusal', refusal()),
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't2', content: 'ok' }] } },
      start('msg_other'),
      { type: 'assistant', message: { id: 'msg_other', content: [toolUse('t3', 'Grep')] } },
      { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't3', content: 'ok' }] } },
    ]);
    expect(ledger.list()).toEqual([{ messageId: 'msg_refused', category: 'cyber', explanation: EXPLANATION,
      toolCalls: [{ id: 't1', name: 'Bash', result: false }, { id: 't2', name: 'Read', result: true }] }]);
  });

  it('keeps a refused message\'s tool calls after many later tool calls in the same turn', () => {
    const later = Array.from({ length: 400 }, (_, i) => ({ type: 'assistant', message: { id: `m${i}`, content: [{ type: 'tool_use', id: `x${i}`, name: 'Read', input: {} }] } }));
    const ledger = observe([start('msg_refused'), { type: 'assistant', message: { id: 'msg_refused', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
      delta('refusal', null), ...later, { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 't1' }] } }]);
    expect(ledger.list()).toEqual([{ messageId: 'msg_refused', toolCalls: [{ id: 't1', name: 'Bash', result: true }] }]);
  });

  it('reset() drops every refusal and the message correlation', () => {
    const ledger = observe([start('m'), delta('refusal', refusal())]);
    ledger.reset();
    ledger.observe(delta('refusal', null));
    expect(ledger.list()).toEqual([{}]);
  });
});

describe('ProcessDiagnostics refusal evidence (#586)', () => {
  it('keeps a refusal visible in a turn that later completed, then drops it on the next turn', () => {
    const diagnostics = new ProcessDiagnostics();
    for (const event of [start('msg_refused'), delta('refusal', refusal()), start('msg_fallback'), delta('end_turn', null),
      { type: 'result', subtype: 'success', is_error: false, result: 'Fallback answer', safety_stops: 1 }]) diagnostics.observe(event);
    expect(diagnostics.snapshot()).toMatchObject({ turnOutcome: 'completed', inferenceOutcome: 'succeeded', safetyStops: 1,
      providerRefusals: [{ messageId: 'msg_refused', category: 'cyber', explanation: EXPLANATION }] });
    diagnostics.reset();
    diagnostics.observe({ type: 'result', subtype: 'success', is_error: false, result: 'ok', safety_stops: 0 });
    expect(diagnostics.snapshot()).not.toHaveProperty('providerRefusals');
    expect(diagnostics.snapshot()).toMatchObject({ safetyStops: 0 });
  });
});
