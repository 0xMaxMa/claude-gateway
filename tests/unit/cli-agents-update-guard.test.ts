/**
 * `agents update` re-fetches the agent list on every menu iteration, so the
 * selected agent can vanish mid-session — deleted by another operator, or
 * dropped from this key's scope by a config reload. The lookup used a non-null
 * assertion, so the next line (`agent[def.connectedKey]`) threw a bare
 * TypeError that surfaced through `runCli`'s generic handler as an opaque
 * internal error.
 */
const mockRequest = jest.fn();
const mockAsk = jest.fn();

jest.mock('../../src/cli/http-client', () => ({
  ...jest.requireActual('../../src/cli/http-client'),
  request: (...args: unknown[]) => mockRequest(...args),
  resolveUrlPlan: () => ({ baseUrl: 'http://127.0.0.1:10850' }),
  resolveReachableUrl: async (plan: { baseUrl: string }) => plan.baseUrl,
  resolveKey: () => 'sk-test',
}));
jest.mock('../../src/cli/prompt', () => ({
  createRl: () => ({ close: jest.fn() }),
  ask: (...args: unknown[]) => mockAsk(...args),
  printFilePreview: jest.fn(),
  previewAndAccept: jest.fn(),
  editInEditor: jest.fn(),
}));

import { runAgents } from '../../src/cli/commands/agents';

describe('agents update — agent disappears mid-session', () => {
  let stderr: string[];
  let errSpy: jest.SpyInstance;
  let logSpy: jest.SpyInstance;

  beforeEach(() => {
    mockRequest.mockReset();
    mockAsk.mockReset();
    stderr = [];
    errSpy = jest.spyOn(process.stderr, 'write').mockImplementation((chunk: string | Uint8Array) => {
      stderr.push(chunk.toString());
      return true;
    });
    logSpy = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  });
  afterEach(() => {
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it('reports it and exits 1 instead of throwing a TypeError', async () => {
    const present = { data: { agents: [{ id: 'alfred', telegram_connected: true }] } };
    const gone = { data: { agents: [] } };
    // First fetch validates --agent; the loop's fetch finds it gone.
    mockRequest.mockResolvedValueOnce(present).mockResolvedValue(gone);

    const code = await runAgents(['update'], { agent: 'alfred' }, {});

    expect(code).toBe(1);
    expect(stderr.join('')).toMatch(/Agent 'alfred' is no longer available/);
    // It never got as far as prompting.
    expect(mockAsk).not.toHaveBeenCalled();
  });

  it('still runs normally while the agent is present', async () => {
    const present = { data: { agents: [{ id: 'alfred', telegram_connected: true }] } };
    mockRequest.mockResolvedValue(present);
    mockAsk.mockResolvedValue('0'); // Done

    const code = await runAgents(['update'], { agent: 'alfred' }, {});

    expect(code).toBe(0);
    expect(stderr.join('')).not.toMatch(/no longer available/);
  });
});
