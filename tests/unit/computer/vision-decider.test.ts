import {
  COMPUTER_TOOLSET, axHints, chordKeys, mapComputerCall, rawCapabilities, runVisionComputerUse, supportsComputerToolset, visionModelDecider, visionRequestBody,
  type RawCapabilities, type VisionDependencies, type VisionScreenshot, type VisionTurn,
} from '../../../src/automation/vision-decider';
import { modelRequestBody, rejectsForcedToolChoice, validateComputerUseConfig } from '../../../src/automation/model-choice-evaluator';

const CAPS_RAW = { pointer: ['click', 'double_click', 'right_click', 'move', 'drag'], pointerModifiers: ['alt', 'cmd', 'ctrl', 'shift'], scrollAt: true, keyChord: true, typeFocused: true, screenshotGeometry: true };
const caps = rawCapabilities({ capabilities: CAPS_RAW })!;
const shot: VisionScreenshot = { generation: 'g1', data: '/9j/AAAA', width: 1280, height: 800 };
const TOKEN = 'sk-test-not-a-real-token-123';

describe('raw capabilities', () => {
  test('need screenshot-bound pointer input', () => {
    expect(caps.pointer.has('drag')).toBe(true);
    expect(rawCapabilities({ capabilities: { ...CAPS_RAW, screenshotGeometry: false } })).toBeUndefined();
    expect(rawCapabilities({ capabilities: { standardCommands: ['scroll:up'], keys: ['enter'] } })).toBeUndefined();
    expect(rawCapabilities({})).toBeUndefined();
  });
});

describe('action mapping', () => {
  test.each([
    ['left_click', { coordinate: [10, 20] }, { kind: 'pointer', op: 'click', x: 10, y: 20 }],
    ['double_click', { coordinate: [10.4, 20.6] }, { kind: 'pointer', op: 'double_click', x: 10, y: 21 }],
    ['right_click', { coordinate: [1, 2] }, { kind: 'pointer', op: 'right_click', x: 1, y: 2 }],
    ['mouse_move', { coordinate: [5, 6] }, { kind: 'pointer', op: 'move', x: 5, y: 6 }],
    ['left_click', { coordinate: [10, 20], text: 'cmd+shift' }, { kind: 'pointer', op: 'click', x: 10, y: 20, modifiers: ['cmd', 'shift'] }],
    ['left_click', { coordinate: [10, 20], text: 'super' }, { kind: 'pointer', op: 'click', x: 10, y: 20, modifiers: ['cmd'] }],
    ['left_click_drag', { start_coordinate: [1, 2], coordinate: [30, 40] }, { kind: 'pointer', op: 'drag', x: 1, y: 2, to_x: 30, to_y: 40 }],
    ['scroll', { coordinate: [100, 200], scroll_direction: 'down', scroll_amount: 5 }, { kind: 'scroll', x: 100, y: 200, dy: 5 }],
    ['scroll', { coordinate: [100, 200], scroll_direction: 'up', scroll_amount: 99 }, { kind: 'scroll', x: 100, y: 200, dy: -50 }],
    ['scroll', { scroll_direction: 'left', scroll_amount: 2 }, { kind: 'scroll', x: 640, y: 400, dx: -2 }],
    ['key', { text: 'Return' }, { kind: 'key_chord', keys: ['enter'] }],
    ['key', { text: 'ctrl+l' }, { kind: 'key_chord', keys: ['ctrl', 'l'] }],
    ['key', { text: 'super+shift+t' }, { kind: 'key_chord', keys: ['cmd', 'shift', 't'] }],
    ['key', { text: 'Page_Down' }, { kind: 'key_chord', keys: ['pagedown'] }],
    ['type', { text: 'lofi hip hop' }, { kind: 'type_focused', text: 'lofi hip hop' }],
  ])('%s %j', (name, input, action) => {
    expect(mapComputerCall(name, input, caps, shot)).toEqual({ action });
  });

  test.each([
    ['left_click', { coordinate: [1280, 10] }, 'COORDINATE_OUTSIDE_SCREENSHOT'],
    ['left_click', { coordinate: [-1, 10] }, 'COORDINATE_OUTSIDE_SCREENSHOT'],
    ['left_click', {}, 'COORDINATE_OUTSIDE_SCREENSHOT'],
    ['left_click', { coordinate: [1, 1], text: 'fn' }, 'MODIFIER_NOT_SUPPORTED'],
    ['left_click_drag', { start_coordinate: [1, 2], coordinate: [3, 900] }, 'COORDINATE_OUTSIDE_SCREENSHOT'],
    ['key', { text: 'F5' }, 'KEY_NOT_SUPPORTED'],
    ['key', { text: 'Return', repeat: 3 }, 'REPEAT_NOT_SUPPORTED'],
    ['type', { text: 'x'.repeat(2001) }, 'TEXT_TOO_LONG'],
    ['scroll', { scroll_direction: 'sideways' }, 'INVALID_INPUT'],
    ['triple_click', { coordinate: [1, 1] }, 'ACTION_NOT_SUPPORTED'],
    ['zoom', { region: [0, 0, 10, 10] }, 'ACTION_NOT_SUPPORTED'],
  ])('%s %j is refused with %s', (name, input, error) => {
    expect(mapComputerCall(name, input, caps, shot)).toEqual({ error });
  });

  test('every kind is gated on its own capability', () => {
    const none: RawCapabilities = { pointer: new Set(['click']), modifiers: new Set(), scrollAt: false, keyChord: false, typeFocused: false };
    expect(mapComputerCall('left_click', { coordinate: [1, 1] }, none, shot)).toEqual({ action: { kind: 'pointer', op: 'click', x: 1, y: 1 } });
    for (const [name, input] of [['double_click', { coordinate: [1, 1] }], ['left_click_drag', { start_coordinate: [1, 1], coordinate: [2, 2] }], ['scroll', { scroll_direction: 'down' }], ['key', { text: 'Return' }], ['type', { text: 'a' }]] as const)
      expect(mapComputerCall(name, input, none, shot)).toEqual({ error: 'ACTION_NOT_SUPPORTED' });
    expect(mapComputerCall('left_click', { coordinate: [1, 1], text: 'cmd' }, none, shot)).toEqual({ error: 'MODIFIER_NOT_SUPPORTED' });
  });

  test('screenshot and wait are control steps, not actions', () => {
    expect(mapComputerCall('screenshot', {}, caps, shot)).toEqual({ screenshot: true });
    expect(mapComputerCall('wait', { duration: 60 }, caps, shot)).toEqual({ wait: 5 });
  });

  test('chord keys put modifiers first and reject two base keys', () => {
    expect(chordKeys('A')).toEqual(['shift', 'a']);
    expect(chordKeys('cmd+a+b')).toBeUndefined();
    expect(chordKeys('shift')).toBeUndefined();
  });
});

