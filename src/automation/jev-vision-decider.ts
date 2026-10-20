import { randomUUID } from 'node:crypto';
import type { ComputerState } from './computer-use';
import { observedEffect } from './computer-policy';
import { KEYS, MAX_ELEMENTS, buildDotCheck, buildRefineStep, buildRepeatCheck, buildVisionStep, dotHits, readRefineStep, readVisionStep, refineCrop, repeatNeeded, type VisionElement, type VisionStepInput } from './jev-vision-step';
import { ScreenImage, boxCenter, screensDiffer, type JevImage, type Mark, type Point, type Rect } from './vision-image';
import type { VisionDecide, VisionTurn, VisionView } from './vision-decider';
import type { JevBox, JevRequest, JevResult } from '../jev/types';

/**
 * Image-first Computer Use on Jev (jev.images.enabled): a VisionDecide for runVisionComputerUse, so capture, the
 * impact gate, receipts, refusals and the Accessibility fallback are the same loop the model decider uses. Each
 * turn sends the window screenshot, sensitive controls painted out, and answers with one computer-toolset call:
 *  - hybrid: Accessibility controls are drawn on the screenshot with ids (Set-of-Mark) and listed; Jev picks one
 *    by id, and a Box finds what the list cannot name.
 *  - vision: the screenshot only; every target is a Box.
 * A Box click is refined on a crop and dot-checked first; a refused dot clicks nothing. One decision can take
 * several actions (click a field, select its text, type; a key pressed N times): the rest wait in a queue and run
 * only while each previous one completed.
 */
export interface JevVisionEvent { elapsedMs: number; requests: number; decision: string; reason?: string; refined?: boolean; dot?: 'hit' | 'refused'; withheld?: boolean }
export interface JevVisionOptions {
  mode: 'vision' | 'hybrid';
  evaluate: (request: JevRequest, signal: AbortSignal) => Promise<JevResult>;
  /** Codes and timings only; never screenshots, screen text or typed text. */
  onDecision?: (event: JevVisionEvent) => void;
}
type Call = { name: string; input: Record<string, unknown> };
/** Assumed wheel notch height in screenshot pixels (Chromium scrolls about 50 px a notch). One screen is 80% of the
 * window, so a target just below stays in view; far is three screens. mapComputerCall clamps to 1-50 notches. */
export const WHEEL_PX = 50;
export const scrollUnits = (amount: 'SCREEN' | 'FAR', height: number) => Math.min(50, Math.max(1, Math.round(0.8 * height / WHEEL_PX)) * (amount === 'FAR' ? 3 : 1));
const tool = (call: Call, continues = false): VisionTurn => ({ content: [{ type: 'tool_use', id: `jev_${randomUUID()}`, name: call.name, input: call.input, ...(call.name === 'finish' ? {} : { toolset_name: 'computer' }) }], stopReason: 'tool_use', ...(continues ? { continues } : {}) });
const pixels = (b: NonNullable<ComputerState['controls'][number]['bounds']>, shot: { width: number; height: number }): Rect => ({ x: b.x * shot.width, y: b.y * shot.height, width: b.width * shot.width, height: b.height * shot.height });
const point = (p: Point) => [Math.round(p.x), Math.round(p.y)];
/** Which controls are where: a scroll moves them even when the list looks alike, a blinking caret does not. */
const layout = (state: ComputerState) => JSON.stringify(state.controls.map(c => [c.role, c.label, c.bounds && [c.bounds.x, c.bounds.y, c.bounds.width, c.bounds.height].map(n => Math.round(n * 1000))]));

