/**
 * Unit tests for the WhatsApp Cloud MCP tool module
 * (mcp/tools/whatsapp-cloud/module.ts) — Phase 2 of the WhatsApp
 * feature-parity plan adds `reply_to_message_id` (quote) and `message_id`
 * (clear the ⏳ ack the webhook left on the inbound message).
 *
 * Unlike the Baileys module, this one talks to Meta directly, so the seam to
 * mock is the compiled client it imports from dist/ (mcp/** may never import
 * src/ — see tests/unit/mcp-no-src-imports.test.ts).
 */
const sendText = jest.fn(async () => ({ messages: [{ id: 'wamid.out' }] }) as Record<string, unknown>);
const removeReaction = jest.fn(async () => undefined);

jest.mock(
  '../../dist/api/whatsapp-cloud-client.js',
  () => ({
    WhatsAppCloudClient: jest.fn().mockImplementation(() => ({
      sendText,
      removeReaction,
      uploadMedia: jest.fn(),
      sendImage: jest.fn(),
      sendDocument: jest.fn(),
    })),
  }),
  { virtual: true },
);

import { WhatsAppCloudModule } from '../../mcp/tools/whatsapp-cloud/module';

/** `sendText` declares no parameters on the mock, so read args loosely. */
const sendTextCalls = (): unknown[][] => (sendText as unknown as { mock: { calls: unknown[][] } }).mock.calls;
const removeReactionCalls = (): unknown[][] =>
  (removeReaction as unknown as { mock: { calls: unknown[][] } }).mock.calls;

describe('WhatsAppCloudModule — Phase 2 params', () => {
  const restore: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    'GATEWAY_ORIGIN_CHANNEL',
    'WHATSAPP_CLOUD_ACCESS_TOKEN',
    'WHATSAPP_CLOUD_PHONE_NUMBER_ID',
    'WHATSAPP_CLOUD_REACTION_LEVEL',
  ];

  beforeEach(() => {
    for (const k of ENV_KEYS) restore[k] = process.env[k];
    process.env.WHATSAPP_CLOUD_ACCESS_TOKEN = 'test-token';
    process.env.WHATSAPP_CLOUD_PHONE_NUMBER_ID = '1234567890';
    delete process.env.WHATSAPP_CLOUD_REACTION_LEVEL;
    sendText.mockClear();
    removeReaction.mockClear();
    sendText.mockResolvedValue({ messages: [{ id: 'wamid.out' }] });
  });

  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (restore[k] === undefined) delete process.env[k];
      else process.env[k] = restore[k];
    }
  });

  /** Both ack-clears are fired-and-forgotten — give the microtask queue a turn. */
  async function settle(): Promise<void> {
    await new Promise((r) => setImmediate(r));
  }

  test('getTools() advertises the two new optional params, still requiring only chat_id', () => {
    const tools = new WhatsAppCloudModule().getTools();
    expect(tools.map((t) => t.name)).toEqual(['whatsapp_cloud_reply']);
    const schema = tools[0].inputSchema as { required: string[]; properties: Record<string, unknown> };
    expect(schema.required).toEqual(['chat_id']);
    expect(Object.keys(schema.properties)).toEqual(
      expect.arrayContaining(['reply_to_message_id', 'message_id']),
    );
  });

  test('reply_to_message_id is passed to sendText as the quote target', async () => {
    const res = await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'answering that',
      reply_to_message_id: 'wamid.inbound',
    });
    expect(res.isError).toBeFalsy();
    expect(sendTextCalls()[0]).toEqual(['66812345678', 'answering that', 'wamid.inbound']);
  });

  test('no reply_to_message_id → sendText gets undefined, i.e. the pre-Phase-2 call', async () => {
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
    });
    expect(sendTextCalls()[0]).toEqual(['66812345678', 'hi', undefined]);
  });

  test('message_id clears the ⏳ ack after a successful send', async () => {
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(removeReactionCalls()[0]).toEqual(['66812345678', 'wamid.inbound']);
  });

  test('a FAILED send never clears the ack — the ⏳ stays until something is actually delivered', async () => {
    sendText.mockResolvedValue({ error: { message: 'rate limited', code: 131056 } });
    const res = await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(res.isError).toBe(true);
    expect(removeReaction).not.toHaveBeenCalled();
  });

  test("WHATSAPP_CLOUD_REACTION_LEVEL=off → nothing to clear, so no reaction call is made", async () => {
    process.env.WHATSAPP_CLOUD_REACTION_LEVEL = 'off';
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  test('no message_id → no reaction call (nothing was acked to clear)', async () => {
    await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
    });
    await settle();
    expect(removeReaction).not.toHaveBeenCalled();
  });

  test('best-effort: a rejected removeReaction never turns a delivered reply into an error', async () => {
    removeReaction.mockRejectedValueOnce(new Error('reaction gone'));
    const res = await new WhatsAppCloudModule().handleTool('whatsapp_cloud_reply', {
      chat_id: '66812345678',
      text: 'hi',
      message_id: 'wamid.inbound',
    });
    await settle();
    expect(res.isError).toBeFalsy();
    expect(res.content[0].text).toMatch(/Sent message to WhatsApp/);
  });
});