describe('hybrid hints', () => {
  test('Accessibility bounds become screenshot pixel boxes; sensitive labels are dropped', () => {
    const state: any = { controls: [
      { ref: 'a', role: 'AXTextField', label: 'Search', bounds: { x: 0.25, y: 0.1, width: 0.5, height: 0.05 }, actions: ['type'] },
      { ref: 'b', role: 'AXSecureTextField', label: 'Password', sensitive: true, bounds: { x: 0, y: 0, width: 0.1, height: 0.1 }, actions: ['type'] },
      { ref: 'c', role: 'AXButton', label: 'No bounds', actions: ['press'] },
    ] };
    expect(axHints(state, 1280, 800)).toEqual([
      { role: 'AXTextField', label: 'Search', box: [320, 80, 960, 120] },
      { role: 'AXSecureTextField', box: [0, 0, 128, 80] },
    ]);
  });
});

describe('request shape', () => {
  test('no temperature, no forced tool_choice, the GA toolset entry and a finish tool', () => {
    for (const model of ['claude-sonnet-5', 'claude-opus-5-5']) {
      const body = visionRequestBody(model, []) as any;
      expect(body).not.toHaveProperty('temperature');
      expect(body.tool_choice).toEqual({ type: 'auto', disable_parallel_tool_use: true });
      expect(body.tools[0]).toMatchObject({ type: COMPUTER_TOOLSET, configs: { zoom: { enabled: false }, left_mouse_down: { enabled: false } } });
      expect(body.tools[0]).not.toHaveProperty('name');
      expect(body.tools[1].name).toBe('finish');
    }
  });

  test('toolset support excludes Haiku', () => {
    expect(supportsComputerToolset('claude-sonnet-5')).toBe(true);
    expect(supportsComputerToolset('claude-opus-5-5')).toBe(true);
    expect(supportsComputerToolset('claude-haiku-4-5-20251001')).toBe(false);
  });

  test('the decider posts through the agent route without an anthropic-beta header and returns the raw content', async () => {
    const sent: any[] = [];
    const fetch = (async (url: URL, init: RequestInit) => {
      sent.push({ url: String(url), headers: init.headers, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'u1', name: 'screenshot', input: {}, toolset_name: 'computer' }], usage: { input_tokens: 10, output_tokens: 2 } }), { headers: { 'content-type': 'application/json' } });
    }) as unknown as typeof globalThis.fetch;
    const events: any[] = [];
    const decide = visionModelDecider({ model: 'claude-sonnet-5', timeoutMs: 2000, fetch, authorize: () => true, onDecision: e => events.push(e),
      connection: async () => ({ baseUrl: 'https://proxy.example.test', apiKey: TOKEN, scheme: 'bearer' }) });
    const turn = await decide([{ role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: '/9j/AAAA' } }] }], new AbortController().signal);
    expect(turn.content[0]).toMatchObject({ name: 'screenshot', toolset_name: 'computer' });
    expect(sent[0].url).toBe('https://proxy.example.test/v1/messages');
    expect(Object.keys(sent[0].headers).map(h => h.toLowerCase())).not.toContain('anthropic-beta');
    expect(sent[0].body.messages[0].content[0].type).toBe('image');
    expect(events[0]).toMatchObject({ outcome: 'completed', images: 1, usage: { input_tokens: 10, output_tokens: 2 } });
    expect(JSON.stringify(events)).not.toContain(TOKEN);
  });
});

