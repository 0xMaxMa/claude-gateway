import { modelAuthHeaders, wireAuthScheme, type ModelConnection } from '../../../src/automation/model-choice-evaluator';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { anthropicCredentialHeader } = require('../../../lib/automation/thinking.cjs');

// lib/automation/thinking.cjs cannot import TS, so it keeps its own scheme -> header mapping.
// This pins the two copies together: the TS path (modelAuthHeaders) and the CJS path (Thinking
// helper fed wireAuthScheme) must send the same credential header for every identity scheme.
const lower = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));

describe('auth scheme parity between modelAuthHeaders (TS) and thinking.cjs', () => {
  test.each(['x-api-key', 'bearer', 'oauth'] as const)('%s yields identical credential headers', scheme => {
    const connection: ModelConnection = { baseUrl: 'https://proxy.example.test', apiKey: 'k-test', scheme };
    const viaTs = lower(modelAuthHeaders(connection, new URL('https://proxy.example.test/v1/messages')));
    const viaCjs = lower(anthropicCredentialHeader({ apiKey: connection.apiKey, authScheme: wireAuthScheme(connection) }));
    expect(viaCjs).toEqual(viaTs);
  });
});
