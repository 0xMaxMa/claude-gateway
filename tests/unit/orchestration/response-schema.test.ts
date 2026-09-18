import { EventEmitter } from 'events';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { randomUUID } from 'crypto';
import { AgentOrchestrationRuntime } from '../../../src/orchestration/runtime';
import { ORCHESTRATION_RESPONSE_SCHEMA } from '../../../src/orchestration/response-schema';
import { progressReviewResult } from '../../../src/orchestration/progress-review';
import { splitSpeechResponse, UNREADABLE_DISPLAY_NOTICE } from '../../../src/orchestration/speech';
import { displayPrefix } from '../../../src/orchestration/display-stream';
import { runtimeProfileArgs } from '../../../src/session/runtime-profile';
import { SessionStore } from '../../../src/session/store';
import { HistoryDB } from '../../../src/history/db';
import type { SessionProcess } from '../../../src/session/process';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

type Turn = 'text' | 'speech' | 'review';
const turnKind = (prompt: string): Turn => prompt.includes('This is an internal progress review') ? 'review'
  : prompt.includes('For this voice-enabled turn') ? 'speech' : 'text';

/** One session driven through all three turn shapes, capturing the exact CLI argv the
 * session process would have been launched with. `reply` chooses each turn's raw output. */
async function driveEveryTurnShape(reply: (turn: Turn) => string) {
  const root = mkdtempSync(join(tmpdir(), 'union-schema-')), dir = join(root, 'a'), workspace = join(dir, 'workspace');
  mkdirSync(workspace, { recursive: true }); writeFileSync(join(workspace, 'CLAUDE.md'), 'Identity');
  const agent = { id: 'a', description: 'fixture', env: '', workspace, claude: { model: 'fixture', extraFlags: [] }, orchestration: { enabled: true, channels: ['api'] } } as AgentConfig;
  const gateway = { gateway: { orchestration: true, headless: true }, agents: [agent] } as GatewayConfig;
  const sessions = new SessionStore(root), history = HistoryDB.forAgent(root, 'a'), sid = randomUUID();
  await sessions.ensureApiSession('a', 'chat', sid);
  const launches: { turn: Turn; argv: string[] }[] = [];
  const runtime = await AgentOrchestrationRuntime.open(agent, gateway, dir, sessions, history, {
    createAgentSession: async (_id, profile) => Object.assign(new EventEmitter(), {
      runtimeProfile: profile, start: async () => {}, stop: async () => {},
      sendMessage: function (this: EventEmitter, prompt: string) {
        const turn = turnKind(prompt);
        // Snapshot the argv at launch time: this is the byte sequence that decides whether
        // Anthropic's [tools, system, ...] prefix matches the previous turn's.
        launches.push({ turn, argv: runtimeProfileArgs(profile, []) });
        this.emit('output', JSON.stringify({ type: 'system', subtype: 'init', tools: ['StructuredOutput'] }));
        this.emit('output', JSON.stringify({ type: 'result', result: reply(turn) }));
      },
    }) as unknown as SessionProcess,
    releaseAgentSession: async () => {},
  });
  const scope = { agentId: 'a', agentSessionId: sid, source: 'api' as const, accountId: 'owner', chatId: 'chat', threadKey: '', principalId: 'owner' };
  const capabilities = { execute: false, writeMemory: false };
  const results: Partial<Record<Turn, string>> = {};
  const seen = jest.fn();
  results.text = await runtime.send({ scope, text: 'Hello' }, capabilities, { timeoutMs: 2000, onText: seen });
  results.speech = await runtime.submitInput({ scope, text: 'Voice follow-up', modality: 'live_voice', ingressKey: 'utterance:test' }, capabilities).response;
  // An internal progress review only happens for a supervised, running task.
  const input = runtime.store.acceptInput({ scope, text: 'Do the work' }), decision = runtime.decisions.begin(input.conversationId, 'owner', [input.inputId]);
  const task = runtime.tasks.spawn({ ...input, ...decision, principalId: 'owner', execute: true, writeMemory: false, actionId: 'spawn' }, { title: 'Work', instructions: 'Inspect the document', targetProfile: 'default-worker' });
  const attempt = runtime.tasks.claim(task.taskId)!;
  runtime.tasks.started(attempt.attemptId, 1, { pid: process.pid, startedAt: Date.now(), instanceId: 'fixture' });
  runtime.decisions.finish(decision, 'Working');
  const tick = Date.now() + 400000;
  runtime.tasks.observeExecution(attempt.attemptId, 1, { attemptId: attempt.attemptId, observedAt: tick, lastActivityAt: tick, lastProgressAt: tick, process: { available: true, observedAt: tick, processCount: 1 }, phase: 'tool', activeTools: ['Read'], quiet: false, status: 'process_activity' });
  const notification = runtime.store.get("SELECT id FROM notifications WHERE status='pending' ORDER BY rowid DESC LIMIT 1")!;
  results.review = await runtime.send({ scope, text: 'Internal review', storeUserMessage: false, ingressKey: 'notification:' + notification.id }, capabilities, { timeoutMs: 2000, onText: seen });
  const events = runtime.store.all("SELECT payload_json FROM conversation_events WHERE type='response.schema_unstructured'").map(row => JSON.parse(String(row.payload_json)).payload);
  const speech = runtime.store.all('SELECT text FROM response_speech').map(row => String(row.text));
  const close = async () => { await runtime.close(); (history as any).db.close(); HistoryDB.evict(root, 'a'); rmSync(root, { recursive: true, force: true }); };
  return { launches, results, events, speech, seen, runtime, close };
}

