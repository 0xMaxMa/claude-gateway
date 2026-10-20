import sharp from 'sharp';
import { runVisionComputerUse, type VisionDependencies } from '../../../src/automation/vision-decider';
import { jevVisionDecider, scrollUnits } from '../../../src/automation/jev-vision-decider';
import { validateJevRequest } from '../../../src/jev/validation';
import type { JevConfig, JevRequest, JevResult } from '../../../src/jev/types';

const CAPS = { pointer: ['click', 'double_click', 'right_click', 'move', 'drag'], pointerModifiers: ['alt', 'cmd', 'ctrl', 'shift'], scrollAt: true, keyChord: true, typeFocused: true, screenshotGeometry: true };
const IMAGES: JevConfig = { enabled: true, provider: 'typesafe', model: 'jev-1.13.0', images: { enabled: true } };
const SAVE = { ref: 'r1', role: 'AXButton', label: 'Save', bounds: { x: 0.1, y: 0.1, width: 0.1, height: 0.05 }, actions: ['press'] };
const NAME = { ref: 'r2', role: 'AXTextField', label: 'Name', value: 'old', bounds: { x: 0.3, y: 0.3, width: 0.3, height: 0.05 }, actions: ['type'] };
const PASSWORD = { ref: 'pw', role: 'AXSecureTextField', label: 'Password', sensitive: true, bounds: { x: 0.3, y: 0.5, width: 0.3, height: 0.05 }, actions: ['type'] };
let jpeg: string;
beforeAll(async () => { jpeg = (await sharp({ create: { width: 1280, height: 800, channels: 3, background: '#fff' } }).jpeg().toBuffer()).toString('base64'); });

/** A fake Mac: every observe is a new generation; `text` grows with each completed action, so actions change the screen. */
function device(options: { controls?: unknown[]; apps?: Array<{ id: string; name: string }>; receipts?: Array<Record<string, unknown>>; impact?: (command: string) => 'ROUTINE' | 'HIGH_IMPACT'; distribution?: Record<string, number> } = {}) {
  let generation = 0, done = 0;
  const calls: Array<{ name: string; args: any }> = [], receipts = [...(options.receipts ?? [])];
  const deps = (decide: VisionDependencies['decide'], mode: 'vision' | 'hybrid' = 'hybrid'): VisionDependencies => ({
    mode, decide, authorized: () => true, beforeMutation: jest.fn(),
    evaluate: async request => {
      const choice = options.impact?.((request.questions.impact.instructions as any).command) ?? 'ROUTINE';
      return { answers: { impact: { choice, confidence: 0.9, probabilities: options.distribution ?? (choice === 'ROUTINE' ? { ROUTINE: 0.9, HIGH_IMPACT: 0.1 } : { ROUTINE: 0.1, HIGH_IMPACT: 0.9 }) } } };
    },
    call: async (name, args) => {
      calls.push({ name, args });
      if (name === 'computer_acquire') return { lease_token: 'lease' };
      if (name === 'computer_observe') return { generation: 'g' + ++generation, application: 'com.apple.TextEdit', windowTitle: 'Doc', controls: options.controls ?? [SAVE, NAME, PASSWORD], text: [`actions ${done}`], apps: options.apps ?? [], truncated: false, screenshotAvailable: true, observationStats: { visited: 3, candidates: 3, exported: 3, incomplete: false }, capabilities: CAPS };
      if (name === 'computer_action') { const receipt = receipts.shift() ?? { state: 'completed' }; if (receipt.state === 'completed') done++; return receipt; }
      return {};
    },
    screenshot: async s => ({ generation: s.generation, data: jpeg, width: 1280, height: 800 }),
  });
  return { deps, calls, actions: () => calls.filter(c => c.name === 'computer_action').map(c => { const { generation: _g, operation_id: _o, lease_token: _l, ...action } = c.args; return action; }) };
}

