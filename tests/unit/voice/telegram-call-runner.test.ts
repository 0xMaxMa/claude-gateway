import { AgentRunner } from '../../../src/agent/runner';
import { voiceCallPairings } from '../../../src/voice/call-pairing';

const voiceConfig = (voiceEnabled = true, allowTools?: boolean) => ({ id: 'agent', allow_tools: allowTools,
  orchestration: { enabled: true, channels: ['telegram'] }, voice: { enabled: voiceEnabled } });

function runnerWith(agentConfig: object, publicUrl?: string) {
  const runner = Object.create(AgentRunner.prototype) as any;
  runner.agentConfig = agentConfig;
  runner.gatewayConfig = { gateway: { publicUrl } };
  return runner;
}

async function command(runner: any, body: Record<string, unknown>): Promise<{ status: number; data: any }> {
  let status = 0, payload = '';
  await runner.handleCommandRequest(JSON.stringify(body), { writeHead: (code: number) => { status = code; }, end: (text: string) => { payload = text; } });
  return { status, data: JSON.parse(payload) };
}

describe('voice_call_pair (/call)', () => {
  test('mints a pairing for the DM user and returns its link under gateway.publicUrl', async () => {
    const { status, data } = await command(runnerWith(voiceConfig(), 'https://host.example/gateway'), { command: 'voice_call_pair', chat_id: '42', payload: { user_id: '42' } });
    expect(status).toBe(200);
    const pairingId = String(data.url).match(/^https:\/\/host\.example\/gateway\/voice-call\/([0-9a-f]{36})$/)?.[1];
    expect(pairingId).toBeDefined();
    expect(voiceCallPairings.get(pairingId!)).toMatchObject({ agentId: 'agent', userId: '42', threadKey: '' });
    // Sent in a private-chat topic, the call joins that topic.
    const topic = await command(runnerWith(voiceConfig(), 'https://host.example/gateway'), { command: 'voice_call_pair', chat_id: '42', payload: { user_id: '42', thread_id: '7' } });
    expect(voiceCallPairings.get(String(topic.data.url).split('/').pop()!)).toMatchObject({ threadKey: '7' });
  });

  test('refuses group chats, disabled voice, agents without Telegram orchestration, and a missing public URL', async () => {
    const pair = { command: 'voice_call_pair', chat_id: '42', payload: { user_id: '42' } };
    // In a group the chat id is not the sender id.
    expect(await command(runnerWith(voiceConfig(), 'https://host.example/gateway'), { ...pair, chat_id: '-100' })).toEqual({ status: 400, data: { success: false, error: 'invalid_request' } });
    expect((await command(runnerWith(voiceConfig(false), 'https://host.example/gateway'), pair)).data).toEqual({ success: false, error: 'voice_not_configured' });
    expect((await command(runnerWith({ ...voiceConfig(), orchestration: { enabled: true, channels: ['api'] } }, 'https://host.example/gateway'), pair)).data).toEqual({ success: false, error: 'voice_not_configured' });
    expect((await command(runnerWith(voiceConfig()), pair)).data).toEqual({ success: false, error: 'not_configured' });
    // Telegram opens web_app buttons over HTTPS only.
    expect((await command(runnerWith(voiceConfig(), 'http://localhost:3000'), pair)).data).toEqual({ success: false, error: 'not_configured' });
    expect((await command(runnerWith(voiceConfig(), 'https://host.example'), { ...pair, payload: { user_id: '42', thread_id: 'x' } })).status).toBe(400);
  });
});

describe('submitVoiceUtterance scope', () => {
  function voiceRunner(agentConfig: object) {
    const orchestration = { submitInput: jest.fn(() => ({ inputId: 'input', response: Promise.resolve('ok') })), flushHistory: jest.fn(async () => {}), responseIdForInput: jest.fn() };
    const runner = runnerWith(agentConfig);
    runner.apiSessionExists = jest.fn(async () => true);
    runner.telegramVoiceSession = jest.fn(async () => 'session');
    runner.getOrchestration = jest.fn(async () => orchestration);
    return { runner, orchestration };
  }

  test('a Telegram call turn joins the DM conversation exactly as a typed DM message does', async () => {
    const { runner, orchestration } = voiceRunner(voiceConfig(true, undefined));
    await runner.submitVoiceUtterance('session', { kind: 'telegram', principalId: 'telegram:42', chatId: '42', threadKey: '' }, 'hello', 'utterance', true);
    expect(runner.apiSessionExists).not.toHaveBeenCalled();
    expect(orchestration.submitInput).toHaveBeenCalledWith({
      // The scope Telegram ingress builds for user 42 in their DM (runner /channel handler).
      scope: { agentId: 'agent', agentSessionId: 'session', source: 'telegram', accountId: 'agent', chatId: '42', threadKey: '', principalId: 'telegram:42' },
      text: 'hello', model: undefined, metadata: { executionTaskId: undefined }, modality: 'live_voice', ingressKey: 'utterance:utterance', trustedChannelMember: true,
    }, { execute: true, writeMemory: false }, undefined, undefined);
  });

  test('an API call turn keeps its own api conversation and still requires an existing API session', async () => {
    const { runner, orchestration } = voiceRunner(voiceConfig());
    await runner.submitVoiceUtterance('session', { kind: 'api', principalId: 'api:owner', chatId: 'chat' }, 'hello', 'utterance', false, 'model', 'task');
    expect(runner.apiSessionExists).toHaveBeenCalledWith('chat', 'session');
    expect(orchestration.submitInput).toHaveBeenCalledWith({
      scope: { agentId: 'agent', agentSessionId: 'session', source: 'api', accountId: 'api:owner', chatId: 'chat', threadKey: '', principalId: 'api:owner' },
      text: 'hello', model: 'model', metadata: { executionTaskId: 'task' }, modality: 'live_voice', ingressKey: 'utterance:utterance',
    }, { execute: false, writeMemory: false }, undefined, undefined);
    runner.apiSessionExists.mockResolvedValueOnce(false);
    await expect(runner.submitVoiceUtterance('gone', { kind: 'api', principalId: 'api:owner', chatId: 'chat' }, 'hello', 'u2', false)).rejects.toThrow('Session not found');
  });

  test('a call does not follow the chat into another session: after /new its turns are refused', async () => {
    const { runner, orchestration } = voiceRunner(voiceConfig());
    runner.telegramVoiceSession.mockResolvedValueOnce('newer-session');
    await expect(runner.submitVoiceUtterance('session', { kind: 'telegram', principalId: 'telegram:42', chatId: '42', threadKey: '' }, 'hello', 'utterance', true))
      .rejects.toMatchObject({ code: 'VOICE_SESSION_CHANGED' });
    expect(runner.telegramVoiceSession).toHaveBeenCalledWith('42');
    expect(orchestration.submitInput).not.toHaveBeenCalled();
  });

  test('a Telegram call stops submitting once the agent no longer serves Telegram', async () => {
    const { runner, orchestration } = voiceRunner({ ...voiceConfig(), orchestration: { enabled: true, channels: ['api'] } });
    await expect(runner.submitVoiceUtterance('session', { kind: 'telegram', principalId: 'telegram:42', chatId: '42', threadKey: '' }, 'hello', 'utterance', true)).rejects.toThrow('Voice is disabled');
    expect(orchestration.submitInput).not.toHaveBeenCalled();
  });
});