describe('shared evaluator', () => {
  const request: any = { requestId: 'r', state: {}, questions: { action: { type: 'choice', instructions: 'pick', criteria: { '0': 'a', '1': 'b' } } } };
  test('a model that rejects forced tool_choice gets auto with room to think', () => {
    expect(rejectsForcedToolChoice('claude-opus-5-5')).toBe(true);
    const body = modelRequestBody(request, 'claude-opus-5-5') as any;
    expect(body.tool_choice).toEqual({ type: 'auto' });
    expect(body.max_tokens).toBe(4096);
    expect(body.output_config).toEqual({ effort: 'low' });
  });
  test.each(['claude-haiku-4-5-20251001', 'claude-sonnet-5', 'claude-opus-5'])('%s keeps the forced answer tool', model => {
    const body = modelRequestBody(request, model) as any;
    expect(body.tool_choice).toEqual({ type: 'tool', name: 'answer' });
    expect(body).not.toHaveProperty('output_config');
  });
});

describe('config', () => {
  test('mode and visionModel are validated', () => {
    expect(() => validateComputerUseConfig({ enabled: true, mode: 'vision', visionModel: 'claude-sonnet-5' })).not.toThrow();
    expect(() => validateComputerUseConfig({ mode: 'hybrid' })).not.toThrow();
    expect(() => validateComputerUseConfig({ mode: 'pixels' })).toThrow('mode');
    expect(() => validateComputerUseConfig({ visionModel: '' })).toThrow('visionModel');
  });
});

/** A fake Mac: each observe returns a new generation; actions return queued receipts. */
function device(options: { caps?: unknown; receipts?: Array<Record<string, unknown> | Error>; shotError?: string } = {}) {
  let generation = 0;
  const calls: Array<{ name: string; args: any }> = [], receipts = [...(options.receipts ?? [])];
  const state = (g: number) => ({ generation: 'g' + g, application: 'com.google.Chrome', windowTitle: 'YouTube', controls: [{ ref: 'r1', role: 'AXTextField', label: 'Search', bounds: { x: 0.25, y: 0.1, width: 0.5, height: 0.05 }, actions: ['type'] }], apps: [], truncated: false, screenshotAvailable: true,
    ...(options.caps === null ? {} : { capabilities: options.caps ?? CAPS_RAW }) });
  const deps = (decide: VisionDependencies['decide'], mode: 'vision' | 'hybrid' = 'vision'): VisionDependencies => ({
    mode, decide, authorized: () => true, beforeMutation: jest.fn(),
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'computer_acquire') return { lease_token: 'lease' };
      if (name === 'computer_observe') return state(++generation);
      if (name === 'computer_action') { const next = receipts.shift() ?? { state: 'completed' }; if (next instanceof Error) throw next; return next; }
      if (name === 'computer_operation_status') return { operation_id: args.operation_id, state: 'unknown' };
      return {};
    },
    screenshot: async s => options.shotError ? { error: options.shotError } : { generation: s.generation, data: '/9j/' + s.generation, width: 1280, height: 800 },
  });
  return { calls, deps, actions: () => calls.filter(c => c.name === 'computer_action').map(c => c.args), released: () => calls.some(c => c.name === 'computer_release') };
}
/** A scripted model: one tool_use per turn; records every request. */
function model(script: Array<{ name: string; input?: unknown; toolset?: boolean } | 'text'>) {
  const seen: unknown[][] = [];
  let n = 0;
  const decide = async (messages: unknown[]): Promise<VisionTurn> => {
    seen.push(structuredClone(messages));
    const step = script[n++];
    if (!step) throw Error('script exhausted');
    if (step === 'text') return { content: [{ type: 'text', text: 'Thinking out loud.' }], stopReason: 'end_turn' };
    return { content: [{ type: 'tool_use', id: 'u' + n, name: step.name, input: step.input ?? {}, ...(step.toolset === false ? {} : { toolset_name: 'computer' }) }], stopReason: 'tool_use' };
  };
  return { decide, seen };
}
const finish = (outcome: 'done' | 'blocked', blocker?: string) => ({ name: 'finish', input: { outcome, ...(blocker ? { blocker } : {}) }, toolset: false });
const signal = () => new AbortController().signal;
const lastUser = (messages: any[]) => messages[messages.length - 1];

