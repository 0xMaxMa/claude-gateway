/**
 * Unit tests for LineReplyManager — the slow-LLM postback button state machine
 * ported from hermes-agent. The LINE SDK client and logger are mocked; the
 * slow-button timer is driven with jest fake timers.
 */
jest.mock('@line/bot-sdk', () => {
  const replyMessage = jest.fn();
  const pushMessage = jest.fn();
  return {
    messagingApi: {
      MessagingApiClient: jest.fn(() => ({ replyMessage, pushMessage })),
      __mock: { replyMessage, pushMessage },
    },
  };
});
jest.mock('../../src/logger', () => ({
  createLogger: () => ({ info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() }),
}));

import { messagingApi } from '@line/bot-sdk';
import { LineReplyManager } from '../../src/agent/line-reply-manager';

const { replyMessage, pushMessage } = (messagingApi as any).__mock as {
  replyMessage: jest.Mock;
  pushMessage: jest.Mock;
};

const CHAT = 'U123';
const THRESHOLD_S = 1; // → 1000ms timer

/** Flush pending microtasks so awaited mock calls settle. */
const tick = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function newManager() {
  return new LineReplyManager({
    agentId: 'getpod',
    logDir: '/tmp',
    accessToken: 'tok',
    thresholdSeconds: THRESHOLD_S,
  });
}

/** Pull the postback `data` JSON out of the most recent button reply. */
function lastButtonData(): any {
  const call = replyMessage.mock.calls.find(
    ([req]) => req.messages?.[0]?.type === 'template',
  );
  return JSON.parse(call![0].messages[0].template.actions[0].data);
}