export function jevVisionDecider(options: JevVisionOptions): VisionDecide {
  const history: string[] = [];
  let queue: Call[] = [];
  // The last decision that ran an action and changed the screen, and the one in flight: its identity, its note,
  // and the state and screenshot thumbnail it ran on.
  type Step = { key: string; note: string; before: ComputerState; thumbnail: Buffer; actions: number; ran: number };
  let last: Step | undefined, pending: Step | undefined;
  // The same step that ran without changing anything, and how many times in a row.
  let stalled: { key: string; times: number } | undefined;
  return async (_messages, signal, view: VisionView) => {
    const started = Date.now();
    let requests = 0;
    const ask = async (request: JevRequest) => { requests++; return options.evaluate(request, signal); };
    const report = (decision: string, extra: Omit<JevVisionEvent, 'elapsedMs' | 'requests' | 'decision'> = {}) => {
      try { options.onDecision?.({ elapsedMs: Date.now() - started, requests, decision, ...extra }); } catch { /* Diagnostics cannot change a decision. */ }
    };
    if (pending && view.previous === 'completed' && queue.length) { pending.ran++; return tool(queue.shift()!, queue.length > 0); }
    queue = [];
    const { state, shot } = view;
    const sensitive = state.controls.filter(c => c.sensitive);
    // Fail closed: when a sensitive control may be on screen but cannot be painted out (no bounds, or an observation
    // truncated before listing it), no screenshot leaves the device this step. Jev decides on the listed controls
    // instead (text only). The local copy still serves change detection.
    const withheld = state.truncated || sensitive.some(c => !c.bounds) || (state.focusedControl?.sensitive === true && !sensitive.some(c => c.ref === state.focusedControl!.ref && c.bounds));
    const screen = await ScreenImage.open(Buffer.from(shot.data, 'base64'), shot, sensitive.filter(c => c.bounds).map(c => pixels(c.bounds!, shot)));
    const thumbnail = await screen.thumbnail();
    // Settle the previous decision: its note and evidence go into the history Jev reads.
    if (pending) {
      if (view.previous === 'completed') {
        // Moved controls count (a scrolled list of alike rows), and pixels (a canvas changes without any
        // Accessibility change), but not a blinking caret or a ticking clock.
        const changed = observedEffect(pending.before, state, {}) || layout(pending.before) !== layout(state) || screensDiffer(pending.thumbnail, thumbnail);
        history.push(pending.note + (changed ? '' : '; the screen did not change'));
        last = changed ? pending : undefined;
        stalled = changed ? undefined : { key: pending.key, times: stalled?.key === pending.key ? stalled.times + 1 : 1 };
      } else history.push(pending.note + (pending.ran ? `; it stopped after ${pending.ran} of its ${pending.actions} actions` : '; it was not run'));
      pending = undefined;
    }
    const listed = options.mode === 'hybrid' || withheld ? state.controls.filter(c => c.bounds && !c.sensitive).slice(0, MAX_ELEMENTS) : [];
    const ids = new Map(listed.map((c, i) => [String(i + 1), c]));
    const marks: Mark[] = listed.map((c, i) => ({ id: String(i + 1), rect: pixels(c.bounds!, shot) }));
    const elements: VisionElement[] = listed.map((c, i) => ({ id: String(i + 1), role: c.role, label: c.label, ...(c.context ? { context: c.context } : {}), ...(c.value ? { value: c.value } : {}) }));
    const image = withheld ? { withheld: true as const, application: state.application, ...(state.windowTitle ? { windowTitle: state.windowTitle } : {}) } : await screen.render({ marks });
    const input: VisionStepInput = { goal: view.goal, ...(view.context ? { context: view.context } : {}), history, screen: image, elements, point: !withheld };
    const decision = readVisionStep(input, await ask(buildVisionStep(input)));
    let extra: Omit<JevVisionEvent, 'elapsedMs' | 'requests' | 'decision'> = withheld ? { withheld: true } : {};
    if (decision.kind === 'done') { report('DONE', extra); return tool({ name: 'finish', input: { outcome: 'done' } }); }
    if (decision.kind === 'give_up') { report('GIVE_UP', { reason: decision.reason }); return tool({ name: 'finish', input: { outcome: 'blocked', blocker: decision.reason === 'MODEL_GAVE_UP' || decision.reason === 'TARGET_NOT_FOUND' ? 'TARGET_NOT_FOUND' : 'OTHER' } }); }

    const calls: Call[] = [];
    let note: string, key: string;
    if (decision.kind === 'key') {
      for (let i = 0; i < decision.count; i++) calls.push({ name: 'key', input: { text: KEYS[decision.key] } });
      note = `pressed ${KEYS[decision.key]}${decision.count > 1 ? ` ${decision.count} times` : ''}`; key = 'key:' + decision.key;
    } else if (decision.kind === 'scroll') {
      // A screen is the scrolled area's height: a short panel scrolled by the window's height skips past its rows.
      const area = decision.area && !('withheld' in image) ? { box: decision.area, image } : undefined;
      const at = area ? boxCenter(area.image, area.box) : { x: shot.width / 2, y: shot.height / 2 };
      const height = area ? (area.box.bottom - area.box.top) * area.image.height * area.image.unitsPerPixel.y : shot.height;
      calls.push({ name: 'scroll', input: { coordinate: point(at), scroll_direction: decision.direction, scroll_amount: scrollUnits(decision.amount, height) } });
      note = `scrolled ${decision.direction} ${decision.amount === 'FAR' ? 'several screens' : 'one screen'}${area ? ' in the area at (' + point(at).join(', ') + ')' : ''}`; key = 'scroll:' + decision.direction;
    } else {
      const control = 'elementId' in decision.target ? ids.get(decision.target.elementId) : undefined;
      if ('elementId' in decision.target && !control) throw Error('INVALID_DECISION');
      let at: Point;
      if (control) at = { x: (control.bounds!.x + control.bounds!.width / 2) * shot.width, y: (control.bounds!.y + control.bounds!.height / 2) * shot.height };
      else {
        // Box targets are asked only with an image.
        if ('withheld' in image) throw Error('INVALID_DECISION');
        const located = await locate(screen, image, (decision.target as { box: JevBox }).box, view.goal, history, shot, ask);
        extra = { ...extra, refined: located.refined, dot: located.point ? 'hit' : 'refused' };
        if (!located.point) {
          // Nothing runs; the next turn decides again on a fresh screenshot with the refusal in its history.
          history.push(`a ${decision.kind === 'type' ? 'click into a field' : 'click'} near (${point(located.coarse).join(', ')}) was not made: the target was not under the point`);
          report('REFUSED', extra);
          return tool({ name: 'screenshot', input: {} });
        }
        at = located.point;
      }
      const named = control ? `${JSON.stringify(control.label.slice(0, 80))} (${control.role})` : `the control at (${point(at).join(', ')})`;
      if (decision.kind === 'click') { calls.push({ name: 'left_click', input: { coordinate: point(at) } }); note = `clicked ${named}`; }
      else {
        const focused = control && (control.focused === true || control.ref === state.focusedControl?.ref);
        if (!focused) calls.push({ name: 'left_click', input: { coordinate: point(at) } });
        // TYPE replaces the field's text: select what it holds first, but only in a known text field. After a Box
        // click the focus is unknown, and select-all there could take a whole document.
        if (control?.actions.includes('type') && control.value) calls.push({ name: 'key', input: { text: 'cmd+a' } });
        calls.push({ name: 'type', input: { text: decision.text! } });
        note = `typed ${JSON.stringify(decision.text!.slice(0, 80))} into ${named}`;
      }
      key = `${decision.kind}:${control ? control.identity ?? JSON.stringify([control.role, control.label]) : point(at).map(n => n >> 5).join(',')}:${decision.text ?? ''}`;
    }
    // A third try of a step that twice ran and changed nothing: stop instead of spending the step budget on it.
    if (stalled && stalled.key === key && stalled.times >= 2) { report('STOPPED', { ...extra, reason: 'NO_PROGRESS' }); throw Error('NO_PROGRESS'); }
    // The same click or typing on the same target right after it changed the screen: usually a goal already met.
    // Scrolls and keys repeat by design (a far target, a count), so they never end a run this way.
    if ((decision.kind === 'click' || decision.kind === 'type') && last && last.key === key && !repeatNeeded(await ask(buildRepeatCheck(view.goal, history, image, note)))) {
      report('DONE', { ...extra, reason: 'REPEAT_NOT_NEEDED' });
      return tool({ name: 'finish', input: { outcome: 'done' } });
    }
    pending = { key, note, before: state, thumbnail, actions: calls.length, ran: 0 };
    queue = calls.slice(1);
    report(decision.kind.toUpperCase(), extra);
    return tool(calls[0], queue.length > 0);
  };
}

/** Box to click point: refine on a crop around the coarse point, then a dot at the final point must be on the target. */
async function locate(screen: ScreenImage, image: JevImage, box: JevBox, goal: string, history: string[], shot: { width: number; height: number }, ask: (r: JevRequest) => Promise<JevResult>) {
  const coarse = boxCenter(image, box), area = refineCrop(coarse, shot);
  const crop = await screen.render({ crop: area });
  const refinedBox = readRefineStep(await ask(buildRefineStep(goal, history, crop)));
  const at = refinedBox ? boxCenter(crop, refinedBox) : coarse;
  const hit = dotHits(await ask(buildDotCheck(goal, history, await screen.render({ crop: area, dot: at }))));
  return { coarse, refined: !!refinedBox, point: hit ? at : undefined };
}