describe('vision loop', () => {
  test('YouTube search and play: actions are bound to the generation the model saw, then the goal is reached', async () => {
    const d = device(), m = model([
      { name: 'left_click', input: { coordinate: [640, 100] } }, { name: 'type', input: { text: 'lofi hip hop' } }, { name: 'key', input: { text: 'Return' } },
      { name: 'left_click', input: { coordinate: [300, 400] } }, finish('done'),
    ]);
    const result = await runVisionComputerUse({ goal: 'search YouTube for lofi hip hop and play the first video', maxSteps: 8 }, d.deps(m.decide), signal()) as any;
    expect(result).toMatchObject({ status: 'succeeded', reason: 'GOAL_REACHED', steps: 4, evaluations: 5 });
    expect(d.actions().map(({ operation_id, ...a }) => a)).toEqual([
      { lease_token: 'lease', kind: 'pointer', op: 'click', x: 640, y: 100, generation: 'g1' },
      { lease_token: 'lease', kind: 'type_focused', text: 'lofi hip hop', generation: 'g2' },
      { lease_token: 'lease', kind: 'key_chord', keys: ['enter'], generation: 'g3' },
      { lease_token: 'lease', kind: 'pointer', op: 'click', x: 300, y: 400, generation: 'g4' },
    ]);
    // Each tool_result echoes the toolset and carries the next generation's screenshot.
    const reply = lastUser(m.seen[1]).content[0];
    expect(reply).toMatchObject({ type: 'tool_result', tool_use_id: 'u1', toolset_name: 'computer' });
    expect(reply.content.find((b: any) => b.type === 'image').source.data).toBe('/9j/g2');
    // Typed text is never kept in the result.
    expect(JSON.stringify(result.lastAction)).not.toContain('lofi');
    expect(d.released()).toBe(true);
    // Append-only history: every request extends the previous one unchanged.
    for (let i = 1; i < m.seen.length; i++) expect(m.seen[i].slice(0, m.seen[i - 1].length)).toEqual(m.seen[i - 1]);
  });

  test.each(['STALE_OBSERVATION', 'TARGET_OCCLUDED'])('%s re-observes and lets the model decide on the new screenshot', async error => {
    const d = device({ receipts: [{ state: 'not_executed', error }] }), m = model([{ name: 'left_click', input: { coordinate: [10, 10] } }, { name: 'left_click', input: { coordinate: [20, 20] } }, finish('done')]);
    const result = await runVisionComputerUse({ goal: 'click it' }, d.deps(m.decide), signal()) as any;
    expect(result).toMatchObject({ status: 'succeeded', reason: 'GOAL_REACHED', steps: 1 });
    expect(d.actions().map(a => a.generation)).toEqual(['g1', 'g2']);
    const reply = lastUser(m.seen[1]).content[0];
    expect(reply).toMatchObject({ is_error: true, toolset_name: 'computer' });
    expect(reply.content[0].text).toContain(error);
  });

  test('repeated refusals end the run instead of looping', async () => {
    const stale = { state: 'not_executed', error: 'STALE_OBSERVATION' };
    const d = device({ receipts: [stale, stale, stale] }), m = model([1, 2, 3].map(() => ({ name: 'left_click', input: { coordinate: [10, 10] } })));
    const result = await runVisionComputerUse({ goal: 'click it' }, d.deps(m.decide), signal()) as any;
    expect(result).toMatchObject({ status: 'blocked', reason: 'STALE_OBSERVATION', steps: 0 });
  });

  test('an out-of-screenshot coordinate is answered, not dispatched', async () => {
    const d = device(), m = model([{ name: 'left_click', input: { coordinate: [5000, 10] } }, { name: 'left_click', input: { coordinate: [10, 10] } }, finish('done')]);
    await runVisionComputerUse({ goal: 'click it' }, d.deps(m.decide), signal());
    expect(d.actions()).toHaveLength(1);
    expect(lastUser(m.seen[1]).content[0]).toMatchObject({ is_error: true, content: expect.stringContaining('COORDINATE_OUTSIDE_SCREENSHOT') });
  });

  test('missing raw capabilities fall back to Accessibility before anything runs', async () => {
    const d = device({ caps: null }), m = model([]);
    const result = await runVisionComputerUse({ goal: 'click it' }, d.deps(m.decide), signal());
    expect(result).toMatchObject({ fallback: 'RAW_CAPABILITIES_MISSING' });
    expect(m.seen).toHaveLength(0);expect(d.actions()).toHaveLength(0);expect(d.released()).toBe(true);
  });

  test('raw input turned off on the Mac falls back before the first action, and blocks after it', async () => {
    const off = { state: 'not_executed', error: 'RAW_INPUT_DISABLED' };
    const first = device({ receipts: [off] });
    expect(await runVisionComputerUse({ goal: 'x' }, first.deps(model([{ name: 'left_click', input: { coordinate: [1, 1] } }]).decide), signal())).toMatchObject({ fallback: 'RAW_INPUT_DISABLED' });
    const later = device({ receipts: [{ state: 'completed' }, off] });
    expect(await runVisionComputerUse({ goal: 'x' }, later.deps(model([1, 2].map(() => ({ name: 'left_click', input: { coordinate: [1, 1] } }))).decide), signal())).toMatchObject({ status: 'blocked', reason: 'RAW_INPUT_DISABLED', steps: 1 });
  });

  test('an unknown receipt is reconciled, never replayed', async () => {
    const d = device({ receipts: [Error('NETWORK')] }), m = model([{ name: 'left_click', input: { coordinate: [1, 1] } }]);
    const result = await runVisionComputerUse({ goal: 'x' }, d.deps(m.decide), signal()) as any;
    expect(result).toMatchObject({ status: 'needs_reconciliation', reason: 'OUTCOME_UNKNOWN' });
    expect(result.operationId).toBe(d.actions()[0].operation_id);
    expect(d.actions()).toHaveLength(1);
    expect(d.calls.filter(c => c.name === 'computer_operation_status')).toHaveLength(3);
  });

  test('step limit, no decision, blocked finish and done before any action', async () => {
    const click = { name: 'left_click', input: { coordinate: [1, 1] } };
    expect(await runVisionComputerUse({ goal: 'x', maxSteps: 2 }, device().deps(model([click, click]).decide), signal())).toMatchObject({ status: 'blocked', reason: 'STEP_LIMIT', steps: 2 });
    expect(await runVisionComputerUse({ goal: 'x' }, device().deps(model(['text', 'text']).decide), signal())).toMatchObject({ status: 'blocked', reason: 'VISION_NO_DECISION' });
    expect(await runVisionComputerUse({ goal: 'x' }, device().deps(model([finish('blocked', 'HIGH_IMPACT_ACTION')]).decide), signal())).toMatchObject({ status: 'blocked', reason: 'VISION_HIGH_IMPACT_ACTION' });
    expect(await runVisionComputerUse({ goal: 'x' }, device().deps(model([finish('done')]).decide), signal())).toMatchObject({ status: 'needs_verification', reason: 'COMPLETION_CANDIDATE' });
  });

  test('hybrid mode adds Accessibility boxes to the state; vision does not', async () => {
    const hybrid = model([finish('done')]), vision = model([finish('done')]);
    await runVisionComputerUse({ goal: 'x' }, device().deps(hybrid.decide, 'hybrid'), signal());
    await runVisionComputerUse({ goal: 'x' }, device().deps(vision.decide, 'vision'), signal());
    const text = (seen: unknown[][]) => (seen[0][0] as any).content[1].text as string;
    expect(text(hybrid.seen)).toContain('"box":[320,80,960,120]');
    expect(text(vision.seen)).not.toContain('"elements"');
  });

  test('a screenshot that cannot be taken falls back to Accessibility', async () => {
    const d = device({ shotError: 'SCREEN_RECORDING_PERMISSION_REQUIRED' });
    expect(await runVisionComputerUse({ goal: 'x' }, d.deps(model([]).decide), signal())).toMatchObject({ fallback: 'SCREEN_RECORDING_PERMISSION_REQUIRED' });
  });
});