/** A scripted Jev: every request must pass the real validator; each question gets the scripted answer or a neutral one. */
function jev(steps: Array<Record<string, unknown>>, extra: { refine?: Record<string, unknown>; dot?: number; again?: number } = {}) {
  const requests: JevRequest[] = [];
  const evaluate = async (request: JevRequest): Promise<JevResult> => {
    validateJevRequest(request, IMAGES);
    requests.push(request);
    const script = 'op' in request.questions ? steps.shift() ?? { done: 0.9 } : 'target' in request.questions ? extra.refine ?? {} : {};
    const answers: JevResult['answers'] = {};
    for (const [id, q] of Object.entries(request.questions)) {
      const given = script[id];
      if (q.type === 'noul') answers[id] = { type: 'noul', noul: typeof given === 'number' ? given : id === 'hit' ? extra.dot ?? 0.9 : id === 'again' ? extra.again ?? 0.1 : id === 'done' ? 0 : 0.9 };
      else if (q.type === 'box') answers[id] = { type: 'box', box: (given as any) ?? { top: 0.45, bottom: 0.55, left: 0.45, right: 0.55 }, confidence: 0.9 };
      else if (q.type === 'choice') { const choice = typeof given === 'string' ? given : Object.keys(q.criteria)[0]; answers[id] = { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(Object.keys(q.criteria).map(k => [k, k === choice ? 1 : 0])) }; }
    }
    return { requestId: 'r', requestedModel: 'jev-1.14.0', model: 'jev-1.14.0', answers, usage: { input_tokens: 1, output_tokens: 1 } };
  };
  return { evaluate, requests, steps: () => requests.filter(r => 'op' in r.questions) };
}
const signal = () => new AbortController().signal;
const decider = (j: ReturnType<typeof jev>, mode: 'vision' | 'hybrid' = 'hybrid') => jevVisionDecider({ mode, evaluate: j.evaluate });
const pixel = async (request: JevRequest, x: number, y: number) => {
  const image = Buffer.from(Object.values(request.assets!)[0].data_base64, 'base64'), { width } = await sharp(image).metadata();
  const scale = width! / 1280;
  return [...await sharp(image).extract({ left: Math.round(x * scale), top: Math.round(y * scale), width: 1, height: 1 }).raw().toBuffer()];
};

