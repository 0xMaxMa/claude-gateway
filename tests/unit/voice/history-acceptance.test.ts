import { AgentRunner } from '../../../src/agent/runner';

test('voice acceptance waits for visible history, without waiting for the Agent response', async () => {
  let finishHistory!: () => void;
  const persisted = new Promise<void>(resolve => { finishHistory = resolve; });
  const response = new Promise<string>(() => {});
  const orchestration = {
    submitInput: jest.fn(() => ({ inputId: 'input', response })),
    flushHistory: jest.fn(() => persisted),
    responseIdForInput: jest.fn(() => 'response'),
  };
  const runner = Object.create(AgentRunner.prototype) as any;
  runner.agentConfig = { id: 'agent', orchestration: { enabled: true }, voice: { enabled: true } };
  runner.apiSessionExists = jest.fn(async () => true);
  runner.getOrchestration = jest.fn(async () => orchestration);
  let accepted = false;
  const result = runner.submitVoiceUtterance('session', 'getpod', 'owner', 'สร้างรูปหมามีปีก', 'utterance', true, 'gpt-6-astra')
    .then((value: unknown) => { accepted = true; return value; });
  await new Promise(resolve => setImmediate(resolve));
  expect(orchestration.submitInput).toHaveBeenCalledWith(expect.objectContaining({model:'gpt-6-astra',modality:'live_voice'}), expect.any(Object));
  expect(accepted).toBe(false);
  finishHistory();
  await expect(result).resolves.toMatchObject({ inputId: 'input', response });
});
