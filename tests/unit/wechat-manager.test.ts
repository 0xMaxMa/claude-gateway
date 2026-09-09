/**
 * Unit tests for src/wechat/manager.ts. The `ILinkClient` is always mocked —
 * there is no real iLink account to test against (see the module doc comment
 * on src/wechat/ilink-client.ts) — so these tests exercise the manager's own
 * state machine, chunking, de-dup, and backoff logic in isolation.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  WeChatManager,
  chunkWeChatText,
  isWeChatChannelEnabled,
  WECHAT_MAX_MESSAGE_LENGTH,
  hasSavedWeChatSession,
} from '../../src/wechat/manager';
import { ILinkClient, ILinkCredentials } from '../../src/wechat/ilink-client';
import { AgentConfig } from '../../src/types';

const FAST_TIMING = {
  pollTimeoutSeconds: 1,
  pollBackoffBaseMs: 5,
  pollBackoffMaxMs: 20,
  linkAttemptTimeoutMs: 200,
  linkPollIntervalMs: 5,
  // Bounds how many times a mock `getUpdates` (which resolves instantly,
  // unlike the real 35s long-poll) can spin per test — without this, a tight
  // loop against an instantly-resolving mock exhausts the heap in seconds.
  pollIdleDelayMs: 5,
};

function makeAgentConfig(workspace: string): AgentConfig {
  return {
    id: 'test-agent',
    description: 'test',
    workspace,
    env: 'test',
    claude: { model: 'claude', extraFlags: [] },
  };
}

function makeClient(overrides: Partial<ILinkClient> = {}): jest.Mocked<ILinkClient> {
  return {
    requestLinkQr: jest.fn().mockResolvedValue({ qrDataUri: 'data:image/png;base64,QR', loginSessionId: 's1' }),
    pollLinkStatus: jest.fn().mockResolvedValue({ linked: false }),
    getUpdates: jest.fn().mockResolvedValue([]),
    sendText: jest.fn().mockResolvedValue({ contextToken: 'ctx-1' }),
    ...overrides,
  } as jest.Mocked<ILinkClient>;
}

const CREDS: ILinkCredentials = { accountId: 'acct-1', token: 'tok-1', baseUrl: 'https://example.test' };

describe('chunkWeChatText()', () => {
  test('text at or under the limit is returned as a single chunk', () => {
    expect(chunkWeChatText('hello')).toEqual(['hello']);
    const exact = 'a'.repeat(WECHAT_MAX_MESSAGE_LENGTH);
    expect(chunkWeChatText(exact)).toEqual([exact]);
  });

  test('text over the limit splits on the nearest newline', () => {
    const text = 'a'.repeat(3990) + '\n' + 'b'.repeat(20);
    const chunks = chunkWeChatText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe('a'.repeat(3990));
    expect(chunks[1]).toBe('b'.repeat(20));
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(WECHAT_MAX_MESSAGE_LENGTH);
  });

  test('a single line with no newlines hard-cuts at the limit', () => {
    const text = 'x'.repeat(WECHAT_MAX_MESSAGE_LENGTH + 500);
    const chunks = chunkWeChatText(text);
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toHaveLength(WECHAT_MAX_MESSAGE_LENGTH);
    expect(chunks[1]).toHaveLength(500);
  });
});

describe('isWeChatChannelEnabled()', () => {
  const original = process.env.WECHAT_CHANNEL_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.WECHAT_CHANNEL_ENABLED;
    else process.env.WECHAT_CHANNEL_ENABLED = original;
  });

  test('false when unset', () => {
    delete process.env.WECHAT_CHANNEL_ENABLED;
    expect(isWeChatChannelEnabled()).toBe(false);
  });
  test('false for any value other than the literal string "true"', () => {
    process.env.WECHAT_CHANNEL_ENABLED = 'TRUE';
    expect(isWeChatChannelEnabled()).toBe(false);
    process.env.WECHAT_CHANNEL_ENABLED = '1';
    expect(isWeChatChannelEnabled()).toBe(false);
  });
  test('true only for the literal string "true"', () => {
    process.env.WECHAT_CHANNEL_ENABLED = 'true';
    expect(isWeChatChannelEnabled()).toBe(true);
  });
});

describe('WeChatManager', () => {
  let workspace: string;
  const original = process.env.WECHAT_CHANNEL_ENABLED;

  beforeEach(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), 'wechat-manager-test-'));
    process.env.WECHAT_CHANNEL_ENABLED = 'true';
  });

  afterEach(() => {
    fs.rmSync(workspace, { recursive: true, force: true });
    if (original === undefined) delete process.env.WECHAT_CHANNEL_ENABLED;
    else process.env.WECHAT_CHANNEL_ENABLED = original;
  });

  test('starts unlinked with no QR', () => {
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', makeClient());
    expect(manager.getStatus()).toEqual({ status: 'unlinked', qr: undefined, loggedOut: false });
  });

  test('startLinking() throws when the channel kill switch is off', async () => {
    delete process.env.WECHAT_CHANNEL_ENABLED;
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', makeClient());
    await expect(manager.startLinking()).rejects.toThrow(/WECHAT_CHANNEL_ENABLED/);
  });

  test('startLinking() shows the QR, then transitions to linked once iLink confirms', async () => {
    const client = makeClient({
      pollLinkStatus: jest
        .fn()
        .mockResolvedValueOnce({ linked: false })
        .mockResolvedValueOnce({ linked: true, credentials: CREDS }),
    });
    const onMessage = jest.fn();
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', client, onMessage, FAST_TIMING);

    await manager.startLinking();

    expect(manager.getStatus()).toEqual({ status: 'linked', qr: undefined, loggedOut: false });
    expect(client.requestLinkQr).toHaveBeenCalledTimes(1);
    expect(client.pollLinkStatus).toHaveBeenCalledWith('s1');
    expect(hasSavedWeChatSession(workspace)).toBe(true);

    await manager.unlink();
  });

  test('a QR scan that never completes reverts to unlinked once the attempt window elapses', async () => {
    const client = makeClient({ pollLinkStatus: jest.fn().mockResolvedValue({ linked: false }) });
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', client, undefined, {
      ...FAST_TIMING,
      linkAttemptTimeoutMs: 15,
      linkPollIntervalMs: 5,
    });

    await manager.startLinking();

    expect(manager.getStatus().status).toBe('unlinked');
    expect(hasSavedWeChatSession(workspace)).toBe(false);
  });

  test('delivers each inbound message once and drops a redelivered duplicate id', async () => {
    const client = makeClient({
      pollLinkStatus: jest.fn().mockResolvedValueOnce({ linked: true, credentials: CREDS }),
      getUpdates: jest
        .fn()
        .mockResolvedValueOnce([{ id: 'm1', fromId: 'u1', text: 'hi' }])
        .mockResolvedValueOnce([{ id: 'm1', fromId: 'u1', text: 'hi' }]) // redelivered — must be dropped
        .mockResolvedValueOnce([{ id: 'm2', fromId: 'u1', text: 'again' }])
        .mockResolvedValue([]),
    });
    const onMessage = jest.fn();
    const manager = new WeChatManager(
      makeAgentConfig(workspace),
      '/tmp',
      client,
      onMessage,
      { ...FAST_TIMING, linkPollIntervalMs: 1 },
    );

    await manager.startLinking();
    await waitUntil(() => onMessage.mock.calls.length >= 2);

    expect(onMessage).toHaveBeenCalledTimes(2);
    expect(onMessage.mock.calls[0][0].id).toBe('m1');
    expect(onMessage.mock.calls[1][0].id).toBe('m2');

    await manager.unlink();
  });

  test('backs off after a getUpdates failure, reports reconnecting, then recovers', async () => {
    let calls = 0;
    const client = makeClient({
      pollLinkStatus: jest.fn().mockResolvedValueOnce({ linked: true, credentials: CREDS }),
      getUpdates: jest.fn().mockImplementation(() => {
        calls += 1;
        if (calls === 1) return Promise.reject(new Error('transport error'));
        return Promise.resolve([]);
      }),
    });
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', client, undefined, {
      ...FAST_TIMING,
      linkPollIntervalMs: 1,
    });

    await manager.startLinking();
    await waitUntil(() => calls >= 2);
    await waitUntil(() => manager.getStatus().status === 'linked');

    expect(manager.getStatus().status).toBe('linked');
    await manager.unlink();
  });

  test('sendMessage chunks long text and echoes the returned contextToken on the next send', async () => {
    const client = makeClient({
      pollLinkStatus: jest.fn().mockResolvedValueOnce({ linked: true, credentials: CREDS }),
      sendText: jest
        .fn()
        .mockResolvedValueOnce({ contextToken: 'ctx-a' })
        .mockResolvedValueOnce({ contextToken: 'ctx-b' }),
    });
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', client, undefined, FAST_TIMING);
    await manager.startLinking();

    const longText = 'a'.repeat(3990) + '\n' + 'b'.repeat(20);
    await manager.sendMessage('u1', longText);

    expect(client.sendText).toHaveBeenCalledTimes(2);
    expect(client.sendText).toHaveBeenNthCalledWith(1, CREDS, 'u1', 'a'.repeat(3990), undefined);
    expect(client.sendText).toHaveBeenNthCalledWith(2, CREDS, 'u1', 'b'.repeat(20), 'ctx-a');

    await manager.unlink();
  });

  test('sendMessage throws when no account is linked', async () => {
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', makeClient());
    await expect(manager.sendMessage('u1', 'hi')).rejects.toThrow(/not linked/);
  });

  test('unlink() stops the poll loop and wipes the saved session', async () => {
    const client = makeClient({
      pollLinkStatus: jest.fn().mockResolvedValueOnce({ linked: true, credentials: CREDS }),
    });
    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', client, undefined, FAST_TIMING);
    await manager.startLinking();
    expect(hasSavedWeChatSession(workspace)).toBe(true);

    await manager.unlink();

    expect(manager.getStatus()).toEqual({ status: 'unlinked', qr: undefined, loggedOut: false });
    expect(hasSavedWeChatSession(workspace)).toBe(false);
    await expect(manager.sendMessage('u1', 'hi')).rejects.toThrow(/not linked/);
  });

  test('resumeIfLinked() restores a session persisted by a prior instance and resumes polling', async () => {
    const client1 = makeClient({
      pollLinkStatus: jest.fn().mockResolvedValueOnce({ linked: true, credentials: CREDS }),
    });
    const agentConfig = makeAgentConfig(workspace);
    const manager1 = new WeChatManager(agentConfig, '/tmp', client1, undefined, FAST_TIMING);
    await manager1.startLinking();
    await manager1.unlink(); // stop manager1's own loop; the session file itself is wiped too —
    // so re-persist it standalone to simulate "gateway restarted with a session file already on disk".
    fs.mkdirSync(path.join(workspace, '.wechat-state'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.wechat-state', 'session.json'),
      JSON.stringify({ credentials: CREDS, contextTokens: {} }),
    );

    const client2 = makeClient();
    const manager2 = new WeChatManager(agentConfig, '/tmp', client2, undefined, FAST_TIMING);
    await manager2.resumeIfLinked();

    expect(manager2.getStatus().status).toBe('linked');
    await waitUntil(() => (client2.getUpdates as jest.Mock).mock.calls.length >= 1);

    await manager2.unlink();
  });

  test('resumeIfLinked() is a no-op when the channel is disabled, even with a saved session', async () => {
    fs.mkdirSync(path.join(workspace, '.wechat-state'), { recursive: true });
    fs.writeFileSync(
      path.join(workspace, '.wechat-state', 'session.json'),
      JSON.stringify({ credentials: CREDS, contextTokens: {} }),
    );
    delete process.env.WECHAT_CHANNEL_ENABLED;

    const manager = new WeChatManager(makeAgentConfig(workspace), '/tmp', makeClient());
    await manager.resumeIfLinked();

    expect(manager.getStatus().status).toBe('unlinked');
  });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error('waitUntil() timed out');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
