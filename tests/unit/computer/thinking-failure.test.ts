import { thinkingFailure } from '../../../src/jev/thinking-provider';
import { JevError } from '../../../src/jev/types';
import { COMPUTER_MODEL_OAUTH_UNSUPPORTED } from '../../../src/automation/model-choice-evaluator';

describe('thinkingFailure', () => {
  test('keeps THINKING_* provider codes', () => expect(thinkingFailure(Error('THINKING_HTTP_429')).message).toBe('THINKING_HTTP_429'));
  test('keeps the Computer Use OAuth code so the user sees what to fix', () => expect(thinkingFailure(Error(COMPUTER_MODEL_OAUTH_UNSUPPORTED)).message).toBe(COMPUTER_MODEL_OAUTH_UNSUPPORTED));
  test('keeps INVALID_CONFIG from endpoint/identity resolution', () => expect(thinkingFailure(new JevError('INVALID_CONFIG', 'secret detail')).message).toBe('INVALID_CONFIG'));
  test('anything else collapses to THINKING_PROVIDER_FAILED without leaking its message', () => {
    expect(thinkingFailure(Error('connect ECONNREFUSED 10.0.0.1')).message).toBe('THINKING_PROVIDER_FAILED');
    expect(thinkingFailure('x').message).toBe('THINKING_PROVIDER_FAILED');
  });
});