beforeEach(() => {
  jest.useFakeTimers();
  replyMessage.mockReset().mockResolvedValue({});
  pushMessage.mockReset().mockResolvedValue({});
});
afterEach(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('LineReplyManager', () => {
  test('1. fast answer → free reply, no button, no push', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    await m.onAnswer(CHAT, 'hello');
    await tick();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(replyMessage.mock.calls[0][0]).toMatchObject({ replyToken: 'rt-1' });
    expect(replyMessage.mock.calls[0][0].messages[0]).toEqual({ type: 'text', text: 'hello' });
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('2. slow answer → Template Buttons sent via reply token, then answer cached (no push)', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    // Button sent via the reply token.
    expect(replyMessage).toHaveBeenCalledTimes(1);
    const sent = replyMessage.mock.calls[0][0];
    expect(sent.replyToken).toBe('rt-1');
    expect(sent.messages[0].type).toBe('template');
    expect(sent.messages[0].template.type).toBe('buttons');
    expect(lastButtonData()).toMatchObject({ action: 'show_response' });
    expect(lastButtonData().request_id).toBeTruthy();
    // Answer arrives after the button → cached, nothing more sent.
    await m.onAnswer(CHAT, 'the answer');
    await tick();
    expect(replyMessage).toHaveBeenCalledTimes(1); // still just the button
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('3. tap after ready → cached answer delivered free via fresh token', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    const data = lastButtonData();
    await m.onAnswer(CHAT, 'the answer');
    await tick();

    const handled = await m.handlePostback(CHAT, 'rt-fresh', JSON.stringify(data));
    await tick();
    expect(handled).toBe(true);
    const deliver = replyMessage.mock.calls.at(-1)![0];
    expect(deliver.replyToken).toBe('rt-fresh');
    expect(deliver.messages[0]).toEqual({ type: 'text', text: 'the answer' });
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('4. tap before ready → "still thinking", then next tap delivers', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    const data = lastButtonData();

    // Tap while still PENDING.
    await m.handlePostback(CHAT, 'rt-fresh1', JSON.stringify(data));
    await tick();
    const pendingReply = replyMessage.mock.calls.at(-1)![0];
    expect(pendingReply.replyToken).toBe('rt-fresh1');
    expect(pendingReply.messages[0].text).toMatch(/thinking/i);

    // Answer arrives, then tap again → delivered.
    await m.onAnswer(CHAT, 'final');
    await m.handlePostback(CHAT, 'rt-fresh2', JSON.stringify(data));
    await tick();
    const deliver = replyMessage.mock.calls.at(-1)![0];
    expect(deliver.replyToken).toBe('rt-fresh2');
    expect(deliver.messages[0].text).toBe('final');
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('5. never taps → no push (answer waits in cache)', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    await m.onAnswer(CHAT, 'cached forever');
    await tick();
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('6. rapid messages → only one button per chat', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    m.onInbound(CHAT, 'rt-2'); // second turn before first button consumed
    jest.advanceTimersByTime(1000);
    await tick();
    const buttons = replyMessage.mock.calls.filter(([r]) => r.messages?.[0]?.type === 'template');
    expect(buttons).toHaveLength(1); // one outstanding button per chat
    m.disposeAll();
  });

  test('6b. consecutive slow turns: prior answered+untapped button does not swallow the 2nd answer', async () => {
    const m = newManager();
    // Turn 1: slow → button, answered (READY), never tapped.
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    const data1 = lastButtonData();
    await m.onAnswer(CHAT, 'answer-1');
    await tick();

    // Turn 2: new inbound supersedes the resolved button → fires its OWN button.
    m.onInbound(CHAT, 'rt-2');
    jest.advanceTimersByTime(1000);
    await tick();
    const buttons = () =>
      replyMessage.mock.calls.filter(([r]) => r.messages?.[0]?.type === 'template');
    expect(buttons()).toHaveLength(2); // turn 2 got its own button (not blocked)
    await m.onAnswer(CHAT, 'answer-2');
    await tick();

    // Old button still delivers turn-1's answer …
    await m.handlePostback(CHAT, 'rt-fresh-1', JSON.stringify(data1));
    await tick();
    expect(replyMessage.mock.calls.at(-1)![0].messages[0].text).toBe('answer-1');
    // … and the new button delivers turn-2's answer (would be lost before the fix).
    const data2 = JSON.parse(buttons().at(-1)![0].messages[0].template.actions[0].data);
    await m.handlePostback(CHAT, 'rt-fresh-2', JSON.stringify(data2));
    await tick();
    expect(replyMessage.mock.calls.at(-1)![0].messages[0].text).toBe('answer-2');
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('8b. interrupt AFTER answer cached → READY preserved, tap still delivers the answer', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    const data = lastButtonData();
    await m.onAnswer(CHAT, 'real answer'); // READY
    await tick();
    // proc 'exit' fires after a normal answered turn → markInterrupted must NOT
    // clobber a READY entry (this is the safety property the runner relies on).
    m.markInterrupted(CHAT);
    await m.handlePostback(CHAT, 'rt-fresh', JSON.stringify(data));
    await tick();
    expect(replyMessage.mock.calls.at(-1)![0].messages[0].text).toBe('real answer');
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('7. reply token rejected → push fallback (fast path)', async () => {
    replyMessage.mockRejectedValueOnce(new Error('Invalid reply token'));
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    await m.onAnswer(CHAT, 'hello');
    await tick();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(pushMessage).toHaveBeenCalledTimes(1);
    expect(pushMessage.mock.calls[0][0]).toMatchObject({ to: CHAT });
    m.disposeAll();
  });

  test('8. interrupted → tap returns the interrupted notice', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    jest.advanceTimersByTime(1000);
    await tick();
    const data = lastButtonData();
    m.markInterrupted(CHAT);
    await m.handlePostback(CHAT, 'rt-fresh', JSON.stringify(data));
    await tick();
    const reply = replyMessage.mock.calls.at(-1)![0];
    expect(reply.messages[0].text).toMatch(/interrupted/i);
    m.disposeAll();
  });

  test('9. double-fire (tool_use + result) → answer sent once', async () => {
    const m = newManager();
    m.onInbound(CHAT, 'rt-1');
    await m.onAnswer(CHAT, 'hello');
    await m.onAnswer(CHAT, 'hello'); // result fallback, same turn
    await tick();
    expect(replyMessage).toHaveBeenCalledTimes(1);
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('foreign postback (not ours) → returns false, nothing sent', async () => {
    const m = newManager();
    const handled = await m.handlePostback(CHAT, 'rt-x', JSON.stringify({ action: 'other' }));
    expect(handled).toBe(false);
    expect(replyMessage).not.toHaveBeenCalled();
    expect(pushMessage).not.toHaveBeenCalled();
    m.disposeAll();
  });

  test('non-JSON postback data → returns false', async () => {
    const m = newManager();
    expect(await m.handlePostback(CHAT, 'rt-x', 'not json')).toBe(false);
    m.disposeAll();
  });

  describe('armButton:false (group/room — button disabled, answer still delivers)', () => {
    test('no button fires even after the threshold elapses', async () => {
      const m = newManager();
      m.onInbound('G1', 'rt-g', { armButton: false });
      jest.advanceTimersByTime(THRESHOLD_S * 1000 + 50);
      await tick();
      expect(replyMessage).not.toHaveBeenCalled();
      m.disposeAll();
    });

    test('fast answer still delivers via the stashed reply token (free, plain text)', async () => {
      const m = newManager();
      m.onInbound('G1', 'rt-g', { armButton: false });
      await m.onAnswer('G1', 'hi group');
      await tick();
      expect(replyMessage).toHaveBeenCalledTimes(1);
      expect(replyMessage.mock.calls[0][0]).toMatchObject({ replyToken: 'rt-g' });
      expect(replyMessage.mock.calls[0][0].messages[0].type).toBe('text');
      m.disposeAll();
    });

    test('answer after the token expires falls back to push (to the group id)', async () => {
      const m = newManager();
      m.onInbound('G1', 'rt-g', { armButton: false });
      jest.advanceTimersByTime(60_000); // let the reply-token TTL lapse
      await m.onAnswer('G1', 'late answer');
      await tick();
      expect(pushMessage).toHaveBeenCalledTimes(1);
      expect(pushMessage.mock.calls[0][0]).toMatchObject({ to: 'G1' });
      m.disposeAll();
    });
  });
});