test('normal, speech and internal-review turns launch byte-identical CLI arguments', async () => {
  const session = await driveEveryTurnShape(turn => turn === 'review'
    ? JSON.stringify({ notify_user: true, display_text: 'Document checked; reviewing appendix.', spoken_text: 'Document checked.' })
    : turn === 'speech' ? JSON.stringify({ display_text: 'Hello in chat', spoken_text: 'Hello aloud' })
    : JSON.stringify({ display_text: 'Hello world' }));
  try {
    expect(session.launches.map(l => l.turn)).toEqual(['text', 'speech', 'review']);
    // --mcp-config points at this decision's own scratch directory and has always differed
    // per turn; it is a local file path, never part of the request the provider caches.
    const comparable = session.launches.map(({ argv }) => JSON.stringify(argv.map((value, index) =>
      argv[index - 1] === '--mcp-config' ? '<decision-scoped mcp.json>' : value)));
    expect(comparable[1]).toBe(comparable[0]);
    expect(comparable[2]).toBe(comparable[0]);
    // The two argv entries that actually render into the cached [tools, system] prefix,
    // compared as bytes rather than as shapes.
    const flag = (argv: string[], name: string) => argv[argv.indexOf(name) + 1];
    for (const { argv } of session.launches) {
      expect(flag(argv, '--json-schema')).toBe(JSON.stringify(ORCHESTRATION_RESPONSE_SCHEMA));
      expect(flag(argv, '--append-system-prompt')).toBe(flag(session.launches[0].argv, '--append-system-prompt'));
    }
    // Each mode is still carried by per-turn message content, below the cache breakpoint.
    expect(flag(session.launches[0].argv, '--append-system-prompt')).not.toContain('This is an internal progress review');
    expect(flag(session.launches[0].argv, '--append-system-prompt')).not.toContain('For this voice-enabled turn');
    // ~90% case: a normal turn still yields exactly the text it yielded before.
    expect(session.results.text).toBe('Hello world');
    expect(session.results.speech).toBe('Hello in chat');
    expect(session.results.review).toBe('Document checked; reviewing appendix.');
    expect(session.speech).toContain('Hello aloud');
    expect(session.events).toEqual([]);
  } finally { await session.close(); }
});

test('a plain-text answer still satisfies every turn shape without publishing raw JSON', async () => {
  // The CLI never forces tool_choice, so the model may ignore StructuredOutput entirely.
  // The tolerant parsers remain the second layer: the reply is published verbatim.
  const session = await driveEveryTurnShape(() => 'Hello world');
  try {
    expect(session.results.text).toBe('Hello world');
    expect(session.results.speech).toBe('Hello world');
    expect(session.speech).toContain('Hello world');
    // A review turn cannot read a decision out of prose, so it stays silent — but the
    // dropped update is recorded instead of disappearing (regression for the silent drop).
    expect(session.results.review).toBe('');
    // A plain-text normal turn loses nothing, so it is not recorded as an anomaly; the two
    // turns whose requested surface was actually degraded are.
    expect(session.events.map(event => event.code)).toEqual(['SPEECH_UNSTRUCTURED', 'PROGRESS_REVIEW_UNPARSED']);
  } finally { await session.close(); }
});

