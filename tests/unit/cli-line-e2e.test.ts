import { createHmac } from 'crypto';
import { createLineWebhookHandler } from '../../src/api/line-webhook-router';
import { cliPairingStore } from '../../src/cli-viewer/pairing-store';
import type { AgentRunner } from '../../src/agent/runner';

/**
 * LINE `/cli` end-to-end (mocked): drive the REAL webhook handler (`handlePost`)
 * with signed events. A `/cli` DM must reply with a buttons template carrying an
 * open-viewer URI action + Approve/Deny postback actions; a `cli_approve`
 * postback must flip the real pairing to approved. `validateSignature` stays
 * real (a valid HMAC is computed here); only the outbound client is captured.
 */

const mockReplyCalls: Array<{ replyToken?: string; messages?: unknown[] }> = [];
jest.mock('@line/bot-sdk', () => {
  const actual = jest.requireActual('@line/bot-sdk');
  class MockMessagingApiClient {
    constructor(_opts: unknown) {}
    async replyMessage(arg: { replyToken?: string; messages?: unknown[] }) { mockReplyCalls.push(arg); return {}; }
    async pushMessage() { return {}; }
    async showLoadingAnimation() { return {}; }
    async getProfile() { return { displayName: 'x' }; }
  }
  class MockBlobClient { constructor(_opts: unknown) {} }
  return {
    ...actual,
    messagingApi: {
      ...actual.messagingApi,
      MessagingApiClient: MockMessagingApiClient,
      MessagingApiBlobClient: MockBlobClient,
    },
  };
});

const AGENT = 'line-agent';
const SECRET = 'test-channel-secret';
const USER = 'U-line-1';

function fakeRunner(): AgentRunner {
  return {
    getAgentConfig: () => ({
      id: AGENT,
      line: { channelSecret: SECRET, channelAccessToken: 'tok', dmPolicy: 'open' },
    }),
    getGatewayPublicUrl: () => undefined,
    getCallbackPort: () => 0,
    createCliPairing: (channel: 'telegram' | 'discord' | 'line', userId: string) => {
      const { pairingId, code } = cliPairingStore.create(AGENT, channel, userId);
      return { pairingId, code, url: `https://host.example/cli/${pairingId}` };
    },
    approveCliPairing: (channel: 'telegram' | 'discord' | 'line', pairingId: string, userId: string, deny = false) =>
      deny ? cliPairingStore.deny(pairingId, channel, userId) : cliPairingStore.approve(pairingId, channel, userId),
  } as unknown as AgentRunner;
}

function makeRes() {
  const res = { status: jest.fn(), json: jest.fn() };
  res.status.mockReturnValue(res as never);
  res.json.mockReturnValue(res as never);
  return res;
}

function post(handler: ReturnType<typeof createLineWebhookHandler>, events: unknown[]) {
  const buf = Buffer.from(JSON.stringify({ events }));
  const sig = createHmac('sha256', SECRET).update(buf).digest('base64');
  const req = {
    params: { agentId: AGENT },
    header: (h: string) => (h.toLowerCase() === 'x-line-signature' ? sig : undefined),
    headers: {},
    body: buf,
  };
  return handler.handlePost(req as never, makeRes() as never);
}

describe('LINE /cli end-to-end (mocked client)', () => {
  let handler: ReturnType<typeof createLineWebhookHandler>;

  beforeEach(() => {
    mockReplyCalls.length = 0;
    const agents = new Map<string, AgentRunner>([[AGENT, fakeRunner()]]);
    handler = createLineWebhookHandler(agents, '/tmp');
  });

  it('/cli replies with a buttons template (open URI + approve/deny postback)', async () => {
    await post(handler, [{
      type: 'message',
      mode: 'active',
      timestamp: 1,
      source: { type: 'user', userId: USER },
      replyToken: 'rt-1',
      message: { id: '1', type: 'text', text: '/cli' },
    }]);

    expect(mockReplyCalls).toHaveLength(1);
    const tmpl = (mockReplyCalls[0].messages as Array<{ type: string; template: { actions: Array<Record<string, string>> } }>)[0];
    expect(tmpl.type).toBe('template');
    const actions = tmpl.template.actions;
    const uri = actions.find((a) => a['type'] === 'uri');
    const approve = actions.find((a) => a['type'] === 'postback' && a['data'].includes('cli_approve'));
    const deny = actions.find((a) => a['type'] === 'postback' && a['data'].includes('cli_deny'));
    expect(String(uri!['uri'])).toMatch(/^https:\/\/host\.example\/cli\/[0-9a-f]{36}$/);
    expect(approve).toBeTruthy();
    expect(deny).toBeTruthy();

    // The pairing exists and is pending until approved.
    const pairingId = String(uri!['uri']).split('/cli/')[1];
    expect(cliPairingStore.get(pairingId)?.status).toBe('pending');
  });

  it('a cli_approve postback flips the real pairing to approved', async () => {
    // Mint a pairing for this user first (as /cli would).
    const { pairingId } = cliPairingStore.create(AGENT, 'line', USER);

    await post(handler, [{
      type: 'postback',
      mode: 'active',
      timestamp: 2,
      source: { type: 'user', userId: USER },
      replyToken: 'rt-2',
      postback: { data: JSON.stringify({ action: 'cli_approve', pairing_id: pairingId }) },
    }]);

    expect(cliPairingStore.get(pairingId)?.status).toBe('approved');
    expect(mockReplyCalls).toHaveLength(1);
  });

  it('a cli_deny postback marks the pairing denied', async () => {
    const { pairingId } = cliPairingStore.create(AGENT, 'line', USER);
    await post(handler, [{
      type: 'postback',
      mode: 'active',
      timestamp: 3,
      source: { type: 'user', userId: USER },
      replyToken: 'rt-3',
      postback: { data: JSON.stringify({ action: 'cli_deny', pairing_id: pairingId }) },
    }]);
    expect(cliPairingStore.get(pairingId)?.status).toBe('denied');
  });

  it('rejects a request with a bad signature (401)', async () => {
    const buf = Buffer.from(JSON.stringify({ events: [] }));
    const req = { params: { agentId: AGENT }, header: () => 'wrong-sig', body: buf };
    const res = makeRes();
    await handler.handlePost(req as never, res as never);
    expect(res.status).toHaveBeenCalledWith(401);
  });
});
