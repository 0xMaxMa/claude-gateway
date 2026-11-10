import { taskSpeechKind, TASK_SPEECH_TIMEOUT_MS } from '../../../src/voice/task-speech';

// Pod-jinawong r14, task f3042fe1: words heard while the Notion task acted became literal commands. While a computer task
// acts, the model now declares what the words are (a structured field, never a word list: AGENTS.md).
const connection = () => ({ baseUrl: 'https://provider.test', apiKey: 'token', scheme: 'oauth' as const });
const declared = (kind: unknown, status = 200) => jest.fn(async (_url: unknown, _init?: RequestInit) => new Response(JSON.stringify({
  content: [{ type: 'tool_use', id: 't', name: 'classify', input: { kind } }], usage: { input_tokens: 210, output_tokens: 12 } }), { status }));

test.each(['stop', 'noise', 'command'] as const)('the declared kind %s is read from the classify tool call', async kind => {
  const fetch = declared(kind);
  const result = await taskSpeechKind('ไม่เอา ไม่', { model: 'claude-haiku-5-5', connection, fetch: fetch as unknown as typeof globalThis.fetch });
  expect(result).toMatchObject({ kind, outcome: 'declared', inputTokens: 210, outputTokens: 12 });
  const body = JSON.parse(String(fetch.mock.calls[0][1]!.body));
  // One forced tool call whose only field is the kind; the words are data inside <heard>.
  expect(body).toMatchObject({ model: 'claude-haiku-5-5', thinking: { type: 'disabled' }, tool_choice: { type: 'tool', name: 'classify' } });
  expect(body.tools[0].input_schema.properties.kind.enum).toEqual(['stop', 'noise', 'command']);
  expect(body.messages[0].content).toBe('<heard>\nไม่เอา ไม่\n</heard>');
  expect(body.system).toContain('When unsure whether it is a stop, choose "stop"');
});

test('without a declaration the words count as a stop (paused and read by the agent), never noise', async () => {
  for (const fetch of [declared('maybe'), declared('noise', 529), jest.fn(async () => new Response('{"content":[{"type":"text","text":"noise"}]}'))]) {
    const result = await taskSpeechKind('อืม', { model: 'claude-haiku-5-5', connection, fetch: fetch as unknown as typeof globalThis.fetch });
    expect(result).toMatchObject({ kind: 'stop', outcome: 'failed' });
  }
  const hung = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
  expect(await taskSpeechKind('uh', { model: 'claude-haiku-5-5', connection, timeoutMs: 20, fetch: hung as unknown as typeof globalThis.fetch })).toMatchObject({ kind: 'stop', outcome: 'failed', code: 'TIMEOUT' });
  expect(TASK_SPEECH_TIMEOUT_MS).toBe(3000);
});

// The two transcripts of f3042fe1, with the model mocked: what it declares is what the router acts on, and the default
// budget is the hard 3 s bound (a hung provider ends as a stop at that bound, not later).
test.each([['ไม่เอา ไม่', 'stop'], ['เอา ฝากนะ ทำไงอะ', 'command']] as const)('f3042fe1: %s declared %s', async (heard, kind) => {
  const fetch = declared(kind);
  expect(await taskSpeechKind(heard, { model: 'claude-haiku-5-5', connection, fetch: fetch as unknown as typeof globalThis.fetch })).toMatchObject({ kind, outcome: 'declared' });
  expect(JSON.parse(String(fetch.mock.calls[0][1]!.body)).messages[0].content).toBe(`<heard>\n${heard}\n</heard>`);
});
test('the default budget ends a hung call as a stop at 3 s', async () => {
  const hung = jest.fn((_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(init!.signal!.reason))));
  const started = Date.now();
  const result = await taskSpeechKind('ไม่เอา ไม่', { model: 'claude-haiku-5-5', connection, fetch: hung as unknown as typeof globalThis.fetch });
  expect(result).toMatchObject({ kind: 'stop', outcome: 'failed', code: 'TIMEOUT' });
  expect(Date.now() - started).toBeGreaterThanOrEqual(2900);expect(Date.now() - started).toBeLessThan(4500);
});

test('a model that rejects a forced tool choice is asked with auto', async () => {
  const fetch = declared('command');
  await taskSpeechKind('scroll down', { model: 'claude-opus-5-5', connection, fetch: fetch as unknown as typeof globalThis.fetch });
  expect(JSON.parse(String(fetch.mock.calls[0][1]!.body)).tool_choice).toEqual({ type: 'auto' });
});