test('missing optional union fields degrade gracefully instead of failing the turn', async () => {
  const session = await driveEveryTurnShape(turn => turn === 'review'
    // notify_user omitted: no explicit decision, so no publication and a recorded drop.
    ? JSON.stringify({ display_text: 'Should not be published' })
    // spoken_text omitted on a speech turn: chat text survives, speech is simply absent.
    : JSON.stringify({ display_text: 'Hello world' }));
  try {
    expect(session.results.text).toBe('Hello world');
    expect(session.results.speech).toBe('Hello world');
    expect(session.speech).toEqual(['']);
    expect(session.results.review).toBe('');
    expect(session.events.map(event => event.code)).toEqual(['PROGRESS_REVIEW_UNPARSED']);
  } finally { await session.close(); }
});

test('an unreadable progress review reports why it was dropped instead of looking silent', () => {
  // Regression for the silent-drop bug: an explicit no and an unreadable answer both end
  // up silent, so the caller could not tell a deliberate quiet review from a lost update.
  expect(progressReviewResult(JSON.stringify({ notify_user: false, display_text: '', spoken_text: '' }), []))
    .toEqual({ display: '', spoken: '', silent: true, outcome: 'silent' });
  for (const raw of ['Still running', '{"notify_user":true', 'null', JSON.stringify({ display_text: 'No decision field' })])
    expect(progressReviewResult(raw, [])).toEqual({ display: '', spoken: '', silent: true, outcome: 'unparsed' });
  const report = JSON.stringify({ notify_user: true, display_text: 'Tests passed.', spoken_text: 'Tests passed.' });
  expect(progressReviewResult(report, [])).toMatchObject({ silent: false, outcome: 'reported' });
  expect(progressReviewResult(report, ['Tests passed.'])).toMatchObject({ silent: true, outcome: 'duplicate' });
  // The speech path reports the same fact: the declared schema was not honoured.
  expect(splitSpeechResponse('Plain prose')).toMatchObject({ outcome: 'plain' });
  expect(splitSpeechResponse(JSON.stringify({ display_text: 'Answer' }))).toMatchObject({ display: 'Answer', spoken: '', outcome: 'structured' });
});

test('an unusable structured payload is never published raw, on any turn kind', () => {
  // Regression: every one of these used to return `display: raw`, i.e. the model's JSON
  // object itself was the text sent to the user's chat (and offered to TTS).
  const notice = UNREADABLE_DISPLAY_NOTICE;
  // (a) the payload parsed but carried no reply.
  expect(splitSpeechResponse(JSON.stringify({ display_text: '', spoken_text: 'ignored' })))
    .toEqual({ display: notice, spoken: notice, outcome: 'empty_display' });
  expect(splitSpeechResponse(JSON.stringify({ display_text: '   ' })))
    .toMatchObject({ display: notice, outcome: 'empty_display' });
  // (b) prose appended after a complete object: the object is now read, not printed.
  expect(splitSpeechResponse(`${JSON.stringify({ display_text: 'Answer', spoken_text: 'Answer' })}\n\nLet me know if you want more.`))
    .toEqual({ display: 'Answer', spoken: 'Answer', outcome: 'structured' });
  // (c) prose before a fenced object, which the trailing-fence strip alone did not cover.
  expect(splitSpeechResponse('Sure, here you go:\n\n```json\n{"display_text":"Answer"}\n```\n\nAnything else?'))
    .toEqual({ display: 'Answer', spoken: '', outcome: 'structured' });
  // (d) truncated JSON: the surrounding prose survives, the fragment does not.
  expect(splitSpeechResponse('Checking that now.\n{"display_text":"Half of the ans'))
    .toEqual({ display: 'Checking that now.', spoken: 'Checking that now.', outcome: 'unreadable' });
  expect(splitSpeechResponse('{"display_text":"Half of the ans'))
    .toEqual({ display: notice, spoken: notice, outcome: 'unreadable' });
  for (const raw of ['{"display_text":"", "spoken_text":""}', '{"display_tex', '{"display_text":"x"} tail', 'lead {"display_text":', '```json\n{"display_text":\n```'])
    expect(splitSpeechResponse(raw).display).not.toMatch(/display_text/);
  // A reply that legitimately contains JSON the user asked for is not a payload and is
  // still published untouched.
  const json = '```json\n{"port":8080,"host":"localhost"}\n```';
  expect(splitSpeechResponse(json)).toEqual({ display: json, spoken: '', outcome: 'plain' });
  // Neither is a reply that quotes the payload format and then keeps explaining it: the
  // object is an example inside the answer, so the answer must survive verbatim.
  const explained = 'The agent answers with {"display_text":"hi"} and the gateway unwraps it, '
    + 'which is why the JSON never reaches your chat window. The same object carries spoken_text '
    + 'on a voice turn, and the dashboard stores only the unwrapped text for history.';
  expect(splitSpeechResponse(explained)).toEqual({ display: explained, spoken: '', outcome: 'plain' });
});

