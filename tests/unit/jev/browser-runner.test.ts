import { BrowserObservation, BrowserRunnerOptions, BrowserTransport, runBrowserTask } from '../../../src/jev/browser-runner';
import { JevResult } from '../../../src/jev/types';
const page: BrowserObservation = { revision: '1', fingerprint: 'one', state: 'A page', actions: [{ id: 'button', operation: 'click', description: 'Open result' }] };
function decision(operation: string, target: string, confidence = .95): JevResult {
  return { requestId: 'r', requestedModel: 'jev', model: 'jev', usage: { input_tokens: 10, output_tokens: 3 }, answers: {
    operation: { type: 'choice', choice: operation, confidence, probabilities: { [operation]: 1 } },
    target: { type: 'choice', choice: target, confidence, probabilities: { [target]: 1 } },
  } };
}
function setup() {
  const transport: jest.Mocked<BrowserTransport> = {
    observe: jest.fn<ReturnType<BrowserTransport['observe']>, Parameters<BrowserTransport['observe']>>(async () => structuredClone(page)), checkAccess: jest.fn<ReturnType<BrowserTransport['checkAccess']>, Parameters<BrowserTransport['checkAccess']>>(async () => true),
    execute: jest.fn<ReturnType<BrowserTransport['execute']>, Parameters<BrowserTransport['execute']>>(async () => ({ outcome: 'applied' as const })), verifyCompletion: jest.fn<ReturnType<BrowserTransport['verifyCompletion']>, Parameters<BrowserTransport['verifyCompletion']>>(async () => ({ verified: true, evidence: 'Independent expected result exists.' })),
  };
  const evaluate = jest.fn(async () => decision('DONE', 'NONE'));
  const options: BrowserRunnerOptions = { goal: 'Open result', transport, evaluate };
  return { transport, evaluate, options };
}
describe('generic browser runner', () => {
  it('performs bounded observed actions and requires fresh independent completion evidence', async () => {
    const f = setup(); f.evaluate.mockResolvedValueOnce(decision('click', 'button'));
    expect(await runBrowserTask(f.options)).toMatchObject({ status: 'completed', steps: 1, evaluations: 2 });
    expect(f.transport.observe).toHaveBeenCalledTimes(3);
    expect(f.transport.execute.mock.calls[0][0]).toEqual({ observation: page, action: page.actions[0] });
  });
  it('never treats model DONE as success without evidence', async () => {
    const f = setup(); f.transport.verifyCompletion.mockResolvedValue({ verified: false });
    expect(await runBrowserTask(f.options)).toMatchObject({ status: 'needs_verification', reason: 'completion_not_verified' });
  });
  it('rechecks permission after inference before executing', async () => {
    const f = setup(); f.evaluate.mockImplementation(async () => { f.transport.checkAccess.mockResolvedValue(false); return decision('click', 'button'); });
    expect(await runBrowserTask(f.options)).toMatchObject({ status: 'failed', reason: 'access_revoked_or_stale' }); expect(f.transport.execute).not.toHaveBeenCalled();
  });
  it('does not execute a low-confidence target despite confident operation', async () => {
    const f = setup(); const d = decision('click', 'button'); (d.answers.target as any).confidence = .1; f.evaluate.mockResolvedValue(d);
    expect(await runBrowserTask(f.options)).toMatchObject({ reason: 'uncertain_decision' }); expect(f.transport.execute).not.toHaveBeenCalled();
  });
  it('rejects hallucinated operation/target and mismatched choices', async () => {
    const f = setup(); f.evaluate.mockResolvedValue(decision('click', 'NONE'));
    expect(await runBrowserTask(f.options)).toMatchObject({ reason: 'inconsistent_decision' }); expect(f.transport.execute).not.toHaveBeenCalled();
  });
  it('hands off missing field values and never asks Jev to generate them', async () => {
    const f = setup(); f.transport.observe.mockResolvedValue({ ...page, actions: [{ ...page.actions[0], fieldKey: 'message' }] }); f.evaluate.mockResolvedValue(decision('click', 'button'));
    expect(await runBrowserTask(f.options)).toMatchObject({ status: 'waiting_input', fieldKey: 'message' }); expect(f.transport.execute).not.toHaveBeenCalled();
  });
  it('passes explicit values only to transport and not inference', async () => {
    const f = setup(); f.transport.observe.mockResolvedValue({ ...page, actions: [{ ...page.actions[0], fieldKey: 'message' }] }); f.evaluate.mockResolvedValueOnce(decision('click', 'button'));
    await runBrowserTask({ ...f.options, fieldValues: { message: 'private supplied text' } });
    expect(f.transport.execute.mock.calls[0][0].value).toBe('private supplied text'); expect(JSON.stringify(f.evaluate.mock.calls)).not.toContain('private supplied text');
  });
  it('does not replay possibly applied mutations after transport failure', async () => {
    const f = setup(); f.evaluate.mockResolvedValue(decision('click', 'button')); f.transport.execute.mockRejectedValue(new Error('disconnect after send'));
    expect(await runBrowserTask(f.options)).toMatchObject({ status: 'needs_verification', reason: 'action_outcome_unknown' }); expect(f.transport.execute).toHaveBeenCalledTimes(1);
  });
  it('bounds no-progress loops', async () => {
    const f = setup(); f.evaluate.mockResolvedValue(decision('click', 'button'));
    expect(await runBrowserTask({ ...f.options, budget: { maxNoProgress: 2 } })).toMatchObject({ reason: 'no_progress', steps: 2 });
  });
  it('honors cancellation before observation', async () => {
    const f = setup(); const abort = new AbortController(); abort.abort();
    expect(await runBrowserTask({ ...f.options, signal: abort.signal })).toMatchObject({ status: 'cancelled' }); expect(f.transport.observe).not.toHaveBeenCalled();
  });
  it('bounds hung adapters and preserves uncertain mutation state', async () => {
    const f = setup(); f.evaluate.mockResolvedValue(decision('click', 'button')); f.transport.execute.mockImplementation(() => new Promise(() => {}));
    expect(await runBrowserTask({ ...f.options, budget: { timeoutMs: 10 } })).toMatchObject({ status: 'needs_verification', reason: 'action_outcome_unknown' });
  });
  it('bounds evaluation and step budgets', async () => {
    const f = setup(); f.evaluate.mockResolvedValue(decision('click', 'button'));
    expect(await runBrowserTask({ ...f.options, budget: { maxEvaluations: 1 } })).toMatchObject({ reason: 'budget_exhausted', steps: 1, evaluations: 1 });
  });
});
