jest.mock('../../../src/config/claude-settings', () => ({ claudeSettingsEnv: jest.fn() }));
import { claudeSettingsEnv } from '../../../src/config/claude-settings';
import { configureLogging, resetLoggingForTests } from '../../../src/logger';
import { agentIdentity, computerDecisions } from '../../../src/orchestration/jev-gateway';
import { computerEvaluator, computerThinking } from '../../../src/orchestration/computer-decisions';
import { COMPUTER_MODEL_OAUTH_UNSUPPORTED, DEFAULT_COMPUTER_MODEL } from '../../../src/automation/model-choice-evaluator';
import type { AgentConfig, GatewayConfig } from '../../../src/types';

const settings = claudeSettingsEnv as jest.Mock;
const TOKEN = 'sk-ant-test-not-real';
const gatewayConfig = (jev?: boolean, computerTasks?: boolean, computerUse?: boolean, extra: Record<string, unknown> = {}) => ({
  gateway: { logDir: '/tmp/never-written', ...(jev === undefined ? {} : { jev: { enabled: jev, ...(computerTasks === undefined ? {} : { features: { computerTasks: { enabled: computerTasks } } }) } }), ...(computerUse === undefined ? {} : { computerUse: { enabled: computerUse, ...extra } }) },
}) as unknown as GatewayConfig;
const agentConfig = (extra: Partial<AgentConfig> = {}) => ({ id: 'agent-a', ...extra }) as AgentConfig;
const task = { taskId: 't1', ownerPrincipalId: 'p', agentSessionId: 's', conversationId: 'c' } as any;
const request = { requestId: 'r1', state: { goal: 'x' }, questions: { action: { type: 'choice', instructions: { g: 'pick' }, criteria: { 'press:k1': 'press 5', DONE: 'done' } } } } as any;
const jevAnswer = { answers: { action: { type: 'choice', choice: '0', confidence: 0.9, probabilities: { '0': 0.9, '1': 0.1 } } } };

