import { ConversationIntake } from '../../../src/orchestration/conversation-intake';
import { resolveOrchestrationConfig } from '../../../src/orchestration/config';
import { DecisionService } from '../../../src/orchestration/decisions';
import { OrchestrationStore } from '../../../src/orchestration/store';

test('intake silence defaults to two seconds and accepts a per-agent override', () => {
  expect(resolveOrchestrationConfig().conversation.intakeWaitMs).toBe(2000);
  expect(resolveOrchestrationConfig({ conversation: { intakeWaitMs: 750 } }).conversation.intakeWaitMs).toBe(750);
  for (const intakeWaitMs of [0, -1, NaN, Infinity, 2.5]) {
    expect(() => resolveOrchestrationConfig({ conversation: { intakeWaitMs } })).toThrow('positive bounded integer');
  }
});

describe('durable material waiting', () => {
  let store: OrchestrationStore;
  let intake: ConversationIntake;
  let decisions: DecisionService;
  const scope = { agentId: 'a', agentSessionId: 's', source: 'api' as const, accountId: 'key', chatId: 'c', threadKey: '', principalId: 'p' };
  beforeEach(() => {
    jest.spyOn(Date, 'now').mockReturnValue(10000);
    store = new OrchestrationStore(':memory:', 'a');
    intake = new ConversationIntake(store);
    decisions = new DecisionService(store);
  });
  afterEach(() => { store.close(); jest.restoreAllMocks(); });
  function receive(text: string, mode: 'wait' | 'ready' = 'wait') {
    const receipt = store.acceptInput({ scope, text });
    intake.touch(receipt.inputId);
    const decision = decisions.begin(receipt.conversationId, 'p', [receipt.inputId]);
    const data = intake.choose({ conversationId: receipt.conversationId, principalId: 'p', inputId: receipt.inputId,
      decisionId: decision.decisionId, epoch: decision.epoch, actionId: `intake:${receipt.inputId}`, execute: true, writeMemory: false },
    { mode, preparation: text, clarification: 'What would you like me to do?', acknowledgement: 'I will review these now.' });
    decisions.finish(decision, '', 'completed', undefined, false);
    return { ...receipt, data };
  }
  test('deadline uses the latest material, with the configured interval', () => {
    const first = receive('first image');
    expect(intake.due(2000, 11999)).toHaveLength(0);
    expect(intake.due(2000, 12000)).toHaveLength(1);
    jest.mocked(Date.now).mockReturnValue(11500);
    const second = receive('second image');
    expect(second.data.inputIds).toEqual([first.inputId, second.inputId]);
    expect(intake.due(2000, 12000)).toHaveLength(0);
    expect(intake.due(2000, 13499)).toHaveLength(0);
    expect(intake.due(2000, 13500)).toHaveLength(1);
    expect(intake.due(750, 12250)).toHaveLength(1);
  });
  test('a complete instruction consumes the preparation without waiting another interval', () => {
    const first = receive('material');
    jest.mocked(Date.now).mockReturnValue(10100);
    const next = receive('Review this', 'ready');
    expect(next.data.inputIds).toEqual([first.inputId, next.inputId]);
    expect(next.data.acknowledgement).toBe('I will review these now.');
    expect(intake.due(2000, 100000)).toHaveLength(0);
  });
  test('accepted input prevents a stale clarification while it is being read', () => {
    receive('material');
    jest.mocked(Date.now).mockReturnValue(11000);
    const pending = store.acceptInput({ scope, text: 'more material' });
    intake.touch(pending.inputId);
    expect(intake.due(2000, 20000)).toHaveLength(0);
    decisions.begin(pending.conversationId, 'p', [pending.inputId]);
    expect(intake.due(2000, 20000)).toHaveLength(0);
  });
  test('finishing an earlier input cannot consume newer prepared material', () => {
    const first = receive('first material');
    const second = receive('newer material');
    intake.consume(first.inputId);
    expect(intake.context(first.conversationId, 'p').inputIds).toEqual([first.inputId, second.inputId]);
    intake.consume(second.inputId);
    expect(store.get('SELECT count(*) n FROM conversation_intake')!.n).toBe(0);
  });
  test('a clarification is sent once while original materials survive reconstruction', () => {
    const first = receive('material');
    store.run('UPDATE conversation_intake SET clarified_seq=latest_input_seq');
    const recovered = new ConversationIntake(store);
    expect(recovered.due(2000, 20000)).toHaveLength(0);
    expect(recovered.context(first.conversationId, 'p').inputIds).toEqual([first.inputId]);
    expect(() => recovered.context(first.conversationId, 'stranger')).toThrow();
  });
});
