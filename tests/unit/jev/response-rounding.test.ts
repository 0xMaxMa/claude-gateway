import { validateJevResponse } from '../../../src/jev/validation';
import { JevRequest } from '../../../src/jev/types';

const request: JevRequest = {
  state: 'The user explicitly requests opening help.',
  questions: { clarity: { type: 'score', instructions: 'How explicit is the request?', criteria: ['Unclear', 'Partly clear', 'Explicit'] } },
};
// Observed from a real TypeSafe response: score and probabilities round separately.
const response = {
  model: 'jev-1.13.0',
  answers: { clarity: { type: 'score', score: 1.99, confidence: 0.99,
    legend: { '0': 'Unclear', '1': 'Partly clear', '2': 'Explicit' },
    probabilities: { '0': 0, '1': 0, '2': 1 } } },
  usage: { input_tokens: 392, output_tokens: 62 },
};

test('accepts the observed rounded score at the tolerance boundary without rewriting usage or score', () => {
  const result = validateJevResponse(response, request, 'jev-1.13.0', 'rounding');
  expect(result.answers.clarity).toEqual(response.answers.clarity);
  expect(result.usage).toEqual(response.usage);
});

test.each([1.989, 1.9, 2.001, -0.001])('still rejects an inconsistent or out-of-range score %s', score => {
  const changed = structuredClone(response);
  changed.answers.clarity.score = score;
  expect(() => validateJevResponse(changed, request, 'jev-1.13.0', 'rounding')).toThrow();
});

test('still rejects invalid probability mass', () => {
  const changed = structuredClone(response);
  changed.answers.clarity.probabilities['2'] = 0.9;
  expect(() => validateJevResponse(changed, request, 'jev-1.13.0', 'rounding')).toThrow();
});