beforeEach(() => settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.getpod.test', ANTHROPIC_AUTH_TOKEN: TOKEN }));
afterEach(() => jest.restoreAllMocks());

describe('computerAllowed matrix', () => {
  // [jev.enabled, features.computerTasks, computerUse.enabled, agent override] → backend
  test.each([
    [undefined, undefined, undefined, {}, undefined],
    [false, undefined, undefined, {}, undefined],
    [undefined, undefined, false, {}, undefined],
    [true, undefined, undefined, {}, 'jev'],
    [true, false, undefined, {}, undefined],
    [true, undefined, true, {}, 'jev'],
    [true, false, true, {}, 'model'],
    [false, undefined, true, {}, 'model'],
    [undefined, undefined, true, {}, 'model'],
    [undefined, undefined, true, { computerUse: { enabled: false } }, undefined],
    [undefined, undefined, true, { computerUse: { enabled: true } }, 'model'],
    [undefined, undefined, undefined, { computerUse: { enabled: true } }, undefined],
    [true, undefined, true, { allow_tools: false }, undefined],
    [false, undefined, true, { allow_tools: false }, undefined],
    [true, undefined, true, { jev: { enabled: false } }, 'model'],
    [true, undefined, undefined, { jev: { enabled: false } }, undefined],
  ] as const)('jev=%s computerTasks=%s computerUse=%s agent=%j → %s', (jev, computerTasks, computerUse, agent, expected) => {
    expect(computerDecisions(gatewayConfig(jev, computerTasks, computerUse), agentConfig(agent as Partial<AgentConfig>))).toBe(expected);
  });
  test('jev allowedAgentIds excluding the agent falls back to the model backend only when opted in', () => {
    const config = gatewayConfig(true, undefined, true); (config.gateway.jev as any).allowedAgentIds = ['other'];
    expect(computerDecisions(config, agentConfig())).toBe('model');
    delete (config.gateway as any).computerUse;
    expect(computerDecisions(config, agentConfig())).toBeUndefined();
  });
});

describe('decision dispatch', () => {
  test('regression: with Jev on, every decision goes to the Jev service unchanged and the model is never called', async () => {
    const evaluate = jest.fn(async (wire: any, options: any) => { expect(options).toMatchObject({ consumer: 'computer', agentId: 'agent-a', taskId: 't1', principalId: 'p', sessionId: 's' }); expect(options.authorize()).toBe(true); expect(Object.keys(wire.questions.action.criteria)).toEqual(['0', '1']); return jevAnswer as any; });
    const fetch = jest.fn();
    for (const computerUse of [undefined, true]) {
      const run = computerEvaluator(gatewayConfig(true, undefined, computerUse), agentConfig(), () => true, () => ({ evaluate }), fetch as any);
      const result = await run(task, request, new AbortController().signal);
      expect((result.answers.action as any).choice).toBe('press:k1');
    }
    expect(evaluate).toHaveBeenCalledTimes(2);
    expect(fetch).not.toHaveBeenCalled();
    expect(computerThinking(gatewayConfig(true, undefined, true), agentConfig())).toBeUndefined();
  });

  test('with Jev off and computerUse on, the agent identity calls the default Haiku model; Jev is never touched', async () => {
    const jev = jest.fn();
    const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    const fetch = jest.fn(async (url: URL, init: RequestInit) => {
      expect(String(url)).toBe('https://api.getpod.test/v1/messages');
      expect((init.headers as Record<string, string>).authorization).toBe('Bearer ' + TOKEN);
      expect(JSON.parse(String(init.body)).model).toBe(DEFAULT_COMPUTER_MODEL);
      return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'answer', input: { action: { choice: '0', confidence: 0.9 } } }], usage: { input_tokens: 10, output_tokens: 5 } }), { headers: { 'content-type': 'application/json' } });
    });
    const run = computerEvaluator(gatewayConfig(false, undefined, true), agentConfig(), () => true, jev as any, fetch as any);
    const result = await run(task, request, new AbortController().signal);
    expect((result.answers.action as any)).toMatchObject({ choice: 'press:k1', confidence: 0.9 });
    expect(jev).not.toHaveBeenCalled();
    expect(fetch).toHaveBeenCalledTimes(1);
    // Successful decisions go through the Logger at debug level, not console.log.
    expect(log).not.toHaveBeenCalled();
    const lines: string[] = [];
    configureLogging({ level: 'debug' } as any);
    jest.spyOn(process.stdout, 'write').mockImplementation((chunk: any) => { lines.push(String(chunk)); return true; });
    await run(task, request, new AbortController().signal);
    const logged = lines.join('\n');
    expect(logged).toContain('computer_model_evaluation');
    expect(logged).toContain('"level": "debug"');
    expect(logged).not.toContain(TOKEN);
    resetLoggingForTests();
  });

  test('switching the backend or losing membership mid-call revokes the decision', async () => {
    jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = gatewayConfig(false, undefined, true);
    const fetch = jest.fn(async () => { (config.gateway as any).computerUse.enabled = false; return new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'answer', input: { action: { choice: '0', confidence: 0.9 } } }] }), { headers: { 'content-type': 'application/json' } }); });
    await expect(computerEvaluator(config, agentConfig(), () => true, undefined, fetch as any)(task, request, new AbortController().signal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    const nonMember = jest.fn();
    await expect(computerEvaluator(gatewayConfig(false, undefined, true), agentConfig(), () => false, undefined, nonMember as any)(task, request, new AbortController().signal)).rejects.toMatchObject({ code: 'ACCESS_DENIED' });
    expect(nonMember).not.toHaveBeenCalled();
  });

  test('Thinking fallback uses the same identity and configured model only on the model backend', async () => {
    expect(computerThinking(gatewayConfig(false), agentConfig())).toBeUndefined();
    const configured = { api: 'openai-chat', baseUrl: 'https://think.test/v1', model: 'm', apiKeyEnv: 'X' } as any;
    const withHelper = gatewayConfig(false, undefined, true); (withHelper.gateway as any).jev = { enabled: false, thinking: configured };
    expect(computerThinking(withHelper, agentConfig())).toBe(configured);
    const fallback = computerThinking(gatewayConfig(false, undefined, true, { model: 'claude-sonnet-5' }), agentConfig()) as { resolve: () => Promise<any> };
    const resolved = await fallback.resolve();
    expect(resolved).toEqual({ api: 'anthropic-messages', baseUrl: 'https://api.getpod.test/v1', model: 'claude-sonnet-5', apiKey: TOKEN, authScheme: 'bearer' });
  });

  describe('credential paths', () => {
    const ok = () => new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'answer', input: { action: { choice: '0', confidence: 0.9 } } }] }), { headers: { 'content-type': 'application/json' } });
    const sent = async (identity: Record<string, string>) => {
      settings.mockReturnValue(identity);
      jest.spyOn(console, 'log').mockImplementation(() => undefined);
      const fetch = jest.fn(async (_url: URL, _init: RequestInit) => ok());
      await computerEvaluator(gatewayConfig(false, undefined, true), agentConfig(), () => true, undefined, fetch as any)(task, request, new AbortController().signal);
      const [url, init] = fetch.mock.calls[0];
      return { url: String(url), headers: init.headers as Record<string, string> };
    };
    test('API key: x-api-key only, direct to Anthropic', async () => {
      const { url, headers } = await sent({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: TOKEN });
      expect(url).toBe('https://api.anthropic.com/v1/messages');
      expect(headers['x-api-key']).toBe(TOKEN);
      expect(headers.authorization).toBeUndefined();
      expect(headers['anthropic-version']).toBe('2023-06-01');
    });
    test('ANTHROPIC_AUTH_TOKEN on the gateway proxy route: Bearer only, path preserved', async () => {
      const { url, headers } = await sent({ ANTHROPIC_BASE_URL: 'https://proxy.getpod.test/anthropic', ANTHROPIC_AUTH_TOKEN: TOKEN });
      expect(url).toBe('https://proxy.getpod.test/anthropic/v1/messages');
      expect(headers.authorization).toBe('Bearer ' + TOKEN);
      expect(headers['x-api-key']).toBeUndefined();
    });
    test('OAuth token on a proxy route: Bearer, as the upstream voice connection sends it', async () => {
      const { headers } = await sent({ ANTHROPIC_BASE_URL: 'https://proxy.getpod.test', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      expect(headers.authorization).toBe('Bearer ' + TOKEN);
      expect(headers['x-api-key']).toBeUndefined();
    });
    test('OAuth token direct to Anthropic: refused with COMPUTER_MODEL_OAUTH_UNSUPPORTED before any request, token never logged', async () => {
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetch = jest.fn();
      const error = await computerEvaluator(gatewayConfig(false, undefined, true), agentConfig(), () => true, undefined, fetch as any)(task, request, new AbortController().signal).catch(e => e);
      expect(error).toBeInstanceOf(Error);
      expect(error.message).toBe(COMPUTER_MODEL_OAUTH_UNSUPPORTED);
      expect(fetch).not.toHaveBeenCalled();
      const logged = warn.mock.calls.map(c => String(c[0])).join('\n');
      expect(logged).toContain(`"errorCode":"${COMPUTER_MODEL_OAUTH_UNSUPPORTED}"`);
      expect(logged).not.toContain(TOKEN);
    });
    test('Thinking fallback refuses an OAuth token sent directly to Anthropic', async () => {
      const thinking = () => (computerThinking(gatewayConfig(false, undefined, true), agentConfig()) as { resolve: () => Promise<any> }).resolve();
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      await expect(thinking()).rejects.toThrow(COMPUTER_MODEL_OAUTH_UNSUPPORTED);
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: TOKEN });
      await expect(thinking()).resolves.toMatchObject({ baseUrl: 'https://api.anthropic.com/v1', apiKey: TOKEN });
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://proxy.getpod.test', CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      await expect(thinking()).resolves.toMatchObject({ baseUrl: 'https://proxy.getpod.test/v1' });
    });
    test('Thinking fallback carries the identity scheme so ANTHROPIC_AUTH_TOKEN is sent as Bearer', async () => {
      const thinking = () => (computerThinking(gatewayConfig(false, undefined, true), agentConfig()) as { resolve: () => Promise<any> }).resolve();
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://proxy.getpod.test/anthropic', ANTHROPIC_AUTH_TOKEN: TOKEN });
      await expect(thinking()).resolves.toMatchObject({ apiKey: TOKEN, authScheme: 'bearer' });
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: TOKEN });
      await expect(thinking()).resolves.toMatchObject({ apiKey: TOKEN, authScheme: 'x-api-key' });
    });
  });

  describe('fail-closed dispatch and hostname normalization', () => {
    test('with Computer Use off, no backend is reachable: COMPUTER_NOT_ALLOWED, Jev and model never called', async () => {
      const evaluate = jest.fn(), fetch = jest.fn();
      for (const config of [gatewayConfig(undefined, undefined, undefined), gatewayConfig(false, undefined, false), gatewayConfig(true, false, undefined)]) {
        const error = await computerEvaluator(config, agentConfig(), () => true, () => ({ evaluate }), fetch as any)(task, request, new AbortController().signal).catch(e => e);
        expect(error).toMatchObject({ message: 'COMPUTER_NOT_ALLOWED' });
      }
      expect(evaluate).not.toHaveBeenCalled(); expect(fetch).not.toHaveBeenCalled();
    });
    test('authorize handed to Jev is revoked when the backend goes away mid-task (undefined !== jev)', async () => {
      const config = gatewayConfig(true, undefined, undefined);
      let seen: (() => boolean) | undefined;
      const evaluate = jest.fn(async (_w: any, o: any) => { seen = o.authorize; return jevAnswer; });
      await computerEvaluator(config, agentConfig(), () => true, () => ({ evaluate } as any))(task, request, new AbortController().signal);
      expect(seen!()).toBe(true);
      delete (config.gateway as any).jev;
      expect(seen!()).toBe(false);
    });
    test.each(['https://api.anthropic.com./', 'https://API.ANTHROPIC.COM../v1', 'https://anthropic.com./'])('OAuth token to %s is still refused as direct Anthropic', async base => {
      settings.mockReturnValue({ ANTHROPIC_BASE_URL: base, CLAUDE_CODE_OAUTH_TOKEN: TOKEN });
      jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      const fetch = jest.fn();
      const error = await computerEvaluator(gatewayConfig(false, undefined, true), agentConfig(), () => true, undefined, fetch as any)(task, request, new AbortController().signal).catch(e => e);
      expect(error.message).toBe(COMPUTER_MODEL_OAUTH_UNSUPPORTED);
      expect(fetch).not.toHaveBeenCalled();
    });
  });

  test('an incomplete identity group fails as INVALID_CONFIG, naming Computer Use, without borrowing env credentials', () => {
    settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.getpod.test' });
    expect(() => agentIdentity('Computer Use')).toThrow(/Computer Use requires a complete endpoint/);
    settings.mockReturnValue({ ANTHROPIC_BASE_URL: 'https://api.anthropic.com', ANTHROPIC_API_KEY: TOKEN });
    expect(agentIdentity()).toMatchObject({ scheme: 'x-api-key' });
  });
  test('an unwritable logDir is reported once without changing the decision or leaking secrets', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = gatewayConfig(false, undefined, true);
    (config.gateway as any).logDir = '/dev/null/cannot-create';
    const fetch = jest.fn(async () => new Response(JSON.stringify({ stop_reason: 'tool_use', content: [{ type: 'tool_use', name: 'answer', input: { action: { choice: '0', confidence: 0.9 } } }] }), { headers: { 'content-type': 'application/json' } }));
    const run = computerEvaluator(config, agentConfig(), () => true, undefined, fetch as any);
    for (let i = 0; i < 2; i++) {
      const result = await run(task, request, new AbortController().signal);
      expect((result.answers.action as any)).toMatchObject({ choice: 'press:k1', confidence: 0.9 });
    }
    const lines = warn.mock.calls.map(call => String(call[0])).filter(line => line.includes('computer_model_log_unavailable'));
    expect(lines).toHaveLength(1);
    expect(lines.join('')).not.toContain(TOKEN);
  });

});