test('a partially streamed payload is withheld whether or not it opens the turn', () => {
  // The streaming layer is the other half of the same leak: raw JSON must not be published
  // chunk by chunk either, including when the model emits prose before its object.
  const payload = '{"display_text":"Answer","spoken_text":"Answer"}';
  for (let i = 1; i <= payload.length; i++) expect(displayPrefix(`Working on it.\n${payload.slice(0, i)}`)).toBe('Working on it.\n');
  for (let i = 1; i <= payload.length; i++) expect(displayPrefix(payload.slice(0, i))).not.toMatch(/display_text|\{/);
  expect(displayPrefix('Here you go:\n```json\n{"display_text":"A"}')).toBe('Here you go:\n');
  // Ordinary prose, including fenced code and braces mid-answer, still streams unchanged.
  expect(displayPrefix('Use `npm run build`; the config is {"port":8080} in config.json.')).toBe('Use `npm run build`; the config is {"port":8080} in config.json.');
  expect(displayPrefix('Here is the fix:\n```ts\nif (x) { return 1; }\n```\n')).toBe('Here is the fix:\n```ts\nif (x) { return 1; }\n```\n');
});

test('an ordinary turn whose payload cannot be read records the failure instead of dropping it', async () => {  // The no-silent-failures regression: before this, only internal review turns reported an
  // unusable payload, so an ordinary chat turn lost its reply without a single trace.
  const session = await driveEveryTurnShape(() => JSON.stringify({ display_text: '', spoken_text: 'ignored' }));
  try {
    expect(session.events.map(event => [event.turn, event.code])).toEqual([
      ['text', 'RESPONSE_DISPLAY_EMPTY'], ['speech', 'RESPONSE_DISPLAY_EMPTY'], ['review', 'PROGRESS_REVIEW_UNPARSED'],
    ]);
    expect(session.results.text).toBe(UNREADABLE_DISPLAY_NOTICE);
    expect(session.results.text).not.toMatch(/display_text/);
    expect(session.results.speech).toBe(UNREADABLE_DISPLAY_NOTICE);
    expect(session.results.review).toBe('');
    for (const text of session.speech) expect(text).not.toMatch(/display_text/);
    for (const call of session.seen.mock.calls) expect(String(call[0])).not.toMatch(/display_text/);
  } finally { await session.close(); }
});

test('an answer that quotes the payload format is delivered unchanged and raises nothing', async () => {
  // The false-positive direction of the same guard: explaining the schema in a reply must not
  // be unwrapped, stripped, replaced by the notice, or recorded as a schema violation.
  const explained = 'The agent answers with {"display_text":"hi"} and the gateway unwraps it, '
    + 'so the JSON never reaches your chat. Here is the shape:\n\n```json\n{"display_text":"hi"}\n```\n\n'
    + 'On a voice turn the same object also carries spoken_text, and the dashboard stores only '
    + 'the unwrapped text, which is why history never shows an object either.';
  const session = await driveEveryTurnShape(() => explained);
  try {
    expect(session.results.text).toBe(explained);
    // Only the speech and review surfaces are genuinely missing; the ordinary turn is intact.
    expect(session.events.map(event => [event.turn, event.code])).toEqual([
      ['speech', 'SPEECH_UNSTRUCTURED'], ['review', 'PROGRESS_REVIEW_UNPARSED'],
    ]);
  } finally { await session.close(); }
});
