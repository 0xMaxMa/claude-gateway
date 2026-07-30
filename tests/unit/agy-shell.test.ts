import {
  translateAgyEvent,
  textFromUserTurn,
  agyModelId,
  claudeAssistantLine,
  claudeResultLine,
  AgyTurnState,
} from '../../src/session/agy-shell';

function freshState(): AgyTurnState {
  return { conversationId: null, partialText: '' };
}

describe('agy-shell translation core', () => {
  test('init captures conversation_id, emits nothing', () => {
    const s = freshState();
    const r = translateAgyEvent(
      { event: 'init', conversation_id: 'conv-1', init: { model: 'gemini-3.6-flash-low' } },
      s,
    );
    expect(r.lines).toEqual([]);
    expect(r.done).toBe(false);
    expect(s.conversationId).toBe('conv-1');
  });

  test('agent_response text_delta emits cumulative partial assistant lines', () => {
    const s = freshState();
    const r1 = translateAgyEvent(
      { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'Hel' } },
      s,
    );
    const r2 = translateAgyEvent(
      { event: 'step_update', step_update: { step_type: 'agent_response', text_delta: 'lo' } },
      s,
    );
    expect(JSON.parse(r1.lines[0])).toMatchObject({
      type: 'assistant',
      stop_reason: null,
      message: { content: [{ type: 'text', text: 'Hel' }] },
    });
    // Partials are CUMULATIVE (the gateway parser diffs against the last partial).
    expect(JSON.parse(r2.lines[0]).message.content[0].text).toBe('Hello');
    expect(r2.done).toBe(false);
  });

  test('result SUCCESS emits message_start + final assistant + result', () => {
    const s = freshState();
    s.partialText = 'Hello';
    const r = translateAgyEvent(
      {
        event: 'result',
        result: {
          status: 'SUCCESS',
          response: 'Hello, dear user!',
          usage: { input_tokens: 18946, output_tokens: 8, thinking_tokens: 2, cache_read_tokens: 1200 },
        },
      },
      s,
    );
    expect(r.done).toBe(true);
    const parsed = r.lines.map((l) => JSON.parse(l));
    // message_start: net input = 18946 - 1200, cache carried separately.
    expect(parsed[0]).toMatchObject({
      type: 'stream_event',
      event: { type: 'message_start', message: { usage: { input_tokens: 17746, cache_read_input_tokens: 1200 } } },
    });
    // final assistant
    expect(parsed[1]).toMatchObject({
      type: 'assistant',
      stop_reason: 'end_turn',
      message: { content: [{ type: 'text', text: 'Hello, dear user!' }] },
    });
    // terminal result — output includes thinking tokens (8 + 2)
    expect(parsed[2]).toMatchObject({ type: 'result', is_error: false, result: 'Hello, dear user!', usage: { output_tokens: 10 } });
  });

  test('result with non-SUCCESS status is flagged is_error', () => {
    const s = freshState();
    const r = translateAgyEvent(
      { event: 'result', result: { status: 'ERROR', response: 'boom', usage: {} } },
      s,
    );
    const result = r.lines.map((l) => JSON.parse(l)).find((p) => p.type === 'result');
    expect(result.is_error).toBe(true);
    expect(result.result).toBe('boom');
  });

  test('result falls back to accumulated partial text when response missing', () => {
    const s = freshState();
    s.partialText = 'partial only';
    const r = translateAgyEvent({ event: 'result', result: { status: 'SUCCESS', usage: {} } }, s);
    const result = r.lines.map((l) => JSON.parse(l)).find((p) => p.type === 'result');
    expect(result.result).toBe('partial only');
  });

  test('unknown / malformed events are ignored', () => {
    const s = freshState();
    expect(translateAgyEvent({ event: 'mystery' }, s).lines).toEqual([]);
    expect(translateAgyEvent(null, s).lines).toEqual([]);
    expect(translateAgyEvent({ event: 'step_update', step_update: { step_type: 'checkpoint' } }, s).lines).toEqual([]);
  });
});

describe('agy-shell helpers', () => {
  test('textFromUserTurn extracts concatenated text', () => {
    const line = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] },
    });
    expect(textFromUserTurn(line)).toBe('ab');
  });

  test('textFromUserTurn returns null for non-user / malformed', () => {
    expect(textFromUserTurn('not json')).toBeNull();
    expect(textFromUserTurn(JSON.stringify({ type: 'assistant' }))).toBeNull();
  });

  test('agyModelId strips the gemini/ prefix', () => {
    expect(agyModelId('gemini/gemini-3.6-flash-low')).toBe('gemini-3.6-flash-low');
    expect(agyModelId('gemini-3.1-pro-high')).toBe('gemini-3.1-pro-high');
  });

  test('line builders produce the expected shapes', () => {
    expect(JSON.parse(claudeAssistantLine('hi', true)).stop_reason).toBe('end_turn');
    expect(JSON.parse(claudeAssistantLine('hi', false)).stop_reason).toBeNull();
    expect(JSON.parse(claudeResultLine('hi', false, 5))).toMatchObject({ type: 'result', is_error: false, usage: { output_tokens: 5 } });
  });
});
