import {z} from 'zod';
import {randomUUID} from 'node:crypto';
import {COMMAND_STEPS_MAX,COMMAND_STEPS_TIMEOUT_MS,STEP_TEXT_MAX,stepParts,type CommandStepRun,type CommandStepStopReason} from './command-steps';
import type {BrowserTraceEvent} from './browser-trace';
import type {BrowserUseDependencies,BrowserUseInput,BrowserUseResult,Observation} from './browser-use';

/**
 * Remote Browser step mode: an explicit user step list runs step after step on
 * one tab lease without returning to the parent agent between steps. Each part
 * is one direct command of the single-command runner, so its fast paths,
 * confidence gate, write-ahead receipt and never-replay rules are unchanged.
 * This file adds sequencing, per-step effect verification and the same caps
 * as Computer Use step mode. The user's own list is their authorization.
 */
const STEP_RETRY_MAX = 2;
const LOADING_DELAY_MS = 800;
const SETTLE_OBSERVATIONS = 4;
const SETTLE_DELAY_MS = 400;
const SCROLL_NO_EFFECT_MAX = 3;
// Settling a newly loaded document: at most ~2.4 s of reads before moving on.
const STABLE_OBSERVATIONS = 8;
const STABLE_DELAY_MS = 300;
// The previous step's page may still be loading (results absent right after Enter).
const PART_ACTIONS = 3, PART_EVALUATIONS = 6;
const LOADING_REASONS = new Set(['NO_SUPPORTED_ACTION','LOW_TARGET_CONFIDENCE','LOW_OPERATION_CONFIDENCE','PAGE_CONTENT_UNAVAILABLE']);
// Steps whose effect may legitimately be invisible in a structured observation.
const TOLERANT_KINDS = new Set(['scroll','key']);

const StepsInput = z.object({
  contractVersion: z.literal(1).default(1),
  steps: z.array(z.string().min(1).max(STEP_TEXT_MAX)).min(2).max(COMMAND_STEPS_MAX),
  scope: z.object({device_id:z.string().min(1).max(120),grant_id:z.string().min(1).max(120),tab_id:z.string().min(1).max(120)}).strict(),
  interactionContext: z.string().max(8000).optional(),
  /** Opened before the first step, as in a single-command run. */
  startUrl: z.string().max(8192).optional(),
  fields: z.array(z.object({label:z.string().min(1).max(250),text:z.string().max(2000)}).strict()).max(60).default([]),
  timeoutMs: z.number().int().min(1000).max(600000).default(COMMAND_STEPS_TIMEOUT_MS),
  /** Whole-run budgets from the binding; each step part still gets at most 3 actions / 6 decisions. */
  maxSteps: z.number().int().min(1).max(100).optional(), maxEvaluations: z.number().int().min(1).max(150).optional(), maxTextCalls: z.number().int().min(0).max(60).optional(),
  maxStaleRetries: z.number().int().min(0).max(10).optional(), operationConfidence: z.number().min(0).max(1).optional(), targetConfidence: z.number().min(0).max(1).optional(),
}).strict();
export type BrowserStepsInput = z.input<typeof StepsInput>;
export type BrowserStepsResult = BrowserUseResult & {stepRun: CommandStepRun};
type RunOne = (input: BrowserUseInput, deps: BrowserUseDependencies, signal: AbortSignal) => Promise<BrowserUseResult>;

const fingerprint = (p: Observation | undefined) => p && JSON.stringify([p.url, p.title, p.text, p.elements.map(({ref: _, ...e}) => e), p.scroll, p.navigation]);
const delay = (ms: number, signal: AbortSignal) => new Promise<void>((resolve, reject) => {
  const stop = () => {clearTimeout(timer); reject(Error('TASK_CANCELLED'));};
  const timer = setTimeout(() => {signal.removeEventListener('abort', stop); resolve();}, ms);
  signal.addEventListener('abort', stop, {once: true});
  if (signal.aborted) stop();
});

