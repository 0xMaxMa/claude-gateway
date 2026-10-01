import {z} from 'zod';
import {observedEffect} from './computer-policy';
import {checkInterruption} from './interrupt';
import {runComputerUse,ComputerObservation} from './computer-use';
import type {ComputerProgress,ComputerState,ComputerUseDependencies,ComputerUseResult} from './computer-use';
import {COMMAND_STEPS_MAX,COMMAND_STEPS_TIMEOUT_MS,STEP_TEXT_MAX,parseCommandSteps,stepParts} from './command-steps';
import type {CommandStepRun,CommandStepStopReason} from './command-steps';

/**
 * Step-by-step direct execution: an explicit user step list runs step after
 * step on one desktop lease, without returning to the parent agent between
 * steps. Every step reuses the direct single-command controller, so its
 * confidence gate, literal-text guard, write-ahead receipt and never-replay
 * reconciliation are unchanged. The runner only adds step sequencing,
 * per-step AX verification and hard caps. The user's own list is their
 * authorization: no step is held back for what it says or presses.
 */
// The step grammar is shared with Remote Browser step mode (command-steps.ts).
export {stepParts};
export const COMPUTER_STEPS_MAX = COMMAND_STEPS_MAX;
export const COMPUTER_STEPS_TIMEOUT_MS = COMMAND_STEPS_TIMEOUT_MS;
export const parseComputerSteps = parseCommandSteps;
export type ComputerStepStopReason = CommandStepStopReason;
export type ComputerStepRun = CommandStepRun;
// A step that performed no mutation may be retried; a dispatched one never is.
const STEP_RETRY_MAX = 2;
const RETRY_DELAY_MS = 400;
// Post-action settle polling before a step is declared ineffective.
const SETTLE_OBSERVATIONS = 4;
const SETTLE_DELAY_MS = 400;
// Scrolling at a boundary legitimately changes nothing; tolerate a few in a row.
const SCROLL_NO_EFFECT_MAX = 3;
// Stop reasons from the direct controller where no action was dispatched and
// the interface was only transiently not ready. Anything else returns control.
const RETRYABLE_REASONS = new Set(['UI_NOT_READY','STALE_OBSERVATION','ACTION_CONTEXT_CHANGED','POST_ACTION_EVIDENCE_STALE']);
// The previous step's page may still be loading: its first changed tree can
// lack the target (E2E: Google results absent 3 s after Enter). Re-observe later.
const LOADING_REASONS = new Set(['NO_SUPPORTED_ACTION','SHORTCUT_UNAVAILABLE','SHORTCUT_NOT_OFFERED']);
const LOADING_DELAY_MS = 800;


const StepsInput = z.object({
  steps: z.array(z.string().min(1).max(STEP_TEXT_MAX)).min(2).max(COMPUTER_STEPS_MAX),
  revision: z.number().int().positive().default(1),
  interactionContext: z.string().max(8000).optional(),
  timeoutMs: z.number().int().min(1).max(COMPUTER_STEPS_TIMEOUT_MS).default(COMPUTER_STEPS_TIMEOUT_MS),
}).strict();

const lastWaiting = (result:ComputerUseResult) =>
  [...result.trace.events].reverse().find(e => e.phase === 'waiting' && e.reason !== 'POST_ACTION_EVIDENCE_STALE')?.reason;
const delay = (ms:number, signal:AbortSignal) => new Promise<void>((resolve, reject) => {
  const stop = () => {clearTimeout(timer);reject(Error('CANCELLED'));};
  const timer = setTimeout(() => {signal.removeEventListener('abort', stop);resolve();}, ms);
  signal.addEventListener('abort', stop, {once:true});
});