describe('Jev image decisions in the vision loop', () => {
  test('opens an approved application selected from the screenshot decision and app catalogue', async () => {
    const d = device({ apps: [{ id: 'com.apple.Maps', name: 'Maps' }] }), j = jev([{ op: 'OPEN', app: 'com.apple.Maps' }, { done: 0.9 }]);
    await runVisionComputerUse({ goal: 'Open Maps' }, d.deps(decider(j)), signal());
    expect(j.steps()[0].state).toMatchObject({ applications: [{ id: 'com.apple.Maps', name: 'Maps' }] });
    expect((j.steps()[0].questions.app as any).criteria['com.apple.Maps']).toContain('Maps');
    expect(d.actions()).toEqual([{ kind: 'open', app_id: 'com.apple.Maps' }]);
  });

  test('clicks a Set-of-Mark control at its center, then finishes when Jev sees the goal done', async () => {
    const d = device(), j = jev([{ op: 'CLICK', element: '1' }, { done: 0.9 }]);
    const result = await runVisionComputerUse({ goal: 'Click Save' }, d.deps(decider(j)), signal());
    expect(result).toMatchObject({ status: 'succeeded', reason: 'GOAL_REACHED', steps: 1 });
    expect(d.actions()).toEqual([{ kind: 'pointer', op: 'click', x: 192, y: 100 }]);
    // Sensitive controls are neither listed nor marked.
    expect(Object.keys((j.steps()[0].questions.element as any).criteria).sort()).toEqual(['1', '2', 'NONE']);
    expect(j.steps()[1].state).toMatchObject({ previous_steps: ['clicked "Save" (AXButton)'] });
  });

  test('paints sensitive controls out of the screenshot before it is sent', async () => {
    const d = device(), j = jev([{ done: 0.9 }]);
    await runVisionComputerUse({ goal: 'x' }, d.deps(decider(j)), signal());
    expect(await pixel(j.steps()[0], 576, 420)).toEqual([0, 0, 0]);
    expect((await pixel(j.steps()[0], 576, 600)).every(v => v > 200)).toBe(true);
  });

  test('sends no screenshot when a sensitive control cannot be located: that step is decided on the control list', async () => {
    const d = device({ controls: [SAVE, { ...PASSWORD, bounds: undefined }] }), j = jev([{ op: 'CLICK', element: '1' }, { done: 0.9 }]);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, d.deps(decider(j)), signal())).toMatchObject({ status: 'succeeded', steps: 1 });
    expect(j.requests.every(r => r.assets === undefined)).toBe(true);
    expect(j.steps()[0].state).toMatchObject({ screen: { application: 'com.apple.TextEdit', screenshot: expect.stringContaining('withheld') } });
    expect(Object.keys(j.steps()[0].questions)).not.toContain('target');
    expect(d.actions()).toEqual([{ kind: 'pointer', op: 'click', x: 192, y: 100 }]);
  });

  // The helper sets screenshotAvailable only after the sensitive-content scan is complete. `truncated` also covers
  // harmless output caps, so it must not hide a safe screenshot from Jev.
  test('a safe screenshot remains available when only the exported observation is truncated', async () => {
    const d = device(), j = jev([{ op: 'CLICK', element: '1' }, { done: 0.9 }]);
    const deps = d.deps(decider(j, 'vision')), call = deps.call;
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), truncated: true, screenshotAvailable: true,
      observationStats: { visited: 200, candidates: 200, exported: 32, incomplete: false } } : call(name, args, s);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, deps, signal())).toMatchObject({ status: 'succeeded', steps: 1 });
    expect(j.requests[0].assets).toBeDefined();
    expect((j.steps()[0].state as any).screen).toBeDefined();
  });

  test('an unfinished sensitive-content scan still withholds the screenshot', async () => {
    const d = device(), j = jev([{ op: 'CLICK', element: '1' }, { done: 0.9 }]);
    const deps = d.deps(decider(j, 'vision')), call = deps.call;
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), truncated: true, screenshotAvailable: false,
      observationStats: { visited: 150, candidates: 80, exported: 32, incomplete: true } } : call(name, args, s);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, deps, signal())).toMatchObject({ status: 'succeeded', steps: 1 });
    expect(j.requests.every(r => r.assets === undefined)).toBe(true);
    expect((j.steps()[0].state as any).screen).toMatchObject({ screenshot: expect.stringContaining('withheld') });
  });

  test('types by clicking the field, selecting its text and typing, one action per completed step', async () => {
    const d = device(), j = jev([{ op: 'TYPE', element: '2', text: 'TEXT:0' }, { done: 0.9 }]);
    expect(await runVisionComputerUse({ goal: 'Type "Somchai" into Name' }, d.deps(decider(j)), signal())).toMatchObject({ status: 'succeeded', steps: 3 });
    expect(d.actions()).toEqual([{ kind: 'pointer', op: 'click', x: 576, y: 260 }, { kind: 'key_chord', keys: ['cmd', 'a'] }, { kind: 'type_focused', text: 'Somchai' }]);
    expect(j.steps()).toHaveLength(2);
  });

  test('a run that returns control after each action still finishes the decision it started', async () => {
    const d = device(), j = jev([{ op: 'TYPE', element: '2', text: 'TEXT:0' }]);
    expect(await runVisionComputerUse({ goal: 'Type "Somchai" into Name', yieldAfterAction: true }, d.deps(decider(j)), signal())).toMatchObject({ status: 'needs_input', reason: 'COMMAND_WAITING_INPUT', steps: 3 });
    expect(d.actions().map(a => a.kind)).toEqual(['pointer', 'key_chord', 'type_focused']);
    expect(j.steps()).toHaveLength(1);
  });

  test('a step that did not run drops the rest of its decision and is recorded as not run', async () => {
    const d = device({ receipts: [{ state: 'not_executed', error: 'TARGET_OCCLUDED' }] }), j = jev([{ op: 'TYPE', element: '2', text: 'TEXT:0' }, { done: 0.9 }]);
    await runVisionComputerUse({ goal: 'Type "Somchai" into Name' }, d.deps(decider(j)), signal());
    expect(d.actions()).toEqual([{ kind: 'pointer', op: 'click', x: 576, y: 260 }]);
    expect((j.steps()[1].state as any).previous_steps).toEqual(['typed "Somchai" into "Name" (AXTextField); it was not run']);
  });

  test('a Box click is refined on a crop and runs only when the dot is on the target', async () => {
    const hit = device(), j = jev([{ op: 'CLICK' }, { done: 0.9 }], { refine: { target: { top: 0.4, bottom: 0.5, left: 0.4, right: 0.5 } } });
    await runVisionComputerUse({ goal: 'Click the gear icon' }, hit.deps(decider(j, 'vision')), signal());
    // Coarse point (640, 400); the 400x400 crop starts at (440, 200); the refined box center is at 0.45 of it.
    expect(hit.actions()).toEqual([{ kind: 'pointer', op: 'click', x: 620, y: 380 }]);
    expect(j.requests.map(r => Object.keys(r.questions).sort().join(','))).toEqual(expect.arrayContaining(['target,visible', 'hit']));

    const miss = device(), refused = jev([{ op: 'CLICK' }, { done: 0.9 }], { dot: 0.1 });
    expect(await runVisionComputerUse({ goal: 'Click the gear icon' }, miss.deps(decider(refused, 'vision')), signal())).toMatchObject({ status: 'needs_verification', steps: 0 });
    expect(miss.actions()).toEqual([]);
    expect((refused.steps()[1].state as any).previous_steps[0]).toContain('was not made');
  });

  test('presses a key the counted number of times and scrolls by the chosen amount', async () => {
    const d = device(), j = jev([{ op: 'KEY', key: 'BACKSPACE', count: '3' }, { op: 'SCROLL', scroll: 'DOWN', amount: 'FAR', area: { top: 0.5, bottom: 1, left: 0, right: 0.5 } }, { done: 0.9 }]);
    await runVisionComputerUse({ goal: 'Delete three characters, then find the footer' }, d.deps(decider(j, 'vision')), signal());
    expect(d.actions()).toEqual([
      ...[1, 2, 3].map(() => ({ kind: 'key_chord', keys: ['backspace'] })),
      // The area is half the window high: a "screen" of it is half the window's.
      { kind: 'scroll', x: 320, y: 600, dy: scrollUnits('FAR', 400) },
    ]);
    expect(scrollUnits('SCREEN', 800)).toBe(13); expect(scrollUnits('FAR', 800)).toBe(39);
  });

  test('a high-impact step waits for the user and runs nothing', async () => {
    const d = device({ impact: command => command.includes('Save') ? 'HIGH_IMPACT' : 'ROUTINE' }), j = jev([{ op: 'CLICK', element: '1' }]);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, d.deps(decider(j)), signal())).toMatchObject({ status: 'needs_input', reason: 'COMMAND_WAITING_INPUT', lastAction: { confirm: true, label: 'Save' } });
    expect(d.actions()).toEqual([]);
  });

  // Regression (#633 review): a routine pick a hundredth below high-impact is a tie, not a routine action.
  test('a routine answer tied with high-impact at the reported precision waits for the user', async () => {
    const d = device({ distribution: { ROUTINE: 0.5, HIGH_IMPACT: 0.51 } }), j = jev([{ op: 'CLICK', element: '1' }]);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, d.deps(decider(j)), signal())).toMatchObject({ status: 'needs_input', lastAction: { confirm: true } });
    expect(d.actions()).toEqual([]);
  });

  test('typing at a Box target clicks and types without select-all: after a Box click the focus is unknown', async () => {
    const d = device(), j = jev([{ op: 'TYPE', text: 'TEXT:0', element: 'NONE' }, { done: 0.9 }]);
    await runVisionComputerUse({ goal: 'Type "Somchai" into the note' }, d.deps(decider(j, 'vision')), signal());
    expect(d.actions().map(a => a.kind)).toEqual(['pointer', 'type_focused']);
  });

  test('a decision that stopped partway is recorded as such, and the step limit lets a started decision finish', async () => {
    const partial = device({ receipts: [{ state: 'completed' }, { state: 'not_executed', error: 'TARGET_OCCLUDED' }] }), j = jev([{ op: 'TYPE', element: '2', text: 'TEXT:0' }, { done: 0.9 }]);
    await runVisionComputerUse({ goal: 'Type "Somchai" into Name' }, partial.deps(decider(j)), signal());
    expect((j.steps()[1].state as any).previous_steps).toEqual(['typed "Somchai" into "Name" (AXTextField); it stopped after 1 of its 3 actions']);
    const limited = device(), k = jev([{ op: 'TYPE', element: '2', text: 'TEXT:0' }]);
    expect(await runVisionComputerUse({ goal: 'Type "Somchai" into Name', maxSteps: 1 }, limited.deps(decider(k)), signal())).toMatchObject({ status: 'blocked', reason: 'STEP_LIMIT', steps: 3 });
    expect(limited.actions().map(a => a.kind)).toEqual(['pointer', 'key_chord', 'type_focused']);
  });

  test('repeating the step that just changed the screen ends as done unless Jev says the goal needs it again', async () => {
    const once = device(), j = jev([{ op: 'CLICK', element: '1' }, { op: 'CLICK', element: '1' }]);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, once.deps(decider(j)), signal())).toMatchObject({ status: 'succeeded', reason: 'GOAL_REACHED', steps: 1 });
    expect(j.requests.filter(r => 'again' in r.questions)).toHaveLength(1);

    const twice = device(), again = jev([{ op: 'CLICK', element: '1' }, { op: 'CLICK', element: '1' }, { done: 0.9 }], { again: 0.9 });
    expect(await runVisionComputerUse({ goal: 'Click Save twice' }, twice.deps(decider(again)), signal())).toMatchObject({ status: 'succeeded', steps: 2 });
  });

  test('a repeat after a step that did not change the screen is retried without asking', async () => {
    const d = device(), j = jev([{ op: 'CLICK', element: '1' }, { op: 'CLICK', element: '1' }, { done: 0.9 }]);
    const deps = d.deps(decider(j));
    const call = deps.call;
    // The first click lands but the screen stays the same (same text and controls).
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), text: ['same'] } : call(name, args, s);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, deps, signal())).toMatchObject({ status: 'succeeded', steps: 2 });
    expect(j.requests.filter(r => 'again' in r.questions)).toHaveLength(0);
    expect((j.steps()[1].state as any).previous_steps).toEqual(['clicked "Save" (AXButton); the screen did not change']);
  });

  test('a change only in pixels (a canvas) counts as a change, so a repeat is checked rather than retried', async () => {
    const shades = await Promise.all(['#fff', '#888'].map(async c => (await sharp({ create: { width: 1280, height: 800, channels: 3, background: c } }).jpeg().toBuffer()).toString('base64')));
    const d = device(), j = jev([{ op: 'CLICK', element: '1' }, { op: 'CLICK', element: '1' }]);
    const deps = d.deps(decider(j)), call = deps.call;
    let shot = 0;
    // Same Accessibility tree every time; the screenshot changes after the click.
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), text: ['same'] } : call(name, args, s);
    deps.screenshot = async s => ({ generation: s.generation, data: shades[Math.min(shot++, 1)], width: 1280, height: 800 });
    expect(await runVisionComputerUse({ goal: 'Pick the green swatch' }, deps, signal())).toMatchObject({ status: 'succeeded', steps: 1 });
    expect(j.requests.filter(r => 'again' in r.questions)).toHaveLength(1);
  });

  test('a blinking caret or a ticking clock is not a change', async () => {
    const base = sharp({ create: { width: 1280, height: 800, channels: 3, background: '#fff' } });
    const caret = (await base.clone().composite([{ input: { create: { width: 2, height: 18, channels: 3, background: '#000' } }, left: 400, top: 300 }]).jpeg().toBuffer()).toString('base64');
    const d = device(), j = jev([1, 2, 3].map(() => ({ op: 'CLICK', element: '1' })));
    const deps = d.deps(decider(j)), call = deps.call;
    let shot = 0;
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), text: ['same'] } : call(name, args, s);
    deps.screenshot = async s => ({ generation: s.generation, data: shot++ % 2 ? caret : jpeg, width: 1280, height: 800 });
    expect(await runVisionComputerUse({ goal: 'Click Save' }, deps, signal())).toMatchObject({ status: 'blocked', reason: 'NO_PROGRESS', steps: 2 });
    expect(j.requests.filter(r => 'again' in r.questions)).toHaveLength(0);
  });

  test('a scroll through rows that look alike moves the controls, so it is progress', async () => {
    const d = device(), j = jev([1, 2, 3].map(() => ({ op: 'SCROLL', scroll: 'DOWN' })).concat([{ done: 0.9 } as any]));
    const deps = d.deps(decider(j)), call = deps.call;
    let observed = 0;
    // Identical pixels every time; the rows under the controls change with each scroll.
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), text: ['same'], controls: [{ ...SAVE, label: `Item ${++observed}` }] } : call(name, args, s);
    expect(await runVisionComputerUse({ goal: 'Open Item 37' }, deps, signal())).toMatchObject({ status: 'succeeded', steps: 3 });
  });

  test('earlier context reaches Jev with the goal', async () => {
    const d = device(), j = jev([{ done: 0.9 }]);
    await runVisionComputerUse({ goal: 'Open the second one', interactionContext: 'Search results: Alpha, Beta, Gamma' }, d.deps(decider(j)), signal());
    expect(j.steps()[0].state).toMatchObject({ goal: 'Open the second one', earlier_context: 'Search results: Alpha, Beta, Gamma' });
  });

  test('a step that twice changed nothing is not tried a third time', async () => {
    const d = device(), j = jev([1, 2, 3, 4].map(() => ({ op: 'CLICK', element: '1' })));
    const deps = d.deps(decider(j)), call = deps.call;
    deps.call = async (name, args, s) => name === 'computer_observe' ? { ...(await call(name, args, s) as object), text: ['same'] } : call(name, args, s);
    expect(await runVisionComputerUse({ goal: 'Click Save' }, deps, signal())).toMatchObject({ status: 'blocked', reason: 'NO_PROGRESS', steps: 2 });
  });

  test('scrolling again after a scroll that moved the page is progress, not a goal already met', async () => {
    const d = device(), j = jev([{ op: 'SCROLL', scroll: 'DOWN' }, { op: 'SCROLL', scroll: 'DOWN' }, { done: 0.9 }]);
    expect(await runVisionComputerUse({ goal: 'Open Item 37 in the list' }, d.deps(decider(j)), signal())).toMatchObject({ status: 'succeeded', steps: 2 });
    expect(j.requests.filter(r => 'again' in r.questions)).toHaveLength(0);
  });

  test('giving up ends the run as blocked', async () => {
    const d = device(), j = jev([{ op: 'GIVE_UP' }]);
    expect(await runVisionComputerUse({ goal: 'Click Export' }, d.deps(decider(j)), signal())).toMatchObject({ status: 'blocked', reason: 'VISION_TARGET_NOT_FOUND' });
  });
});