export async function runBrowserStepsWith(runOne: RunOne, parse: (value: unknown) => Observation, raw: BrowserStepsInput, deps: BrowserUseDependencies, signal: AbortSignal): Promise<BrowserStepsResult> {
  const input = StepsInput.parse(raw);
  const timeoutMs = Math.min(input.timeoutMs, COMMAND_STEPS_TIMEOUT_MS);
  const deadline = Date.now() + timeoutMs;
  const runSignal = AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]);
  const events: BrowserTraceEvent[] = [];
  let sequence = 0, actions = 0, evaluations = 0, completed = 0, scrollNoEffect = 0;
  let lease: string | undefined, prefetched: Observation | undefined, before: Observation | undefined, last: BrowserUseResult | undefined;
  // The run's last dispatched and confirmed actions, across parts: a later part
  // that dispatched nothing must not hide them from the host's receipt check.
  let lastAction: BrowserUseResult['lastAction'], lastConfirmedAction: BrowserUseResult['lastConfirmedAction'];
  const unverified: number[] = [], notes: string[] = [];
  let doneParts: string[] = [];

  // One lease for the whole run: the per-part runner sees an idempotent
  // acquire and a deferred release. Mutations still pass the host fence.
  const inner: BrowserUseDependencies = {
    ...deps,
    call: async (name, args, callSignal) => {
      if (name === 'browser_task_acquire' && lease) return {state: 'completed', result: {protocol_version: 1, lease_token: lease}};
      if (name === 'browser_task_release') return {state: 'completed', result: {}};
      if (name === 'page_observe' && prefetched) {
        const page = prefetched; prefetched = undefined; before ??= page; return structuredClone(page);
      }
      const value = await deps.call(name, args, callSignal);
      if (name === 'browser_task_acquire') {
        const parsed = z.object({state: z.literal('completed'), result: z.object({lease_token: z.string()}).passthrough()}).safeParse(value);
        if (parsed.success) lease = parsed.data.result.lease_token;
      }
      if (name === 'page_observe') {
        const parsed = safeParse(parse, value);
        if (parsed) before ??= parsed;
      }
      return value;
    },
    trace: event => {
      const entry = {...event, sequence: ++sequence};
      if (events.length < 1024) events.push(entry);
      try {deps.trace?.(structuredClone(entry));} catch {/* Diagnostic sinks cannot change an outcome. */}
    },
    progress: event => deps.progress?.({...event, steps: actions + event.steps, evaluations: evaluations + event.evaluations}),
  };
  const observe = async (): Promise<Observation | undefined> => {
    try {
      const value = await deps.call('page_observe', {...input.scope, lease_token: lease, detail: 'full'}, runSignal) as Record<string, unknown>;
      if (value?.error) return undefined;
      return safeParse(parse, value);
    } catch {runSignal.throwIfAborted(); return undefined;}
  };
  const stop = (index: number, stopReason: CommandStepStopReason, detail?: string, remainingFrom = index): CommandStepRun => ({
    total: input.steps.length, completed, stopReason, stoppedAt: index + 1, stoppedStep: input.steps[index], ...(detail ? {detail} : {}),
    remaining: input.steps.slice(remainingFrom), ...(unverified.length ? {unverifiedSteps: [...unverified]} : {}),
    ...(doneParts.length ? {doneParts: [...doneParts]} : {}), ...(notes.length ? {notes: [...notes]} : {}),
  });
  const finish = (status: BrowserUseResult['status'], reason: string, stepRun: CommandStepRun): BrowserStepsResult => ({
    contractVersion: 1, status, reason, steps: actions, evaluations, staleRetries: 0, textCalls: 0, stepRun,
    trace: {version: 1, events: [...events], truncated: sequence > events.length, sinkFailed: false},
    ...(lastAction ? {lastAction} : {}), ...(lastConfirmedAction ? {lastConfirmedAction} : {}),
    ...(last?.lastEvaluation ? {lastEvaluation: last.lastEvaluation} : {}), ...(last?.fieldRequest ? {fieldRequest: last.fieldRequest} : {}),
    ...(last?.observation ? {observation: last.observation} : {}),
  });
  const waiting = (stepRun: CommandStepRun) => finish('needs_verification', 'COMMAND_WAITING_INPUT', stepRun);
  const timedOut = () => runSignal.aborted && !signal.aborted && !deps.interruptSignal?.aborted;

  let index = 0;
  try {
    for (; index < input.steps.length; index++) {
      const step = input.steps[index];
      const parts = stepParts(step);
      let stepChanged = true, lastKind: string | undefined;
      doneParts = [];
      for (const part of parts) {
        let result: BrowserUseResult | undefined;
        for (let attempt = 0; attempt <= STEP_RETRY_MAX; attempt++) {
          runSignal.throwIfAborted();
          const actionsLeft = Math.min(PART_ACTIONS, (input.maxSteps ?? Infinity) - actions), evaluationsLeft = Math.min(PART_EVALUATIONS, (input.maxEvaluations ?? Infinity) - evaluations);
          if (actionsLeft < 1 || evaluationsLeft < 1) return waiting(stop(index, 'STEP_NOT_EXECUTED', actionsLeft < 1 ? 'ACTION_BUDGET' : 'EVALUATION_BUDGET'));
          before = undefined;
          const context = [input.interactionContext, index ? 'Completed steps in this run: ' + input.steps.slice(0, index).map((s, i) => `${i + 1}) ${s}`).join('; ') : ''].filter(Boolean).join('\n').slice(-8000);
          result = await runOne({contractVersion: 1, goal: part, scope: input.scope, command: true, yieldAfterAction: true, stepPart: true,
            fields: input.fields, maxSteps: actionsLeft, maxEvaluations: evaluationsLeft, timeoutMs: Math.max(1000, deadline - Date.now()),
            ...(input.maxTextCalls !== undefined ? {maxTextCalls: input.maxTextCalls} : {}), ...(input.maxStaleRetries !== undefined ? {maxStaleRetries: input.maxStaleRetries} : {}),
            ...(input.operationConfidence !== undefined ? {operationConfidence: input.operationConfidence} : {}), ...(input.targetConfidence !== undefined ? {targetConfidence: input.targetConfidence} : {}),
            ...(input.startUrl && index === 0 && part === parts[0] && attempt === 0 ? {startUrl: input.startUrl} : {}),
            ...(context ? {interactionContext: context} : {})}, inner, runSignal);
          last = result; actions += result.steps; evaluations += result.evaluations;
          lastAction = result.lastAction ?? lastAction; lastConfirmedAction = result.lastConfirmedAction ?? lastConfirmedAction;
          const reason = result.commandOutcome?.done === false ? result.commandOutcome.reason : undefined;
          // Only a part that dispatched nothing is retried, on a fresh observation.
          const retryable = !result.steps && reason !== undefined && LOADING_REASONS.has(reason) && (index > 0 || part !== parts[0]);
          if (!retryable || attempt === STEP_RETRY_MAX) break;
          prefetched = undefined;
          await delay(LOADING_DELAY_MS, runSignal);
        }
        if (!result) break;
        if (result.lastAction?.outcome === 'unknown' || result.reason === 'OUTCOME_UNKNOWN') return finish('blocked', 'OUTCOME_UNKNOWN', stop(index, 'OUTCOME_UNKNOWN'));
        if (result.status === 'cancelled' || timedOut()) return timedOut() ? finish('blocked', 'TASK_DEADLINE', stop(index, 'TIMEOUT')) : finish('cancelled', result.reason, stop(index, 'CANCELLED'));
        const outcome = result.commandOutcome;
        if (!outcome) {
          // Field requests keep their own lifecycle; anything else returns control.
          if (result.status === 'blocked' && result.reason === 'FIELD_TEXT_REQUIRED') return finish('blocked', 'FIELD_TEXT_REQUIRED', stop(index, 'STEP_NOT_EXECUTED', result.reason));
          if (result.status === 'failed' || result.status === 'blocked') return finish(result.status, result.reason, stop(index, 'FAILED', result.reason));
          return waiting(stop(index, 'STEP_NOT_EXECUTED', result.reason));
        }
        if (outcome.action?.kind === 'new_tab') {
          // Scope stays on the approved tab; the following steps run there.
          notes.push(`Step ${index + 1}: stayed in the approved tab (no new tab is opened).`);
          lastKind = 'new_tab'; doneParts.push(part); continue;
        }
        if (!outcome.done && outcome.reason === 'SCROLL_LIMIT') {stepChanged = false; lastKind = 'scroll'; doneParts.push(part); continue;}
        if (!outcome.done) return waiting(stop(index, 'STEP_NOT_EXECUTED', outcome.reason));
        // Verify the observable effect before the next part decides; a
        // navigation may still be committing, so poll a few fresh reads.
        let after = result.observation;
        let changed = fingerprint(before) !== fingerprint(after);
        for (let poll = 0; poll < SETTLE_OBSERVATIONS && !changed; poll++) {
          await delay(SETTLE_DELAY_MS, runSignal);
          const fresh = await observe();
          if (fresh) {after = fresh; changed = fingerprint(before) !== fingerprint(fresh);}
        }
        // Opening the address the tab already shows leaves the page unchanged,
        // yet the requested state holds (E2E: start_url was already google.com).
        if (!changed && outcome.action?.kind === 'navigate' && sameAddress(after?.url, outcome.action.url)) changed = true;
        // A new document (search results, a followed link) keeps rendering after
        // it commits; deciding on it too early meets FORM_STATE_CHANGED rejections
        // (E2E: three stale clicks on Google results). Wait, bounded, until two
        // consecutive reads match before the next part decides.
        if (changed && after && before && after.url !== before.url) {
          for (let poll = 0; poll < STABLE_OBSERVATIONS; poll++) {
            await delay(STABLE_DELAY_MS, runSignal);
            const fresh = await observe();
            if (!fresh) continue;
            const stable = fingerprint(fresh) === fingerprint(after);
            after = fresh;
            if (stable) break;
          }
        }
        prefetched = after;
        lastKind = outcome.action?.kind;
        if (!changed && (!TOLERANT_KINDS.has(lastKind ?? '') || parts.length > 1)) {
          prefetched = undefined;
          return waiting(stop(index, 'STEP_NO_EFFECT', 'dispatched without an observable change', index + 1));
        }
        stepChanged = changed; doneParts.push(part);
      }
      doneParts = [];
      if (lastKind === 'new_tab' && parts.length === 1) {completed++; continue;}
      scrollNoEffect = stepChanged ? 0 : scrollNoEffect + 1;
      if (!stepChanged && scrollNoEffect >= SCROLL_NO_EFFECT_MAX) return waiting(stop(index, 'STEP_NO_EFFECT', 'dispatched without an observable change', index + 1));
      if (!stepChanged) unverified.push(index + 1);
      completed++;
    }
    return waiting({total: input.steps.length, completed, stopReason: 'ALL_STEPS_DONE', remaining: [],
      ...(unverified.length ? {unverifiedSteps: [...unverified]} : {}), ...(notes.length ? {notes: [...notes]} : {})});
  } catch (error) {
    const safeIndex = Math.min(index, input.steps.length - 1);
    if (lastAction?.outcome === 'unknown') return finish('blocked', 'OUTCOME_UNKNOWN', stop(safeIndex, 'OUTCOME_UNKNOWN'));
    if (signal.aborted || deps.interruptSignal?.aborted) return finish('cancelled', deps.interruptSignal?.aborted ? 'REVISION_SUPERSEDED' : 'TASK_CANCELLED', stop(safeIndex, 'CANCELLED'));
    if (timedOut()) return finish('blocked', 'TASK_DEADLINE', stop(safeIndex, 'TIMEOUT'));
    const code = error instanceof Error && /^[A-Z][A-Z_0-9]{2,79}$/.test(error.message) ? error.message : 'ADAPTER_FAILURE';
    return finish('failed', code, stop(safeIndex, 'FAILED', code));
  } finally {
    if (lease) {
      // Release the shared lease once; retry so it is not left held.
      for (let attempt = 0; attempt < 2; attempt++) {
        try {await deps.call('browser_task_release', {...input.scope, lease_token: lease, operation_id: randomUUID()}, AbortSignal.timeout(3000)); break;} catch {/* Lease expiry (60 s) bounds a failed release. */}
      }
    }
  }
}
/** Same page address, ignoring scheme, a leading www., a trailing slash and the fragment. */
function sameAddress(current: string | undefined, requested: string | undefined): boolean {
  const key = (value: string) => {
    const u = new URL(value);
    return u.hostname.replace(/^www\./u, '') + u.pathname.replace(/\/+$/u, '') + u.search;
  };
  try {return Boolean(current && requested) && key(current!) === key(requested!);} catch {return false;}
}
function safeParse(parse: (value: unknown) => Observation, value: unknown): Observation | undefined {
  try {return parse(value);} catch {return undefined;}
}