export async function runComputerSteps(raw:unknown, deps:ComputerUseDependencies, signal:AbortSignal):Promise<ComputerUseResult> {
  const input = StepsInput.parse(raw);
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(input.timeoutMs)]);
  const trace:ComputerProgress[] = [];
  let sequence = 0, actions = 0, evaluations = 0, completed = 0, scrollNoEffect = 0;
  const unverified:number[] = [];
  let lease:string | undefined, prefetched:ComputerState | undefined, last:ComputerState | undefined;
  // Per-attempt tracking of the first pre-mutation state and last dispatched action.
  let before:ComputerState | undefined, dispatched:Record<string,unknown> | undefined, captured = false;
  let doneParts:string[] = [];
  let pending:string | undefined, lastAction:ComputerUseResult['lastAction'];

  const forward = (event:ComputerProgress) => {
    trace.push(event);if (trace.length > 2000) trace.shift();
    try {deps.progress?.(event);} catch {/* Diagnostic sinks cannot change an outcome. */}
  };
  const emit = (phase:ComputerProgress['phase'], extra:Partial<ComputerProgress> = {}) =>
    forward({...extra, phase, sequence:++sequence, round:completed + 1, at:Date.now(), revision:input.revision, steps:actions, evaluations});
  const check = () => {runSignal.throwIfAborted();if (!deps.authorized()) throw Error('ACCESS_DENIED');};
  const observe = async () => {
    check();
    const state = ComputerObservation.parse(await deps.call('computer_observe', {lease_token:lease}, runSignal));
    check();return state;
  };

  // One lease for the whole run. The wrapped controller sees an idempotent
  // acquire and a deferred release; recovery_required still reaches it first.
  const inner:ComputerUseDependencies = {
    ...deps,
    call: async (name, args, callSignal) => {
      if (name === 'computer_acquire' && lease) return {lease_token:lease};
      if (name === 'computer_release') return {released:true};
      if (name === 'computer_observe' && prefetched && Object.keys(args).every(k => k === 'lease_token')) {
        const state = prefetched;prefetched = undefined;return structuredClone(state);
      }
      const value = await deps.call(name, args, callSignal);
      if (name === 'computer_acquire') {
        const parsed = z.object({lease_token:z.string().min(1)}).safeParse(value);
        if (parsed.success) lease = parsed.data.lease_token;
      }
      return value;
    },
    observation: state => {last = state;deps.observation?.(state);},
    snapshot: deps.snapshot && (async (state, snapshotSignal) => {captured = true;return deps.snapshot!(state, snapshotSignal);}),
    beforeMutation: async (operationId, action) => {
      const planned = action as Record<string,unknown>;
      before ??= last && structuredClone(last);
      await deps.beforeMutation(operationId, action);
      dispatched = planned;
    },
    progress: event => {
      if (event.phase === 'terminal') return;
      if (event.operationId && event.phase === 'acting') pending = event.operationId;
      if (event.operationId === pending && event.phase === 'acted' && event.outcome !== 'unknown') pending = undefined;
      forward({...event, sequence:++sequence, round:completed + 1, steps:actions + event.steps, evaluations:evaluations + event.evaluations});
    },
  };

  const finish = async (status:ComputerUseResult['status'], reason:string, stepRun:ComputerStepRun, evidence = true):Promise<ComputerUseResult> => {
    // One evidence capture per stop point; never after an unresolved operation.
    if (evidence && !captured && !pending) {
      try {
        last = await observe();deps.observation?.(last);
        if (last.screenshotAvailable && deps.snapshot) await deps.snapshot(last, runSignal);
      } catch {/* The stop reason stands without fresh evidence. */}
    }
    emit('terminal', {status, reason});
    return {status, reason, revision:input.revision, steps:actions, evaluations, stepRun,
      trace:{events:[...trace], truncated:sequence > trace.length},
      ...(pending ? {operationId:pending} : {}), ...(last ? {observation:last} : {}), ...(lastAction ? {lastAction} : {})};
  };
  const stop = (index:number, stopReason:ComputerStepStopReason, detail?:string):ComputerStepRun => ({
    total:input.steps.length, completed, stopReason, stoppedAt:index + 1,
    stoppedStep:input.steps[index], ...(detail ? {detail} : {}), remaining:input.steps.slice(index),
    ...(unverified.length ? {unverifiedSteps:[...unverified]} : {}), ...(doneParts.length ? {doneParts:[...doneParts]} : {}),
  });
  const timedOut = () => runSignal.aborted && !signal.aborted && !deps.interruptSignal?.aborted;

  let index = 0;
  try {
    checkInterruption(deps.interruptSignal);
    for (; index < input.steps.length; index++) {
      const step = input.steps[index];
      captured = false;
      // A list item may join commands ("open Chrome then press Cmd+T"). Each
      // part must run; a step is done only when every part had its effect.
      const parts = stepParts(step);
      let stepChanged = true, lastKind:unknown;doneParts = [];
      for (const part of parts) {
        let result:ComputerUseResult | undefined;
        for (let attempt = 0; attempt <= STEP_RETRY_MAX; attempt++) {
          check();checkInterruption(deps.interruptSignal);
          before = undefined;dispatched = undefined;
          const context = [input.interactionContext, index ? 'Completed steps in this run: ' + input.steps.slice(0, index).map((s, i) => `${i + 1}) ${s}`).join('; ') : '']
            .filter(Boolean).join('\n').slice(-8000);
          // Each part is its own direct command: literal text candidates come
          // only from this part's text, and Claude-prepared inputs are excluded.
          // Three actions at most: focusing a field, typing and its Enter.
          result = await runComputerUse({goal:part, revision:input.revision, yieldAfterInteraction:true, maxSteps:3,
            timeoutMs:input.timeoutMs, ...(context ? {interactionContext:context} : {})}, inner, runSignal);
          actions += result.steps;evaluations += result.evaluations;
          lastAction = result.lastAction ?? lastAction;
          const waitingReason = lastWaiting(result) ?? '';
          // The first step is retried too: an app brought forward just before the
          // list ran can still be drawing its window (E2E e6149724 stopped at 0/5).
          const retryable = RETRYABLE_REASONS.has(waitingReason) || LOADING_REASONS.has(waitingReason);
          if (result.status !== 'needs_input' || result.steps || !retryable || attempt === STEP_RETRY_MAX) break;
          prefetched = undefined;
          await delay(LOADING_REASONS.has(waitingReason) ? LOADING_DELAY_MS : RETRY_DELAY_MS, runSignal);
        }
        if (!result) break;
        if (result.status === 'needs_reconciliation') {
          pending = result.operationId ?? pending;
          return await finish('needs_reconciliation', result.reason, stop(index, 'OUTCOME_UNKNOWN'), false);
        }
        if (result.status === 'cancelled' || timedOut()) {
          return timedOut() ? await finish('blocked', 'TIMEOUT', stop(index, 'TIMEOUT'), false) : await finish('cancelled', result.reason, stop(index, 'CANCELLED'), false);
        }
        const waiting = lastWaiting(result);
        if (result.status !== 'needs_input' || waiting !== 'ACTION_DISPATCHED' || !dispatched || !before) {
          // Low confidence, ambiguous target, missing text or a rejected action:
          // the parent decides. A blocked controller keeps its own status.
          const reason = result.status === 'needs_input' ? 'COMMAND_WAITING_INPUT' : result.reason;
          return await finish(result.status === 'needs_input' ? 'needs_input' : result.status, reason, stop(index, 'STEP_NOT_EXECUTED', waiting ?? result.reason));
        }
        // Verify the part's observable effect before the next command decides.
        let changed = false;
        for (let poll = 0; poll < SETTLE_OBSERVATIONS && !changed; poll++) {
          if (poll) await delay(SETTLE_DELAY_MS, runSignal);
          try {prefetched = await observe();} catch (error) {
            if (!(error instanceof Error) || error.message !== 'STALE_OBSERVATION') throw error;
            prefetched = undefined;continue;
          }
          changed = observedEffect(before, prefetched, dispatched);
        }
        // Replaces the inner controller's terminal event: no extra receipt write per step.
        emit('observed', {action:dispatched.kind as ComputerProgress['action'], changed, reason:changed ? 'STEP_VERIFIED' : 'STEP_NO_EFFECT'});
        lastKind = dispatched.kind;
        if (!changed && (dispatched.kind !== 'scroll' || parts.length > 1)) {
          // Dispatched but ineffective: never re-sent here; the parent decides.
          prefetched = undefined;
          return await finish('needs_input', 'COMMAND_WAITING_INPUT', {...stop(index, 'STEP_NO_EFFECT', 'dispatched without an observable change'), remaining:input.steps.slice(index + 1)});
        }
        stepChanged = changed;doneParts.push(part);
      }
      doneParts = [];
      const changed = stepChanged;
      scrollNoEffect = changed ? 0 : scrollNoEffect + 1;
      if (!changed && (lastKind !== 'scroll' || scrollNoEffect >= SCROLL_NO_EFFECT_MAX)) {
        prefetched = undefined;
        return await finish('needs_input', 'COMMAND_WAITING_INPUT', {...stop(index, 'STEP_NO_EFFECT', 'dispatched without an observable change'), remaining:input.steps.slice(index + 1)});
      }
      if (!changed) unverified.push(index + 1);
      completed++;
    }
    prefetched = undefined;
    return await finish('needs_input', 'COMMAND_WAITING_INPUT', {total:input.steps.length, completed, stopReason:'ALL_STEPS_DONE', remaining:[],
      ...(unverified.length ? {unverifiedSteps:[...unverified]} : {})});
  } catch (error) {
    const safeIndex = Math.min(index, input.steps.length - 1);
    if (pending) return await finish('needs_reconciliation', 'OUTCOME_UNKNOWN', stop(safeIndex, 'OUTCOME_UNKNOWN'), false);
    if (signal.aborted || deps.interruptSignal?.aborted) return await finish('cancelled', deps.interruptSignal?.aborted ? 'REVISION_SUPERSEDED' : 'CANCELLED', stop(safeIndex, 'CANCELLED'), false);
    if (timedOut()) return await finish('blocked', 'TIMEOUT', stop(safeIndex, 'TIMEOUT'), false);
    const code = error instanceof Error && /^[A-Z][A-Z_0-9]{0,79}$/.test(error.message) ? error.message : 'COMPUTER_USE_FAILED';
    return await finish('blocked', code, stop(safeIndex, 'FAILED', code), false);
  } finally {
    if (lease) {
      // The relay has no lease expiry; retry once so a lease is not left held.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {await deps.call('computer_release', {lease_token:lease}, AbortSignal.timeout(2000));break;} catch {/* A re-acquire returns the same token, so a held lease stays reusable. */}
      }
    }
  }
}
